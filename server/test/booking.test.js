import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, q, clock, wallet, at, key, book, topup, MIN, T0, reconcile, runSchedulerOnce, signCallback } from './helpers.js';

let ctx, renter, renter2, comp, admin;
before(async () => {
  ctx = await setup();
  renter = await login(ctx.base, 'renter@test.vn');
  renter2 = await login(ctx.base, 'renter2@test.vn');
  comp = await login(ctx.base, 'comp@test.vn');
  admin = await login(ctx.base, 'admin@test.vn');
});
after(() => ctx.close());

test('BK-01 đặt lịch thành công: giữ chỗ → ký quỹ → chờ Companion 180s; slot BOOKED; ledger cân bằng', async () => {
  const w0 = wallet(ctx.renter.id);
  const r = await book(renter, ctx.companion.id, at(9), 2);
  assert.equal(r.status, 201);
  const b = r.data.booking;
  assert.equal(b.status, 'PENDING_COMPANION');
  assert.equal(b.total_fee_snapshot, 200_000);
  assert.equal(b.respond_deadline, T0 + 180_000);
  assert.equal(r.data.escrow.escrowed, true);
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0.AVAILABLE - 200_000);
  assert.equal(wallet(ctx.renter.id).ESCROW, 200_000);
  assert.equal(q.get("SELECT COUNT(*) n FROM slots WHERE booking_id=? AND status='BOOKED'", b.id).n, 2);
  assert.deepEqual(
    b.history.map((h) => h.to_status),
    ['AWAITING_ESCROW', 'PENDING_COMPANION'],
  );
  assert.equal(reconcile().ok, true);
});

test('BK-02 gửi lặp cùng request_key → trả về đơn cũ, không tạo thêm đơn/giữ chỗ/ký quỹ', async () => {
  const k = key();
  const body = { companionId: ctx.companion.id, gameId: 1, startAt: at(12), hours: 1, requestKey: k };
  const a = await renter.post('/bookings', body);
  const n = q.get('SELECT COUNT(*) n FROM ledger_transactions').n;
  const b = await renter.post('/bookings', body);
  const c = await renter.post('/bookings', { ...body, requestKey: undefined }, { 'Idempotency-Key': k });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal(c.data.booking.id, a.data.booking.id);
  assert.equal(q.get('SELECT COUNT(*) n FROM bookings WHERE request_key=?', k).n, 1);
  assert.equal(q.get('SELECT COUNT(*) n FROM ledger_transactions').n, n, 'không phát sinh bút toán mới');
});

