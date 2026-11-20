import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, q, clock, wallet, at, book, MIN, HOUR, T0, reconcile, runSchedulerOnce, platform } from './helpers.js';

const { armLedgerFault } = await import('../src/services/ledger.js');
const { filterChat } = await import('../src/util.js');

let ctx, renter, renter2, comp, cs, admin;
before(async () => {
  ctx = await setup({ renterBalance: 5_000_000, rate: 33_333 });
  renter = await login(ctx.base, 'renter@test.vn');
  renter2 = await login(ctx.base, 'renter2@test.vn');
  comp = await login(ctx.base, 'comp@test.vn');
  cs = await login(ctx.base, 'cs@test.vn');
  admin = await login(ctx.base, 'admin@test.vn');
});
after(() => ctx.close());

// Tạo đơn đã chấp nhận rồi chạy tới khi phiên kết thúc (chờ nghiệm thu)
async function finishedSession(h, { messages = [] } = {}) {
  clock.freeze(T0);
  const b = (await book(renter, ctx.companion.id, at(h), 1)).data.booking;
  await comp.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' });
  clock.freeze(at(h));
  runSchedulerOnce();
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'IN_SESSION');
  for (const [who, text] of messages) await (who === 'r' ? renter : comp).post(`/bookings/${b.id}/messages`, { body: text });
  clock.freeze(at(h) + HOUR);
  runSchedulerOnce();
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'AWAITING_CONFIRMATION');
  return q.get('SELECT * FROM bookings WHERE id=?', b.id);
}

test('SS-01 đến giờ hẹn mở phiên; hết thời lượng đóng phòng, hạn nghiệm thu = kết thúc + 15 phút; chỉ 1 session/booking', async () => {
  const b = await finishedSession(9);
  assert.equal(b.confirm_deadline, at(9) + HOUR + 15 * MIN);
  assert.equal(q.get('SELECT COUNT(*) n FROM play_sessions WHERE booking_id=?', b.id).n, 1);
  runSchedulerOnce();
  assert.equal(q.get('SELECT COUNT(*) n FROM play_sessions WHERE booking_id=?', b.id).n, 1);
  assert.equal(q.get('SELECT status FROM play_sessions WHERE booking_id=?', b.id).status, 'ENDED');
  // Phòng đã đóng: không gửi tin được
  const m = await renter.post(`/bookings/${b.id}/messages`, { body: 'hello' });
  assert.equal(m.data.error.code, 'ROOM_CLOSED');
});

test('ST-01 Renter nghiệm thu → giải ngân 88/12 với số tiền lẻ, bảo toàn tổng; nghiệm thu lặp không giải ngân 2 lần', async () => {
  const b = await finishedSession(10);
  const c0 = wallet(ctx.companion.id).AVAILABLE;
  const p0 = platform();
  const r = await renter.post(`/bookings/${b.id}/confirm`);
  assert.equal(r.data.booking.status, 'COMPLETED');
  const compGain = wallet(ctx.companion.id).AVAILABLE - c0;
  const platGain = platform() - p0;
  assert.equal(compGain, 29_334); // 33.333 − floor(12%) = 33.333 − 3.999
  assert.equal(platGain, 3_999);
  assert.equal(compGain + platGain, 33_333);
  const again = await renter.post(`/bookings/${b.id}/confirm`);
  assert.equal(again.data.duplicate, true);
  assert.equal(wallet(ctx.companion.id).AVAILABLE - c0, 29_334);
  assert.equal(q.get("SELECT COUNT(*) n FROM platform_revenue WHERE booking_id=?", b.id).n, 1);
  assert.equal(reconcile().ok, true);
});

test('ST-02 quá 15 phút không phản hồi → tự nghiệm thu (DEMO_POLICY), đúng 15 phút thì chưa', async () => {
  const b = await finishedSession(11);
  clock.freeze(b.confirm_deadline);
  runSchedulerOnce();
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'AWAITING_CONFIRMATION');
  clock.freeze(b.confirm_deadline + 1);
  runSchedulerOnce();
  runSchedulerOnce();
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'COMPLETED');
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE reference=?", `SETTLE:${b.id}`).n, 1);
});

