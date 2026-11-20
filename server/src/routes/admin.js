import { Router } from 'express';
import { z } from 'zod';
import { h, parse, id, requireAuth, requireRole } from '../http.js';
import { E } from '../errors.js';
import { q } from '../db.js';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { reconcile, getTxnWithEntries, armLedgerFault, isLedgerFaultArmed, getWallet } from '../services/ledger.js';
import { disputeDetail, addEvidence, readEvidenceFile, requestMoreEvidence, decideDispute, DISPUTE_STATUS } from '../services/disputes.js';
import { processWithdrawal, WITHDRAW_STATUS } from '../services/withdrawals.js';
import { dashboard, retryAlert, resolveAlert } from '../services/admin.js';
import { bookingDetail, getBooking } from '../services/bookings.js';
import { kycSummary, publicUser } from '../services/users.js';
import { trustInputs } from '../services/trust.js';
import { audit, setSetting } from '../services/common.js';
import { resetAndSeed } from '../seed.js';
import { runSchedulerOnce } from '../scheduler.js';
import { POLICY } from '../policy.js';

const r = Router();
r.use(requireAuth);

// ---- Khiếu nại: các bên + CS/Admin ----
r.get('/disputes/:id', h((req, res) => res.json({ dispute: disputeDetail(req.user, parse(id, req.params.id)) })));
r.post(
  '/disputes/:id/evidence',
  h((req, res) => {
    const body = parse(
      z.object({
        text: z.string().trim().max(2000).optional(),
        file: z.object({ name: z.string().max(200), mime: z.string().max(100), base64: z.string() }).optional(),
      }),
      req.body,
    );
    res.status(201).json({ dispute: addEvidence(req.user, parse(id, req.params.id), body) });
  }),
);
r.get(
  '/evidence/:id/file',
  h((req, res) => {
    const f = readEvidenceFile(req.user, parse(id, req.params.id));
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.send(f.buf);
  }),
);

// ---- Khu vực CS/Admin ----
const staff = Router();
staff.use(requireRole('CS', 'ADMIN'));
staff.get(
  '/disputes',
  h((req, res) => {
    const rows = q.all(
      `SELECT d.id, d.status, d.reason, d.created_at, d.evidence_deadline, d.fault_percent, b.code, b.id AS booking_id, b.total_fee_snapshot,
              r.display_name AS renter_name, c.display_name AS companion_name
         FROM disputes d JOIN bookings b ON b.id=d.booking_id JOIN users r ON r.id=b.renter_id JOIN users c ON c.id=b.companion_id
        ORDER BY CASE WHEN d.status LIKE 'RESOLVED%' THEN 1 ELSE 0 END, d.id DESC`,
    );
    res.json({ disputes: rows.map((d) => ({ ...d, status_label: DISPUTE_STATUS[d.status] })), serverNow: clock.now() });
  }),
);
staff.get(
  '/disputes/:id/case',
  h((req, res) => {
    const d = disputeDetail(req.user, parse(id, req.params.id));
    const b = getBooking(d.booking_id);
    const messages = q.all(
      'SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.flagged, m.created_at FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.booking_id=? ORDER BY m.id',
      b.id,
    );
    const events = q.all('SELECT e.*, u.display_name AS user_name FROM session_events e LEFT JOIN users u ON u.id=e.user_id WHERE booking_id=? ORDER BY e.id', b.id);
    res.json({
      dispute: d,
      booking: bookingDetail(b, req.user),
      messages,
      events,
      companionTrust: trustInputs(b.companion_id),
      policy: { threshold: POLICY.DISPUTE_FAULT_THRESHOLD, penaltyPct: POLICY.DISPUTE_PENALTY_PCT },
    });
  }),
);
staff.post(
  '/disputes/:id/request-evidence',
  h((req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500) }), req.body);
    res.json({ dispute: requestMoreEvidence(req.user, parse(id, req.params.id), note) });
  }),
);
staff.post(
  '/disputes/:id/decide',
  h((req, res) => {
    const body = parse(z.object({ faultPercent: z.number().int(), reason: z.string().trim().max(1000) }), req.body);
    res.json(decideDispute(req.user, parse(id, req.params.id), body));
  }),
);
r.use('/admin', staff);

