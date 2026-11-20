import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, q, clock, wallet, at, book, MIN, T0, reconcile, runSchedulerOnce } from './helpers.js';

const { armLedgerFault } = await import('../src/services/ledger.js');

let ctx, renter, comp, comp2, admin;
before(async () => {
  ctx = await setup({ renterBalance: 5_000_000 });
  renter = await login(ctx.base, 'renter@test.vn');
  comp = await login(ctx.base, 'comp@test.vn');
  comp2 = await login(ctx.base, 'comp2@test.vn');
  admin = await login(ctx.base, 'admin@test.vn');
});
after(() => ctx.close());

async function pending(h, c = ctx.companion, day = 10) {
  clock.freeze(T0);
  const r = await book(renter, c.id, at(h, day), 1);
  assert.equal(r.data.booking.status, 'PENDING_COMPANION');
  return r.data.booking;
}
async function accepted(h, day = 10) {
  const b = await pending(h, ctx.companion, day);
  const r = await comp.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' });
  assert.equal(r.status, 200);
  return r.data.booking;
}

test('RS-01 Companion chấp nhận trong hạn; chấp nhận lặp lại trả kết quả cũ', async () => {
  const b = await pending(9);
  clock.freeze(T0 + 180_000); // đúng 180 giây vẫn hợp lệ
  const r1 = await comp.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' });
  assert.equal(r1.data.booking.status, 'ACCEPTED');
  const r2 = await comp.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.duplicate, true);
  // Reject sau khi đã accept bị chặn
  assert.equal((await comp.post(`/bookings/${b.id}/respond`, { decision: 'REJECT' })).status, 409);
});

test('RS-02 Companion từ chối → hoàn 100% một bút toán, đơn Đã hủy, slot mở lại', async () => {
  const w0 = wallet(ctx.renter.id);
  const b = await pending(10);
  const r = await comp.post(`/bookings/${b.id}/respond`, { decision: 'REJECT' });
  assert.equal(r.data.booking.status, 'CANCELLED');
  assert.equal(r.data.booking.cancel_reason, 'COMPANION_REJECTED');
  assert.equal(r.data.booking.escrow.status, 'REFUNDED');
  assert.deepEqual(wallet(ctx.renter.id), w0);
  assert.equal(q.get('SELECT status FROM slots WHERE companion_id=? AND start_at=?', ctx.companion.id, at(10)).status, 'AVAILABLE');
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE reference=?", `REFUND:${b.id}`).n, 1);
  // Reject lặp lại → kết quả cũ, không hoàn lần 2
  const again = await comp.post(`/bookings/${b.id}/respond`, { decision: 'REJECT' });
  assert.equal(again.data.duplicate, true);
  assert.deepEqual(wallet(ctx.renter.id), w0);
});

test('RS-03 quá 180 giây: Companion không thể accept; scheduler tự hủy, hoàn 100%, trừ 3 điểm', async () => {
  const w0 = wallet(ctx.renter.id);
  const trust0 = q.get('SELECT trust_score FROM users WHERE id=?', ctx.companion2.id).trust_score;
  const b = await pending(11, ctx.companion2);
  clock.freeze(T0 + 180_000 + 1);
  const r = await comp2.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'RESPONSE_WINDOW_CLOSED');
  runSchedulerOnce(); // phát lại sự kiện timeout không trừ điểm lần 2
  runSchedulerOnce();
  const cur = (await renter.get(`/bookings/${b.id}`)).data.booking;
  assert.equal(cur.status, 'CANCELLED');
  assert.equal(cur.cancel_reason, 'COMPANION_TIMEOUT');
  assert.deepEqual(wallet(ctx.renter.id), w0);
  assert.equal(q.get('SELECT COALESCE(SUM(points),0) s FROM trust_deductions WHERE user_id=?', ctx.companion2.id).s, 3);
  const trust1 = q.get('SELECT trust_score FROM users WHERE id=?', ctx.companion2.id).trust_score;
  assert.ok(trust1 < trust0, `điểm phải giảm (${trust0} → ${trust1})`);
  assert.equal(q.get("SELECT COUNT(*) n FROM trust_score_logs WHERE user_id=? AND event_ref=?", ctx.companion2.id, `TIMEOUT:${b.id}`).n, 1);
});

