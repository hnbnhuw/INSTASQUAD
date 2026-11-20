import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, q, clock, wallet, at, book, HOUR, T0, reconcile, runSchedulerOnce, key } from './helpers.js';

let ctx, renter, renter2, comp, comp2, cs, admin;
before(async () => {
  ctx = await setup({ renterBalance: 5_000_000 });
  renter = await login(ctx.base, 'renter@test.vn');
  renter2 = await login(ctx.base, 'renter2@test.vn');
  comp = await login(ctx.base, 'comp@test.vn');
  comp2 = await login(ctx.base, 'comp2@test.vn');
  cs = await login(ctx.base, 'cs@test.vn');
  admin = await login(ctx.base, 'admin@test.vn');
});
after(() => ctx.close());

async function completed(h) {
  clock.freeze(T0);
  const b = (await book(renter, ctx.companion.id, at(h), 1)).data.booking;
  await comp.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' });
  clock.freeze(at(h) + HOUR);
  runSchedulerOnce();
  await renter.post(`/bookings/${b.id}/confirm`);
  return b;
}

let done;
test('RV-01 chỉ đánh giá được sau khi hoàn tất; mỗi người 1 lần; người ngoài không được', async () => {
  clock.freeze(T0);
  const early = (await book(renter, ctx.companion.id, at(20), 1)).data.booking;
  assert.equal((await renter.post(`/bookings/${early.id}/review`, { rating: 5 })).data.error.code, 'NOT_REVIEWABLE');
  done = await completed(9);
  const c0 = wallet(ctx.companion.id);
  const r = await renter.post(`/bookings/${done.id}/review`, { rating: 4, comment: 'Tốt' });
  assert.equal(r.status, 201);
  assert.equal((await renter.post(`/bookings/${done.id}/review`, { rating: 1 })).data.error.code, 'ALREADY_REVIEWED');
  assert.equal((await renter2.post(`/bookings/${done.id}/review`, { rating: 1 })).status, 403);
  assert.equal((await comp.post(`/bookings/${done.id}/review`, { rating: 5 })).status, 201, 'đánh giá hai chiều');
  assert.equal((await renter.post(`/bookings/${done.id}/review`, { rating: 9 })).status, 400);
  assert.deepEqual(wallet(ctx.companion.id), c0, 'đánh giá không thay đổi quyết toán tiền');
});

test('TS-01 TrustScore cập nhật theo công thức sau đánh giá, có log điểm cũ/mới/đầu vào; phát lại sự kiện không tính 2 lần', async () => {
  const { recalcTrust, trustInputs, computeTrust } = await import('../src/services/trust.js');
  const logs = q.all('SELECT * FROM trust_score_logs WHERE user_id=? ORDER BY id', ctx.companion.id);
  const last = logs.at(-1);
  const inputs = JSON.parse(last.inputs);
  // 1 đánh giá 4★ → 80; 1 hoàn tất + 1 quá hạn 180s (đơn "early"): (1+10)/(1+1+10) = 91,67%; trừ trực tiếp 3
  // ⇒ 0.4×80 + 0.4×91,67 − 1.2×0 − 3 = 65,67 → 66
  assert.equal(inputs.rating100, 80);
  assert.equal(inputs.completed, 1);
  assert.equal(inputs.failed, 1);
  assert.equal(inputs.deductions, 3);
  assert.equal(last.new_score, 66);
  assert.equal(q.get('SELECT trust_score FROM users WHERE id=?', ctx.companion.id).trust_score, computeTrust(trustInputs(ctx.companion.id)));
  const n = q.get('SELECT COUNT(*) n FROM trust_score_logs').n;
  recalcTrust(ctx.companion.id, last.event_ref, 'replay');
  assert.equal(q.get('SELECT COUNT(*) n FROM trust_score_logs').n, n);
});

test('TS-02 điểm < 40 → hồ sơ Companion tạm khóa, ẩn khỏi tìm kiếm, không nhận đơn', async () => {
  const { addDeduction, recalcTrust } = await import('../src/services/trust.js');
  addDeduction(ctx.companion2.id, 'manual-test', 50, 'test');
  const s = recalcTrust(ctx.companion2.id, 'manual-test', 'test');
  assert.ok(s < 40);
  assert.equal(q.get('SELECT status FROM companion_profiles WHERE user_id=?', ctx.companion2.id).status, 'SUSPENDED');
  const list = (await renter.get('/companions')).data.companions;
  assert.ok(!list.some((c) => c.id === ctx.companion2.id));
  clock.freeze(T0);
  assert.equal((await book(renter, ctx.companion2.id, at(10), 1)).data.error.code, 'COMPANION_UNAVAILABLE');
});