// ---- Chỉ Admin ----
const admin = Router();
admin.use(requireRole('ADMIN'));
admin.get('/dashboard', h((_req, res) => res.json(dashboard())));
admin.get('/reconcile', h((req, res) => {
  const report = reconcile();
  audit(req.user.id, 'RECONCILE_RUN', 'ledger', null, { ok: report.ok, issues: report.issues.length });
  res.json(report);
}));
admin.get(
  '/ledger',
  h((req, res) => {
    const rows = q.all('SELECT * FROM ledger_transactions ORDER BY id DESC LIMIT 100');
    res.json({ transactions: rows.map((t) => getTxnWithEntries(t.id)) });
  }),
);
admin.get(
  '/withdrawals',
  h((_req, res) => {
    const rows = q.all(
      `SELECT w.id, w.user_id, w.amount, w.payout_code, w.status, w.reject_reason, w.created_at, w.updated_at, u.display_name, u.email
         FROM withdraw_requests w JOIN users u ON u.id=w.user_id ORDER BY CASE WHEN w.status IN ('PENDING','PROCESSING') THEN 0 ELSE 1 END, w.id DESC`,
    );
    res.json({ withdrawals: rows.map((w) => ({ ...w, status_label: WITHDRAW_STATUS[w.status] })) });
  }),
);
admin.post(
  '/withdrawals/:id/:action',
  h((req, res) => {
    const action = parse(z.enum(['process', 'complete', 'reject']), req.params.action).toUpperCase();
    const { reason } = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body || {});
    res.json({ withdrawal: processWithdrawal(req.user, parse(id, req.params.id), action, reason) });
  }),
);
admin.get(
  '/alerts',
  h((_req, res) => res.json({ alerts: q.all('SELECT * FROM ops_alerts ORDER BY CASE status WHEN \'OPEN\' THEN 0 ELSE 1 END, id DESC LIMIT 200') })),
);
admin.post('/alerts/:id/retry', h((req, res) => res.json(retryAlert(req.user, parse(id, req.params.id)))));
admin.post(
  '/alerts/:id/resolve',
  h((req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500) }), req.body);
    res.json(resolveAlert(req.user, parse(id, req.params.id), note));
  }),
);
admin.get(
  '/users',
  h((_req, res) => {
    const users = q.all('SELECT * FROM users ORDER BY id').map((u) => ({ ...publicUser(u), wallet: getWallet(u.id), kyc: kycSummary(u.id) }));
    res.json({ users });
  }),
);
admin.post(
  '/users/:id/status',
  h((req, res) => {
    const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'LOCKED']) }), req.body);
    const uid = parse(id, req.params.id);
    if (uid === req.user.id) throw E.badRequest('SELF_LOCK', 'Không thể tự khóa tài khoản của mình');
    q.run('UPDATE users SET status=? WHERE id=?', status, uid);
    if (status === 'LOCKED') q.run('DELETE FROM auth_sessions WHERE user_id=?', uid);
    audit(req.user.id, 'USER_STATUS', 'user', uid, { status });
    res.json({ ok: true });
  }),
);
admin.get(
  '/audit',
  h((_req, res) =>
    res.json({
      logs: q.all('SELECT a.*, u.display_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300'),
    }),
  ),
);

// ---- Công cụ demo (chỉ khi DEMO_TOOLS=true, không bao giờ ở production) ----
admin.get(
  '/demo',
  h((_req, res) => {
    if (!config.DEMO_TOOLS) throw E.notFound();
    res.json({ enabled: true, serverNow: clock.now(), offsetMs: clock.getOffset(), ledgerFaultArmed: isLedgerFaultArmed() });
  }),
);
admin.post(
  '/demo/clock',
  h((req, res) => {
    if (!config.DEMO_TOOLS) throw E.notFound();
    const { advanceMinutes, reset } = parse(z.object({ advanceMinutes: z.number().int().min(-10080).max(10080).optional(), reset: z.boolean().optional() }), req.body);
    if (reset) clock.setOffset(0);
    else if (advanceMinutes) clock.advance(advanceMinutes * 60000);
    setSetting('demo.clock_offset', clock.getOffset());
    const stats = runSchedulerOnce();
    audit(req.user.id, 'DEMO_CLOCK', 'system', null, { advanceMinutes, reset, offsetMs: clock.getOffset() });
    res.json({ serverNow: clock.now(), offsetMs: clock.getOffset(), scheduler: stats });
  }),
);
admin.post(
  '/demo/ledger-fault',
  h((req, res) => {
    if (!config.DEMO_TOOLS) throw E.notFound();
    const { armed } = parse(z.object({ armed: z.boolean() }), req.body);
    armLedgerFault(armed);
    audit(req.user.id, 'DEMO_LEDGER_FAULT', 'system', null, { armed });
    res.json({ ledgerFaultArmed: isLedgerFaultArmed() });
  }),
);
admin.post(
  '/demo/scheduler',
  h((_req, res) => {
    if (!config.DEMO_TOOLS) throw E.notFound();
    res.json({ scheduler: runSchedulerOnce(), serverNow: clock.now() });
  }),
);
admin.post(
  '/demo/reset',
  h((req, res) => {
    if (!config.DEMO_TOOLS || config.isProd) throw E.notFound();
    const { confirm } = parse(z.object({ confirm: z.literal('RESET') }), req.body);
    resetAndSeed();
    res.json({ ok: Boolean(confirm), message: 'Đã xóa dữ liệu và nạp lại dữ liệu demo. Vui lòng đăng nhập lại.' });
  }),
);
r.use('/admin', admin);

export default r;
