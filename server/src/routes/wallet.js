import { Router } from 'express';
import { z } from 'zod';
import { h, parse, idemKey, requireAuth, requireRole } from '../http.js';
import { E } from '../errors.js';
import { q } from '../db.js';
import { getWallet, listUserEntries } from '../services/ledger.js';
import { createTopup, handleGatewayCallback, signCallback, publicPayment } from '../services/payments.js';
import { createWithdrawal, WITHDRAW_STATUS } from '../services/withdrawals.js';

const r = Router();

// Callback (IPN) từ cổng thanh toán – công khai, xác thực bằng chữ ký HMAC, không dùng cookie.
r.post(
  '/payments/gateway/callback',
  h((req, res) => {
    const body = parse(
      z.object({ gatewayTxnId: z.string().max(64), status: z.string().max(20), amount: z.number().int(), signature: z.string().max(128) }),
      req.body,
    );
    res.json(handleGatewayCallback(body));
  }),
);

r.use(requireAuth);

r.get(
  '/wallet',
  h((req, res) => {
    const u = req.user;
    res.json({
      wallet: getWallet(u.id),
      entries: listUserEntries(u.id, 200),
      payments: q.all('SELECT * FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id).map(publicPayment),
      withdrawals: q
        .all('SELECT * FROM withdraw_requests WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id)
        .map((w) => ({ ...w, status_label: WITHDRAW_STATUS[w.status], idempotency_key: undefined })),
    });
  }),
);

r.post(
  '/payments/topup',
  h((req, res) => {
    const body = parse(
      z.object({
        amount: z.number().int('Số tiền phải là số nguyên VND'),
        method: z.enum(['VNPAY_MOCK', 'MOMO_MOCK']),
        idempotencyKey: idemKey,
        bookingId: z.number().int().positive().optional(),
      }),
      { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey },
    );
    const { payment, duplicate } = createTopup(req.user, body);
    res.status(duplicate ? 200 : 201).json({ payment: publicPayment(payment), duplicate, payUrl: `/pay/${payment.gateway_txn_id}` });
  }),
);

function ownPayment(req) {
  const p = q.get('SELECT * FROM payments WHERE gateway_txn_id=?', req.params.gtx);
  if (!p || p.user_id !== req.user.id) throw E.notFound('Không tìm thấy giao dịch');
  return p;
}

r.get(
  '/payments/sim/:gtx',
  h((req, res) => {
    const p = ownPayment(req);
    const callbacks = q.all('SELECT reported_status, signature_valid, outcome, created_at FROM payment_callbacks WHERE payment_id=? ORDER BY id', p.id);
    res.json({ payment: publicPayment(p), callbacks });
  }),
);

// Trang "cổng thanh toán" mô phỏng: người dùng chọn kết quả, cổng gửi callback ĐÃ KÝ về hệ thống qua đúng handler IPN.
r.post(
  '/payments/sim/:gtx/complete',
  h((req, res) => {
    const { outcome, times } = parse(z.object({ outcome: z.enum(['SUCCESS', 'FAILED', 'PENDING']), times: z.number().int().min(1).max(3).optional() }), req.body);
    const p = ownPayment(req);
    const results = [];
    for (let i = 0; i < (times || 1); i++) {
      const payload = { gatewayTxnId: p.gateway_txn_id, status: outcome, amount: p.amount };
      results.push(handleGatewayCallback({ ...payload, signature: signCallback(payload) }));
    }
    res.json({ results: results.map((x) => ({ outcome: x.outcome, followUp: x.followUp ?? null })), payment: publicPayment(q.get('SELECT * FROM payments WHERE id=?', p.id)), wallet: getWallet(req.user.id) });
  }),
);

r.post(
  '/withdrawals',
  requireRole('COMPANION'),
  h((req, res) => {
    const body = parse(
      z.object({ amount: z.number().int('Số tiền phải là số nguyên VND'), payoutCode: z.string().trim().toUpperCase(), idempotencyKey: idemKey }),
      { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey },
    );
    const { withdrawal, duplicate } = createWithdrawal(req.user, body);
    res.status(duplicate ? 200 : 201).json({ withdrawal: { ...withdrawal, idempotency_key: undefined }, duplicate, wallet: getWallet(req.user.id) });
  }),
);

r.get(
  '/notifications',
  h((req, res) => {
    const items = q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id);
    const unread = q.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL', req.user.id).n;
    res.json({ items, unread });
  }),
);
r.post(
  '/notifications/read',
  h((req, res) => {
    q.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', Date.now(), req.user.id);
    res.json({ ok: true });
  }),
);

export default r;
