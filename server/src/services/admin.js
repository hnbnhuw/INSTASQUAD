// Dashboard quản trị, đối soát, cảnh báo ghi sổ (thử lại có audit), công cụ demo.
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { E } from '../errors.js';
import { parseJson } from '../util.js';
import { audit } from './common.js';
import { escrowBooking, timeoutBooking, settleBooking, respondToBooking, cancelByRenter, getBooking } from './bookings.js';
import { decideDispute, openDispute } from './disputes.js';
import { processWithdrawal } from './withdrawals.js';
import { handleGatewayCallback, signCallback } from './payments.js';
import { connectionCount } from './realtime.js';

export function dashboard() {
  const byStatus = Object.fromEntries(q.all('SELECT status, COUNT(*) n FROM bookings GROUP BY status').map((r) => [r.status, r.n]));
  const gmv = q.get("SELECT COALESCE(SUM(total_fee_snapshot),0) s FROM bookings WHERE status IN ('COMPLETED','RESOLVED_RELEASED')").s;
  const revenue = Object.fromEntries(q.all('SELECT kind, SUM(amount) s FROM platform_revenue GROUP BY kind').map((r) => [r.kind, r.s]));
  const views = q.get('SELECT COUNT(*) n FROM profile_views').n;
  // BR-003 (DP-11): phễu chuyển đổi = số cặp (người xem, Companion) đã tạo booking SAU lần xem đầu / tổng số cặp đã xem hồ sơ
  const funnel = q.get(
    `SELECT COUNT(*) pairs, SUM(CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.renter_id=v.viewer_id AND b.companion_id=v.companion_id AND b.created_at >= v.first_view) THEN 1 ELSE 0 END) converted
       FROM (SELECT viewer_id, companion_id, MIN(created_at) first_view FROM profile_views WHERE viewer_id IS NOT NULL GROUP BY viewer_id, companion_id) v`,
  );
  const created = q.get('SELECT COUNT(*) n FROM bookings').n;
  const completed = (byStatus.COMPLETED || 0) + (byStatus.RESOLVED_RELEASED || 0);
  const disputes = q.get(
    "SELECT COUNT(*) total, SUM(CASE WHEN status LIKE 'RESOLVED%' THEN 1 ELSE 0 END) resolved, AVG(CASE WHEN decided_at IS NOT NULL THEN decided_at - created_at END) avg_ms FROM disputes",
  );
  const users = Object.fromEntries(q.all('SELECT role, COUNT(*) n FROM users GROUP BY role').map((r) => [r.role, r.n]));
  return {
    bookingsByStatus: byStatus,
    bookingsCreated: created,
    bookingsCompleted: completed,
    gmv,
    revenue,
    profileViews: views,
    conversionRate: funnel.pairs ? Math.round(((funnel.converted || 0) / funnel.pairs) * 10000) / 100 : null,
    conversionPairs: { viewed: funnel.pairs, converted: funnel.converted || 0 },
    disputes: { total: disputes.total, resolved: disputes.resolved || 0, avgResolveMinutes: disputes.avg_ms ? Math.round(disputes.avg_ms / 60000) : null },
    openAlerts: q.get("SELECT COUNT(*) n FROM ops_alerts WHERE status='OPEN'").n,
    pendingWithdrawals: q.get("SELECT COUNT(*) n FROM withdraw_requests WHERE status IN ('PENDING','PROCESSING')").n,
    users,
    realtimeConnections: connectionCount(),
    serverNow: clock.now(),
    clockOffsetMs: clock.getOffset(),
  };
}

// Thử lại một thao tác tài chính bị lỗi. Dùng lại đúng hàm nghiệp vụ + reference cũ ⇒ không ghi trùng.
export function retryAlert(admin, alertId) {
  const a = q.get('SELECT * FROM ops_alerts WHERE id=?', alertId);
  if (!a) throw E.notFound();
  if (a.status !== 'OPEN') throw E.conflict('ALERT_CLOSED', 'Cảnh báo đã được xử lý');
  const p = parseJson(a.payload, {});
  const ops = {
    ESCROW_HOLD: () => escrowBooking(p.bookingId, null),
    COMPANION_TIMEOUT: () => timeoutBooking(p.bookingId),
    COMPANION_REJECT: () => {
      const b = getBooking(p.bookingId);
      return respondToBooking({ id: b.companion_id }, p.bookingId, 'REJECT');
    },
    RENTER_CANCEL: () => cancelByRenter({ id: p.renterId }, p.bookingId),
    SETTLE: () => settleBooking(p.bookingId, { actorId: admin.id, reason: 'Kiểm toán viên thử lại giải ngân sau lỗi ghi sổ' }),
    DISPUTE_FREEZE: () => openDispute({ id: p.renterId }, p.bookingId, { reason: p.reason, detail: p.detail }),
    DISPUTE_DECIDE: () => decideDispute({ id: p.csId }, p.disputeId, { faultPercent: p.faultPercent, reason: p.reason }),
    WITHDRAW_COMPLETE: () => processWithdrawal(admin, p.id, 'COMPLETE'),
    WITHDRAW_REJECT: () => processWithdrawal(admin, p.id, 'REJECT', 'Thử lại sau lỗi ghi sổ'),
    TOPUP_CALLBACK: () => {
      const pay = q.get('SELECT * FROM payments WHERE id=?', p.paymentId);
      return handleGatewayCallback({ gatewayTxnId: pay.gateway_txn_id, status: 'SUCCESS', amount: pay.amount, signature: signCallback({ gatewayTxnId: pay.gateway_txn_id, status: 'SUCCESS', amount: pay.amount }) });
    },
  };
  const fn = ops[a.operation];
  if (!fn) throw E.badRequest('NOT_RETRYABLE', 'Thao tác này cần xử lý thủ công');
  const result = fn();
  tx(() => {
    q.run("UPDATE ops_alerts SET status='RESOLVED', resolved_by=?, resolution=?, resolved_at=? WHERE id=? AND status='OPEN'", admin.id, 'Thử lại thành công', clock.now(), a.id);
    audit(admin.id, 'OPS_ALERT_RETRY', 'ops_alert', a.id, { operation: a.operation });
  });
  return { ok: true, result: result?.booking?.status ?? result?.status ?? null };
}

export function resolveAlert(admin, alertId, note) {
  if (!note || note.trim().length < 5) throw E.badRequest('NOTE_REQUIRED', 'Cần ghi chú cách xử lý');
  return tx(() => {
    const r = q.run("UPDATE ops_alerts SET status='RESOLVED', resolved_by=?, resolution=?, resolved_at=? WHERE id=? AND status='OPEN'", admin.id, note, clock.now(), alertId);
    if (!Number(r.changes)) throw E.conflict('ALERT_CLOSED', 'Cảnh báo không còn mở');
    audit(admin.id, 'OPS_ALERT_RESOLVE', 'ops_alert', alertId, { note });
    return { ok: true };
  });
}