test('ST-03 lỗi ghi sổ khi giải ngân → giữ Escrow HELD, đơn chờ nghiệm thu, có cảnh báo', async () => {
  const b = await finishedSession(12);
  armLedgerFault(true);
  const r = await renter.post(`/bookings/${b.id}/confirm`);
  assert.equal(r.status, 500);
  assert.equal(q.get('SELECT status FROM escrows WHERE booking_id=?', b.id).status, 'HELD');
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'AWAITING_CONFIRMATION');
  // Scheduler không tự giải ngân lại khi đang có cảnh báo mở cho SETTLE (chờ kiểm toán viên)
  clock.freeze(b.confirm_deadline + 1);
  runSchedulerOnce();
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'AWAITING_CONFIRMATION');
  assert.equal((await admin.post(`/admin/alerts/${r.data.error.alertId}/retry`)).status, 200);
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'COMPLETED');
  assert.equal(reconcile().ok, true);
});

test('CH-01 chat: chỉ hai bên gửi được khi đang trong phiên; chặn SĐT/link/số tài khoản', async () => {
  clock.freeze(T0);
  const b = (await book(renter, ctx.companion.id, at(13), 1)).data.booking;
  await comp.post(`/bookings/${b.id}/respond`, { decision: 'ACCEPT' });
  assert.equal((await renter.post(`/bookings/${b.id}/messages`, { body: 'sớm quá' })).status, 409, 'chưa tới giờ: phòng chưa mở');
  clock.freeze(at(13));
  runSchedulerOnce();
  const m = await comp.post(`/bookings/${b.id}/messages`, { body: 'Gọi mình 0912 345 678 hoặc zalo.me/abc, STK 1903 4567 8901 23' });
  assert.equal(m.status, 201);
  assert.equal(m.data.message.flagged, 1);
  assert.doesNotMatch(m.data.message.body, /0912|zalo\.me|1903/);
  assert.equal((await renter2.post(`/bookings/${b.id}/messages`, { body: 'xâm nhập' })).status, 403);
  assert.equal((await renter2.get(`/bookings/${b.id}/room`)).status, 403);
  assert.equal((await cs.get(`/bookings/${b.id}/room`)).status, 403, 'CS chỉ xem khi có khiếu nại');
  assert.deepEqual(filterChat('gg wp, hẹn 9h tối nhé'), { text: 'gg wp, hẹn 9h tối nhé', flagged: false });
});

let disputeId;
let disputedBooking;
test('DS-01 báo sự cố → đóng băng toàn bộ Escrow ngay, tạo hồ sơ kèm nhật ký chat; CS xem được chat', async () => {
  const b = await finishedSession(14, { messages: [['r', 'bạn ơi vào game chưa'], ['c', 'chờ mình chút']] });
  const w0 = wallet(ctx.renter.id);
  const r = await renter.post(`/bookings/${b.id}/dispute`, { reason: 'Companion vào trễ 40 phút', detail: 'Có ảnh chụp' });
  assert.equal(r.status, 201);
  disputeId = r.data.dispute.id;
  disputedBooking = b;
  assert.equal(r.data.booking.status, 'DISPUTED');
  assert.equal(q.get('SELECT status FROM escrows WHERE booking_id=?', b.id).status, 'FROZEN');
  assert.equal(wallet(ctx.renter.id).ESCROW, w0.ESCROW - 33_333);
  assert.equal(wallet(ctx.renter.id).FROZEN, w0.FROZEN + 33_333);
  const ev = q.all('SELECT kind, text FROM evidence WHERE dispute_id=?', disputeId);
  assert.ok(ev.some((e) => e.kind === 'CHAT_LOG' && e.text.includes('vào game chưa')));
  assert.equal((await cs.get(`/bookings/${b.id}/room`)).status, 200);
  assert.equal(reconcile().ok, true);
});