test('WD-01 rút tiền: vượt số dư bị chặn; tạo yêu cầu giữ tiền; lặp key trả về yêu cầu cũ', async () => {
  await completed(10);
  await completed(11);
  const w0 = wallet(ctx.companion.id);
  assert.ok(w0.AVAILABLE >= 150_000);
  const over = await comp.post('/withdrawals', { amount: w0.AVAILABLE + 1, payoutCode: 'PAYOUT-ABC1', idempotencyKey: key() });
  assert.equal(over.data.error.code, 'INSUFFICIENT_BALANCE');
  assert.equal((await comp.post('/withdrawals', { amount: 60_000, payoutCode: '0123456789', idempotencyKey: key() })).data.error.code, 'INVALID_PAYOUT_CODE');
  const k = key();
  const a = await comp.post('/withdrawals', { amount: 60_000, payoutCode: 'PAYOUT-ABC1', idempotencyKey: k });
  const b = await comp.post('/withdrawals', { amount: 60_000, payoutCode: 'PAYOUT-ABC1', idempotencyKey: k });
  assert.equal(a.status, 201);
  assert.equal(b.data.duplicate, true);
  assert.equal(wallet(ctx.companion.id).AVAILABLE, w0.AVAILABLE - 60_000);
  assert.equal(wallet(ctx.companion.id).WITHDRAW_HOLD, 60_000);
  assert.equal((await renter.post('/withdrawals', { amount: 60_000, payoutCode: 'PAYOUT-ABC1', idempotencyKey: key() })).status, 403, 'Renter không rút tiền');
  assert.equal(reconcile().ok, true);
});

test('WD-02 Admin xử lý: PENDING → PROCESSING → COMPLETED; xử lý 2 lần bị chặn; Companion/CS không có quyền', async () => {
  const w = q.get("SELECT * FROM withdraw_requests WHERE status='PENDING' ORDER BY id LIMIT 1");
  assert.equal((await comp.post(`/admin/withdrawals/${w.id}/complete`)).status, 403);
  assert.equal((await cs.post(`/admin/withdrawals/${w.id}/complete`)).status, 403);
  assert.equal((await admin.post(`/admin/withdrawals/${w.id}/complete`)).status, 409, 'phải qua PROCESSING');
  assert.equal((await admin.post(`/admin/withdrawals/${w.id}/process`)).data.withdrawal.status, 'PROCESSING');
  assert.equal((await admin.post(`/admin/withdrawals/${w.id}/process`)).status, 409);
  const [c1, c2] = await Promise.all([admin.post(`/admin/withdrawals/${w.id}/complete`), admin.post(`/admin/withdrawals/${w.id}/complete`)]);
  assert.deepEqual([c1.status, c2.status].sort(), [200, 409]);
  assert.equal(wallet(ctx.companion.id).WITHDRAW_HOLD, 0);
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE reference=?", `WITHDRAW_PAYOUT:${w.id}`).n, 1);
  assert.equal((await admin.post(`/admin/withdrawals/${w.id}/reject`, { reason: 'Đã chuyển rồi' })).status, 409);
  assert.equal(reconcile().ok, true);
});

test('WD-03 từ chối rút tiền → trả lại tiền giữ bằng bút toán; lý do bắt buộc', async () => {
  const w0 = wallet(ctx.companion.id);
  const r = await comp.post('/withdrawals', { amount: 50_000, payoutCode: 'PAYOUT-ABC1', idempotencyKey: key() });
  const id = r.data.withdrawal.id;
  assert.equal((await admin.post(`/admin/withdrawals/${id}/reject`, {})).data.error.code, 'REASON_REQUIRED');
  const rej = await admin.post(`/admin/withdrawals/${id}/reject`, { reason: 'Mã nhận tiền không hợp lệ' });
  assert.equal(rej.data.withdrawal.status, 'REJECTED');
  assert.deepEqual(wallet(ctx.companion.id), w0);
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE reference=?", `WITHDRAW_RELEASE:${id}`).n, 1);
  assert.equal(reconcile().ok, true);
});

test('AZ-01 IDOR: người ngoài không xem được đơn/phòng của người khác; ví chỉ của chính mình', async () => {
  const other = await (async () => {
    const { createUser } = await import('../src/services/users.js');
    createUser({ email: 'stranger@test.vn', password: 'Test@1234', displayName: 'Stranger', role: 'RENTER' });
    return login(ctx.base, 'stranger@test.vn');
  })();
  assert.equal((await other.get(`/bookings/${done.id}`)).status, 403);
  assert.equal((await other.get(`/bookings/${done.id}/room`)).status, 403);
  assert.equal((await comp2.get(`/bookings/${done.id}`)).status, 403);
  const w = await other.get('/wallet');
  assert.equal(w.data.wallet.available, 0);
  assert.equal((await cs.get(`/bookings/${done.id}`)).status, 200, 'CS được xem đơn để hỗ trợ');
});