test('RS-04 race Accept vs timeout tại cùng thời điểm: chỉ một kết quả cuối', async () => {
  const b = await pending(12);
  clock.freeze(T0 + 180_000 + 1);
  const [a] = await Promise.all([comp.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' }), Promise.resolve(runSchedulerOnce())]);
  const cur = q.get('SELECT status FROM bookings WHERE id=?', b.id).status;
  assert.equal(cur, 'CANCELLED');
  assert.equal(a.status, 409);
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE booking_id=? AND type='ESCROW_REFUND'", b.id).n, 1);
});

// Hủy theo thời gian còn lại đến giờ hẹn (Hình 1C)
async function cancelAt(startH, minutesBefore) {
  const b = await accepted(startH);
  clock.freeze(at(startH) - minutesBefore * MIN);
  const preview = (await renter.get(`/bookings/${b.id}`)).data.booking.cancelPreview;
  const w0 = wallet(ctx.renter.id);
  const c0 = wallet(ctx.companion.id);
  const p0 = q.get("SELECT balance FROM ledger_accounts WHERE code='SYS:PLATFORM_REVENUE'").balance;
  const r = await renter.post(`/bookings/${b.id}/cancel`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return {
    b: r.data.booking,
    preview,
    renterGain: wallet(ctx.renter.id).AVAILABLE - w0.AVAILABLE,
    compGain: wallet(ctx.companion.id).AVAILABLE - c0.AVAILABLE,
    platformGain: q.get("SELECT balance FROM ledger_accounts WHERE code='SYS:PLATFORM_REVENUE'").balance - p0,
  };
}

test('CN-01 hủy còn đúng 30 phút → hoàn 100%', async () => {
  const r = await cancelAt(14, 30);
  assert.equal(r.preview.rule, 'FULL_REFUND');
  assert.equal(r.renterGain, 100_000);
  assert.equal(r.compGain, 0);
  assert.equal(r.b.escrow.status, 'REFUNDED');
});

test('CN-02 hủy còn 29 phút 59 giây → 70% Renter / 30% Companion (2 bút toán, 1 giao dịch)', async () => {
  const r = await cancelAt(15, 29 + 59 / 60);
  assert.equal(r.preview.rule, 'PARTIAL_70_30');
  assert.equal(r.renterGain, 70_000);
  assert.equal(r.compGain, 30_000);
  assert.equal(r.renterGain + r.compGain + r.platformGain, 100_000, 'bảo toàn tổng tiền');
  assert.equal(r.b.escrow.status, 'SPLIT');
});

test('CN-03 hủy còn đúng 10 phút → vẫn 70/30', async () => {
  const r = await cancelAt(16, 10);
  assert.equal(r.preview.rule, 'PARTIAL_70_30');
  assert.equal(r.renterGain, 70_000);
});

test('CN-04 hủy còn 9 phút → phạt 100% (DEMO_POLICY: 88% Companion / 12% nền tảng)', async () => {
  const r = await cancelAt(17, 9);
  assert.equal(r.preview.rule, 'LATE_PENALTY');
  assert.equal(r.renterGain, 0);
  assert.equal(r.compGain, 88_000);
  assert.equal(r.platformGain, 12_000);
  assert.equal(r.b.escrow.status, 'FORFEITED');
  assert.match(r.preview.note, /DEMO_POLICY/);
});

test('CN-05 đã đến giờ hẹn → không cho hủy thường (phải báo sự cố); hủy lặp không xử lý tiền 2 lần', async () => {
  const b = await accepted(18);
  clock.freeze(at(18));
  const r = await renter.post(`/bookings/${b.id}/cancel`);
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'SESSION_STARTED');
  // Hủy lặp
  const b2 = await accepted(19);
  clock.freeze(T0 + 5 * MIN);
  const w0 = wallet(ctx.renter.id).AVAILABLE;
  await renter.post(`/bookings/${b2.id}/cancel`);
  const again = await renter.post(`/bookings/${b2.id}/cancel`);
  assert.equal(again.data.duplicate, true);
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0 + 100_000);
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE reference=?", `CANCEL:${b2.id}`).n, 1);
});

test('CN-06 hủy khi chưa ký quỹ / khi chờ Companion → hoàn 100%', async () => {
  const b = await pending(20);
  const w0 = wallet(ctx.renter.id).AVAILABLE;
  const r = await renter.post(`/bookings/${b.id}/cancel`);
  assert.equal(r.data.booking.status, 'CANCELLED');
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0 + 100_000);
});

test('FL-01 lỗi ghi sổ khi hoàn tiền (Companion từ chối) → giữ nguyên Escrow & đơn chờ; cảnh báo; Admin thử lại thành công', async () => {
  const b = await pending(21);
  const w0 = wallet(ctx.renter.id);
  armLedgerFault(true);
  const r = await comp.post(`/bookings/${b.id}/respond`, { decision: 'REJECT' });
  assert.equal(r.status, 500);
  assert.equal(r.data.error.code, 'LEDGER_POSTING_FAILED');
  assert.ok(r.data.error.alertId);
  const cur = q.get('SELECT * FROM bookings WHERE id=?', b.id);
  assert.equal(cur.status, 'PENDING_COMPANION', 'đơn vẫn ở trạng thái chờ');
  assert.equal(q.get('SELECT status FROM escrows WHERE booking_id=?', b.id).status, 'HELD');
  assert.deepEqual(wallet(ctx.renter.id), w0);
  assert.equal(reconcile().ok, true, 'không có trạng thái nửa vời');
  const retry = await admin.post(`/admin/alerts/${r.data.error.alertId}/retry`);
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'CANCELLED');
  assert.equal(wallet(ctx.renter.id).AVAILABLE, w0.AVAILABLE + 100_000);
  assert.equal(q.get('SELECT status FROM ops_alerts WHERE id=?', r.data.error.alertId).status, 'RESOLVED');
  assert.equal(reconcile().ok, true);
});

test('FL-02 lỗi ghi sổ khi ký quỹ → không tạo Escrow, số dư nguyên vẹn, đơn vẫn giữ chỗ', async () => {
  clock.freeze(T0);
  const w0 = wallet(ctx.renter.id);
  armLedgerFault(true);
  const r = await book(renter, ctx.companion.id, at(22), 1);
  assert.equal(r.status, 201);
  assert.equal(r.data.escrow.escrowed, false);
  assert.equal(r.data.escrow.reason, 'LEDGER_POSTING_FAILED');
  assert.equal(r.data.booking.status, 'AWAITING_ESCROW');
  assert.equal(q.get('SELECT COUNT(*) n FROM escrows WHERE booking_id=?', r.data.booking.id).n, 0);
  assert.deepEqual(wallet(ctx.renter.id), w0);
  const again = await renter.post(`/bookings/${r.data.booking.id}/escrow`);
  assert.equal(again.data.booking.status, 'PENDING_COMPANION');
  assert.equal(reconcile().ok, true);
});