test('DS-02 khiếu nại trùng → trả về hồ sơ cũ, không đóng băng lần 2; không thể giải ngân khi đang tranh chấp', async () => {
  const r = await renter.post(`/bookings/${disputedBooking.id}/dispute`, { reason: 'gửi lại lần nữa' });
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, true);
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE type='ESCROW_FREEZE' AND booking_id=?", disputedBooking.id).n, 1);
  const c = await renter.post(`/bookings/${disputedBooking.id}/confirm`);
  assert.equal(c.status, 409);
  clock.freeze(disputedBooking.confirm_deadline + HOUR);
  runSchedulerOnce();
  assert.equal(q.get('SELECT status FROM escrows WHERE booking_id=?', disputedBooking.id).status, 'FROZEN', 'scheduler không tự giải ngân');
});

test('DS-03 phân quyền: Renter/Companion không gọi được API CS; người ngoài không xem hồ sơ', async () => {
  assert.equal((await renter.post(`/admin/disputes/${disputeId}/decide`, { faultPercent: 100, reason: 'tự xử cho mình thắng' })).status, 403);
  assert.equal((await comp.post(`/admin/disputes/${disputeId}/decide`, { faultPercent: 0, reason: 'tự xử cho mình thắng' })).status, 403);
  assert.equal((await renter2.get(`/disputes/${disputeId}`)).status, 403);
  assert.equal((await comp.get(`/disputes/${disputeId}`)).status, 200);
  assert.equal((await renter.get('/admin/disputes')).status, 403);
});