test('BK-03 cùng request_key nhưng payload khác → 409 IDEMPOTENCY_KEY_REUSED', async () => {
  const k = key();
  await renter.post('/bookings', { companionId: ctx.companion.id, gameId: 1, startAt: at(13), hours: 1, requestKey: k });
  const r = await renter.post('/bookings', { companionId: ctx.companion.id, gameId: 1, startAt: at(14), hours: 1, requestKey: k });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('BK-04 hai Renter đặt cùng slot đồng thời (20 request song song) → đúng 1 thành công', async () => {
  const reqs = [];
  for (let i = 0; i < 20; i++) reqs.push(book(i % 2 ? renter2 : renter, ctx.companion2.id, at(15), 1));
  const res = await Promise.all(reqs);
  const ok = res.filter((r) => r.status === 201);
  const conflict = res.filter((r) => r.status === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflict.length, 19);
  assert.ok(conflict.every((r) => r.data.error.code === 'SLOT_UNAVAILABLE'));
  assert.equal(q.get('SELECT COUNT(*) n FROM bookings WHERE companion_id=? AND start_at=?', ctx.companion2.id, at(15)).n, 1);
  assert.equal(reconcile().ok, true);
});

test('BK-05 chồng lấn một phần (đơn 2 giờ trùng 1 giờ đã đặt) bị chặn', async () => {
  const r = await book(renter2, ctx.companion.id, at(10), 2); // 10–12, nhưng 10 đã thuộc đơn BK-01 (9–11)
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'SLOT_UNAVAILABLE');
});

test('BK-06 phí được chốt (snapshot): Companion đổi giá sau đó không đổi giá đơn cũ', async () => {
  const r = await book(renter, ctx.companion2.id, at(16), 1);
  assert.equal(r.data.booking.total_fee_snapshot, 100_000);
  const c2 = await login(ctx.base, 'comp2@test.vn');
  assert.equal((await c2.put('/me/companion/profile', { hourlyRate: 250_000 })).status, 200);
  const again = await renter.get(`/bookings/${r.data.booking.id}`);
  assert.equal(again.data.booking.total_fee_snapshot, 100_000);
  assert.equal(again.data.booking.hourly_rate_snapshot, 100_000);
  await c2.put('/me/companion/profile', { hourlyRate: 100_000 });
});

test('BK-07 giới hạn 10 giờ/ngày/Companion', async () => {
  // companion2 đã có 15h, 16h (2 giờ). Đặt thêm 5 + 3 = 10 giờ → OK; thêm 1 giờ nữa → vượt.
  topup(ctx.renter2.id, 2_000_000);
  assert.equal((await book(renter2, ctx.companion2.id, at(9), 5)).status, 201);
  assert.equal((await book(renter2, ctx.companion2.id, at(17), 3)).status, 201);
  const r = await book(renter2, ctx.companion2.id, at(20), 1);
  assert.equal(r.status, 422);
  assert.equal(r.data.error.code, 'DAILY_LIMIT_EXCEEDED');
  // Ngày khác vẫn được
  assert.equal((await book(renter2, ctx.companion2.id, at(8, 11), 1)).status, 201);
});

test('BK-08 validation: số giờ, slot đã qua, slot không thẳng hàng, game không cung cấp', async () => {
  assert.equal((await book(renter, ctx.companion.id, at(18), 0)).data.error.code, 'INVALID_HOURS');
  assert.equal((await book(renter, ctx.companion.id, at(18), 6)).data.error.code, 'INVALID_HOURS');
  assert.equal((await book(renter, ctx.companion.id, T0 - 3600_000, 1)).data.error.code, 'SLOT_IN_PAST');
  assert.equal((await book(renter, ctx.companion.id, at(18) + 60_000, 1)).data.error.code, 'INVALID_SLOT');
  assert.equal((await book(renter, ctx.companion.id, at(18), 1, { gameId: 2 })).data.error.code, 'GAME_NOT_OFFERED');
  assert.equal((await renter.post('/bookings', { companionId: 'x' })).data.error.code, 'VALIDATION_ERROR');
});

test('BK-09 thiếu số dư → giữ chỗ chờ nạp; nạp (gắn đơn) thành công → tự ký quỹ', async () => {
  const poor = await (async () => {
    const { createUser } = await import('../src/services/users.js');
    createUser({ email: 'poor@test.vn', password: 'Test@1234', displayName: 'Poor', role: 'RENTER' });
    return login(ctx.base, 'poor@test.vn');
  })();
  const r = await book(poor, ctx.companion.id, at(18), 1);
  assert.equal(r.status, 201);
  assert.equal(r.data.booking.status, 'AWAITING_ESCROW');
  assert.equal(r.data.escrow.reason, 'INSUFFICIENT_BALANCE');
  assert.equal(r.data.escrow.details.shortfall, 100_000);
  const t = await poor.post('/payments/topup', { amount: 100_000, method: 'MOMO_MOCK', idempotencyKey: key(), bookingId: r.data.booking.id });
  assert.equal(t.status, 201);
  const done = await poor.post(`/payments/sim/${t.data.payment.gateway_txn_id}/complete`, { outcome: 'SUCCESS' });
  assert.equal(done.data.results[0].followUp.escrowed, true);
  assert.equal((await poor.get(`/bookings/${r.data.booking.id}`)).data.booking.status, 'PENDING_COMPANION');
  assert.equal(reconcile().ok, true);
});

test('BK-10 nạp xong vẫn thiếu → vẫn chờ; hết thời gian giữ chỗ → EXPIRED, slot mở lại, không phát sinh tiền', async () => {
  const { createUser } = await import('../src/services/users.js');
  createUser({ email: 'poor2@test.vn', password: 'Test@1234', displayName: 'Poor2', role: 'RENTER' });
  const poor = await login(ctx.base, 'poor2@test.vn');
  const r = await book(poor, ctx.companion.id, at(19), 1);
  const t = await poor.post('/payments/topup', { amount: 30_000, method: 'VNPAY_MOCK', idempotencyKey: key(), bookingId: r.data.booking.id });
  const done = await poor.post(`/payments/sim/${t.data.payment.gateway_txn_id}/complete`, { outcome: 'SUCCESS' });
  assert.equal(done.data.results[0].followUp.escrowed, false);
  assert.equal(done.data.results[0].followUp.reason, 'INSUFFICIENT_BALANCE');
  clock.freeze(T0 + 10 * MIN + 1);
  runSchedulerOnce();
  const b = (await poor.get(`/bookings/${r.data.booking.id}`)).data.booking;
  assert.equal(b.status, 'EXPIRED');
  assert.equal(q.get('SELECT status FROM slots WHERE companion_id=? AND start_at=?', ctx.companion.id, at(19)).status, 'AVAILABLE');
  assert.equal(wallet(q.get("SELECT id FROM users WHERE email='poor2@test.vn'").id).AVAILABLE, 30_000, 'tiền nạp vẫn ở ví, không bị giữ');
  // Ký quỹ sau khi hết hạn bị từ chối
  assert.equal((await poor.post(`/bookings/${r.data.booking.id}/escrow`)).status, 409);
  clock.freeze(T0);
});

test('BK-11 nạp tiền gắn đơn thất bại → hủy đơn, mở lại slot (Hình 1A bước 9b)', async () => {
  const { createUser } = await import('../src/services/users.js');
  createUser({ email: 'poor3@test.vn', password: 'Test@1234', displayName: 'Poor3', role: 'RENTER' });
  const poor = await login(ctx.base, 'poor3@test.vn');
  const r = await book(poor, ctx.companion.id, at(20), 1);
  const t = await poor.post('/payments/topup', { amount: 100_000, method: 'VNPAY_MOCK', idempotencyKey: key(), bookingId: r.data.booking.id });
  await poor.post(`/payments/sim/${t.data.payment.gateway_txn_id}/complete`, { outcome: 'FAILED' });
  const b = (await poor.get(`/bookings/${r.data.booking.id}`)).data.booking;
  assert.equal(b.status, 'CANCELLED');
  assert.equal(b.cancel_reason, 'PAYMENT_FAILED');
  assert.equal(q.get('SELECT status FROM slots WHERE companion_id=? AND start_at=?', ctx.companion.id, at(20)).status, 'AVAILABLE');
});

test('BK-12 race: hết hạn giữ chỗ đúng lúc người khác đặt → người sau đặt được, đơn cũ EXPIRED', async () => {
  const { createUser } = await import('../src/services/users.js');
  createUser({ email: 'poor4@test.vn', password: 'Test@1234', displayName: 'Poor4', role: 'RENTER' });
  const poor = await login(ctx.base, 'poor4@test.vn');
  const r1 = await book(poor, ctx.companion.id, at(21), 1);
  assert.equal(r1.data.booking.status, 'AWAITING_ESCROW');
  assert.equal((await book(renter, ctx.companion.id, at(21), 1)).status, 409, 'đang giữ chỗ thì người khác không đặt được');
  clock.freeze(T0 + 10 * MIN); // đúng hạn held_until
  const r2 = await book(renter, ctx.companion.id, at(21), 1);
  assert.equal(r2.status, 201);
  assert.equal((await poor.get(`/bookings/${r1.data.booking.id}`)).data.booking.status, 'EXPIRED');
  clock.freeze(T0);
  assert.equal(reconcile().ok, true);
});

test('BK-13 Companion chưa eKYC / tạm ngưng nhận đơn không đặt được', async () => {
  q.run("UPDATE companion_profiles SET accepting=0 WHERE user_id=?", ctx.companion2.id);
  const r = await book(renter, ctx.companion2.id, at(10, 11), 1);
  assert.equal(r.data.error.code, 'COMPANION_UNAVAILABLE');
  q.run("UPDATE companion_profiles SET accepting=1 WHERE user_id=?", ctx.companion2.id);
});

test('PAY-01 callback SUCCESS gửi lặp 3 lần → chỉ cộng ví 1 lần', async () => {
  const w0 = wallet(ctx.renter.id).AVAILABLE;
  const t = await renter.post('/payments/topup', { amount: 50_000, method: 'VNPAY_MOCK', idempotencyKey: key() });
  const r = await renter.post(`/payments/sim/${t.data.payment.gateway_txn_id}/complete`, { outcome: 'SUCCESS', times: 3 });
  assert.deepEqual(r.data.results.map((x) => x.outcome), ['CREDITED', 'DUPLICATE_IGNORED', 'DUPLICATE_IGNORED']);
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0 + 50_000);
  // Gửi FAILED sau SUCCESS cũng bị bỏ qua
  const f = await renter.post(`/payments/sim/${t.data.payment.gateway_txn_id}/complete`, { outcome: 'FAILED' });
  assert.equal(f.data.results[0].outcome, 'DUPLICATE_IGNORED');
  assert.equal(f.data.payment.status, 'SUCCESS');
});