test('AZ-02 phân quyền theo vai trò: API Admin/CS, Companion profile, chưa đăng nhập', async () => {
  for (const p of ['/admin/dashboard', '/admin/reconcile', '/admin/users', '/admin/alerts', '/admin/withdrawals', '/admin/audit']) {
    assert.equal((await renter.get(p)).status, 403, p);
    assert.equal((await comp.get(p)).status, 403, p);
    assert.equal((await cs.get(p)).status, 403, `${p} chỉ dành cho Admin`);
    assert.equal((await admin.get(p)).status, 200, p);
  }
  assert.equal((await cs.get('/admin/disputes')).status, 200);
  assert.equal((await renter.put('/me/companion/profile', { hourlyRate: 1 })).status, 403);
  assert.equal((await renter.post('/bookings/1/respond', { decision: 'ACCEPT' })).status, 403);
  assert.equal((await comp.post('/bookings', {})).status, 403, 'Companion không đặt lịch');
  assert.equal((await fetch(`${ctx.base}/api/wallet`)).status, 401);
  assert.equal((await fetch(`${ctx.base}/api/bookings`)).status, 401);
  // Không có endpoint sửa số dư trực tiếp
  assert.equal((await admin.post('/admin/wallet/adjust', { amount: 1 })).status, 404);
});

test('AZ-03 dữ liệu nhạy cảm: không trả password_hash; eKYC lưu mã hóa', async () => {
  const me = await fetch(`${ctx.base}/api/auth/me`, { headers: { Cookie: '' } });
  assert.equal((await me.json()).user, null);
  const users = (await admin.get('/admin/users')).data.users;
  assert.ok(users.every((u) => !('password_hash' in u)));
  const k = await comp2.post('/auth/kyc', { fullName: 'Nguyễn Văn A', idNumber: '079200012345', dob: '2000-01-01' });
  assert.equal(k.status, 409, 'đã VERIFIED');
  const { createUser } = await import('../src/services/users.js');
  createUser({ email: 'kyc@test.vn', password: 'Test@1234', displayName: 'KYC', role: 'COMPANION' });
  const kyc = await login(ctx.base, 'kyc@test.vn');
  assert.equal((await kyc.post('/auth/kyc', { fullName: 'Nguyễn Văn B', idNumber: '079200012999', dob: '2000-01-01' })).status, 503);
  assert.equal((await kyc.post('/auth/kyc', { fullName: 'Nguyễn Văn B', idNumber: '079200012000', dob: '2000-01-01' })).data.status, 'REJECTED');
  assert.equal((await kyc.post('/auth/kyc', { fullName: 'Nguyễn Văn B', idNumber: '079200012345', dob: '2000-01-01' })).data.status, 'VERIFIED');
  const rec = q.get("SELECT * FROM kyc_records WHERE user_id=(SELECT id FROM users WHERE email='kyc@test.vn')");
  assert.doesNotMatch(rec.id_number_enc, /079200012345/);
  assert.doesNotMatch(rec.full_name_enc, /Nguyễn/);
});

test('AZ-04 CSRF: request ghi dữ liệu không phải JSON bị từ chối; đăng nhập sai báo lỗi chung', async () => {
  const r = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'JSON_REQUIRED');
  const bad = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'renter@test.vn', password: 'sai-mat-khau' }) });
  assert.equal(bad.status, 401);
  const inj = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: "' OR 1=1 --", password: 'x' }) });
  assert.equal(inj.status, 401, 'truy vấn tham số hóa, không bị SQL injection');
  const search = await renter.get(`/companions?q=${encodeURIComponent("%' OR '1'='1")}`);
  assert.equal(search.status, 200);
  assert.equal(search.data.companions.length, 0);
});

test('AZ-05 tìm kiếm/lọc: theo game, rank tối thiểu, giá, TrustScore; trả về trong ≤ 2 giây', async () => {
  q.run("UPDATE companion_profiles SET status='ACTIVE' WHERE user_id=?", ctx.companion2.id);
  q.run('UPDATE users SET trust_score=75 WHERE id=?', ctx.companion2.id);
  const all = (await renter.get('/companions?gameId=1')).data;
  assert.equal(all.companions.length, 2);
  assert.ok(all.tookMs < 2000);
  assert.equal((await renter.get('/companions?gameId=1&rank=Kim%20C%C6%B0%C6%A1ng')).data.companions.length, 0);
  assert.equal((await renter.get('/companions?gameId=2')).data.companions.length, 0);
  assert.equal((await renter.get('/companions?maxPrice=50000')).data.companions.length, 0);
  assert.equal((await renter.get('/companions?minTrust=76')).data.companions.map((c) => c.id).includes(ctx.companion2.id), false);
  const prof = await renter.get(`/companions/${ctx.companion.id}`);
  assert.equal(prof.status, 200);
  assert.ok(prof.data.companion.slots.length > 0);
  assert.ok(q.get('SELECT COUNT(*) n FROM profile_views').n >= 1);
});