test('DS-04 bằng chứng: kiểm tra loại/kích thước tệp; CS yêu cầu bổ sung → tiền vẫn đóng băng; bên liên quan bổ sung → quay lại xem xét', async () => {
  const bad = await comp.post(`/disputes/${disputeId}/evidence`, { file: { name: 'x.exe', mime: 'application/x-msdownload', base64: 'TVo=' } });
  assert.equal(bad.data.error.code, 'INVALID_FILE_TYPE');
  const big = await comp.post(`/disputes/${disputeId}/evidence`, { file: { name: 'a.png', mime: 'image/png', base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') } });
  assert.equal(big.data.error.code, 'FILE_TOO_LARGE');
  assert.equal((await cs.post(`/admin/disputes/${disputeId}/request-evidence`, { note: 'Gửi ảnh lịch sử trận đấu' })).data.dispute.status, 'NEEDS_EVIDENCE');
  assert.equal(q.get('SELECT status FROM escrows WHERE booking_id=?', disputedBooking.id).status, 'FROZEN');
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const ok = await comp.post(`/disputes/${disputeId}/evidence`, { text: 'Mình bị mất mạng', file: { name: '../../etc/passwd.png', mime: 'image/png', base64: png } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.dispute.status, 'OPEN');
  const ev = q.get("SELECT * FROM evidence WHERE dispute_id=? AND kind='FILE'", disputeId);
  assert.doesNotMatch(ev.file_name, /\//, 'tên tệp được làm sạch');
  const fileRes = await fetch(`${ctx.base}/api/evidence/${ev.id}/file`);
  assert.equal(fileRes.status, 401, 'tải tệp cần đăng nhập');
});

test('DS-05 phán quyết bắt buộc lý do, tỷ lệ hợp lệ', async () => {
  assert.equal((await cs.post(`/admin/disputes/${disputeId}/decide`, { faultPercent: 90, reason: 'ngắn' })).data.error.code, 'REASON_REQUIRED');
  assert.equal((await cs.post(`/admin/disputes/${disputeId}/decide`, { faultPercent: 120, reason: 'Lý do đủ dài đây nhé' })).data.error.code, 'INVALID_FAULT');
});

test('DS-06 lỗi Companion đúng 80% → hoàn 100% Renter + phạt 20% (ví Companion thiếu → ghi nợ); đóng hồ sơ; xử lý lặp bị chặn', async () => {
  // Companion rút cạn ví để kiểm tra nhánh ghi nợ phạt
  const all = wallet(ctx.companion.id).AVAILABLE;
  assert.ok(all >= 50_000);
  assert.equal((await comp.post('/withdrawals', { amount: all, payoutCode: 'PAYOUT-TEST1', idempotencyKey: 'drain-wallet-1' })).status, 201);
  const w = wallet(ctx.companion.id).AVAILABLE;
  assert.equal(w, 0);
  const r0 = wallet(ctx.renter.id).AVAILABLE;
  const pen0 = q.get("SELECT balance FROM ledger_accounts WHERE code='SYS:PLATFORM_PENALTY'").balance;
  const r = await cs.post(`/admin/disputes/${disputeId}/decide`, { faultPercent: 80, reason: 'Companion vào trễ 40 phút, có log chat chứng minh' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.summary.outcome, 'REFUND');
  assert.equal(r.data.summary.penalty, 6_666); // floor(33.333 × 20%)
  assert.equal(wallet(ctx.renter.id).AVAILABLE, r0 + 33_333);
  assert.equal(wallet(ctx.renter.id).FROZEN, 0);
  const pen = q.get("SELECT balance FROM ledger_accounts WHERE code='SYS:PLATFORM_PENALTY'").balance - pen0;
  assert.equal(pen, 6_666);
  const cw = wallet(ctx.companion.id);
  assert.equal(cw.AVAILABLE, 0);
  assert.equal(cw.RECEIVABLE, -6_666, 'phần phạt không trừ được ghi nợ');
  assert.equal((await comp.post('/withdrawals', { amount: 50_000, payoutCode: 'PAYOUT-TEST1', idempotencyKey: 'blocked-by-debt' })).status, 422);
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', disputedBooking.id).status, 'RESOLVED_REFUNDED');
  const again = await cs.post(`/admin/disputes/${disputeId}/decide`, { faultPercent: 0, reason: 'Đổi ý muốn giải phóng tiền' });
  assert.equal(again.status, 409);
  const log = q.get("SELECT * FROM audit_logs WHERE action='DISPUTE_DECIDE' AND entity_id=?", disputeId);
  assert.equal(log.actor_id, ctx.cs.id);
  assert.match(log.data, /evidenceIds/);
  assert.equal(reconcile().ok, true);
});

test('DS-07 lỗi Companion 79% → giải phóng 88/12 cho Companion (nợ phạt cũ được bù trừ trước)', async () => {
  const b = await finishedSession(15);
  const d = (await renter.post(`/bookings/${b.id}/dispute`, { reason: 'Không vui lắm' })).data.dispute;
  const debt0 = -wallet(ctx.companion.id).RECEIVABLE;
  const c0 = wallet(ctx.companion.id).AVAILABLE;
  const r = await cs.post(`/admin/disputes/${d.id}/decide`, { faultPercent: 79, reason: 'Companion có lỗi nhỏ, chưa tới ngưỡng 80%' });
  assert.equal(r.data.summary.outcome, 'RELEASE');
  assert.equal(r.data.summary.companion, 29_334);
  assert.equal(debt0, 6_666);
  const offset = Math.min(debt0, 29_334);
  assert.equal(wallet(ctx.companion.id).AVAILABLE, c0 + 29_334 - offset);
  assert.equal(wallet(ctx.companion.id).RECEIVABLE + (debt0 - offset), 0);
  assert.equal(q.get('SELECT status FROM bookings WHERE id=?', b.id).status, 'RESOLVED_RELEASED');
  assert.equal(reconcile().ok, true);
});

test('DS-08 không báo sự cố được khi quá 15 phút nghiệm thu / khi đơn chưa diễn ra', async () => {
  const b = await finishedSession(16);
  clock.freeze(b.confirm_deadline + 1);
  const r = await renter.post(`/bookings/${b.id}/dispute`, { reason: 'Báo trễ quá rồi' });
  assert.equal(r.status, 409);
  clock.freeze(T0);
  const b2 = (await book(renter, ctx.companion.id, at(9, 11), 1)).data.booking;
  assert.equal((await renter.post(`/bookings/${b2.id}/dispute`, { reason: 'Chưa chơi mà' })).status, 409);
});