test('PAY-02 tạo topup lặp cùng idempotency key → cùng payment', async () => {
  const k = key();
  const a = await renter.post('/payments/topup', { amount: 20_000, method: 'VNPAY_MOCK', idempotencyKey: k });
  const b = await renter.post('/payments/topup', { amount: 20_000, method: 'VNPAY_MOCK', idempotencyKey: k });
  assert.equal(a.data.payment.id, b.data.payment.id);
  assert.equal(b.data.duplicate, true);
  const c = await renter.post('/payments/topup', { amount: 99_000, method: 'VNPAY_MOCK', idempotencyKey: k });
  assert.equal(c.status, 409);
});

test('PAY-03 callback sai chữ ký / sai số tiền bị từ chối, không cộng tiền', async () => {
  const w0 = wallet(ctx.renter.id).AVAILABLE;
  const t = await renter.post('/payments/topup', { amount: 70_000, method: 'VNPAY_MOCK', idempotencyKey: key() });
  const gtx = t.data.payment.gateway_txn_id;
  const bad = await fetch(`${ctx.base}/api/payments/gateway/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gatewayTxnId: gtx, status: 'SUCCESS', amount: 70_000, signature: 'ab'.repeat(32) }),
  });
  assert.equal(bad.status, 400);
  const wrongAmt = { gatewayTxnId: gtx, status: 'SUCCESS', amount: 7_000_000 };
  const bad2 = await fetch(`${ctx.base}/api/payments/gateway/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...wrongAmt, signature: signCallback(wrongAmt) }),
  });
  assert.equal(bad2.status, 400);
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0);
  // Callback hợp lệ qua endpoint công khai thì được xử lý
  const good = { gatewayTxnId: gtx, status: 'SUCCESS', amount: 70_000 };
  const ok = await fetch(`${ctx.base}/api/payments/gateway/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...good, signature: signCallback(good) }) });
  assert.equal(ok.status, 200);
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0 + 70_000);
});

test('PAY-04 PENDING không được tính là thành công; quá 15 phút → EXPIRED', async () => {
  const w0 = wallet(ctx.renter.id).AVAILABLE;
  const t = await renter.post('/payments/topup', { amount: 40_000, method: 'MOMO_MOCK', idempotencyKey: key() });
  const p = await renter.post(`/payments/sim/${t.data.payment.gateway_txn_id}/complete`, { outcome: 'PENDING' });
  assert.equal(p.data.results[0].outcome, 'STILL_PENDING');
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0);
  clock.freeze(T0 + 16 * MIN);
  runSchedulerOnce();
  assert.equal(q.get('SELECT status FROM payments WHERE id=?', t.data.payment.id).status, 'EXPIRED');
  clock.freeze(T0);
  assert.equal(reconcile().ok, true);
});

test('PAY-05 số tiền nạp không hợp lệ (lẻ, quá nhỏ) bị từ chối', async () => {
  assert.equal((await renter.post('/payments/topup', { amount: 10000.5, method: 'VNPAY_MOCK', idempotencyKey: key() })).status, 400);
  assert.equal((await renter.post('/payments/topup', { amount: 500, method: 'VNPAY_MOCK', idempotencyKey: key() })).data.error.code, 'INVALID_AMOUNT');
});
