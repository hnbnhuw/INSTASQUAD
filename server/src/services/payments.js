// Nạp tiền qua Payment Gateway MÔ PHỎNG (VNPay/MoMo mock). Không có tiền thật, không lưu thẻ.
// Callback được ký HMAC-SHA256 giống cổng thật; mọi callback (kể cả từ simulator) đi qua handleGatewayCallback().
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { POLICY } from '../policy.js';
import { E, LedgerError } from '../errors.js';
import { hmac, safeEqualHex, randomToken, json } from '../util.js';
import { notify, audit } from './common.js';
import { postTransaction, userAccount, systemAccount, runFinancial, D, C, getWallet } from './ledger.js';
import { escrowBooking, cancelForPaymentFailure, getBooking } from './bookings.js';

export function signCallback({ gatewayTxnId, status, amount }) {
  return hmac(config.GATEWAY_SECRET, `${gatewayTxnId}|${status}|${amount}`);
}

export function createTopup(user, { amount, method, idempotencyKey, bookingId }) {
  if (!Number.isSafeInteger(amount) || amount < POLICY.MIN_TOPUP || amount > POLICY.MAX_TOPUP) {
    throw E.badRequest('INVALID_AMOUNT', `Số tiền nạp phải là số nguyên từ ${POLICY.MIN_TOPUP.toLocaleString('vi-VN')} đến ${POLICY.MAX_TOPUP.toLocaleString('vi-VN')} VND`);
  }
  return tx(() => {
    const dup = q.get('SELECT * FROM payments WHERE user_id=? AND idempotency_key=?', user.id, idempotencyKey);
    if (dup) {
      if (dup.amount !== amount || dup.method !== method) throw E.conflict('IDEMPOTENCY_KEY_REUSED', 'Mã nạp tiền đã dùng cho yêu cầu khác');
      return { payment: dup, duplicate: true };
    }
    if (bookingId) {
      const b = getBooking(bookingId);
      if (!b || b.renter_id !== user.id) throw E.notFound('Không tìm thấy đơn');
    }
    const now = clock.now();
    const gtx = `GW${now.toString(36).toUpperCase()}${randomToken(6).replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
    const r = q.run(
      `INSERT INTO payments(user_id, booking_id, amount, method, status, idempotency_key, gateway_txn_id, created_at, updated_at)
       VALUES (?,?,?,?, 'PENDING', ?,?,?,?)`,
      user.id,
      bookingId ?? null,
      amount,
      method,
      idempotencyKey,
      gtx,
      now,
      now,
    );
    audit(user.id, 'TOPUP_CREATE', 'payment', Number(r.lastInsertRowid), { amount, method, bookingId });
    return { payment: q.get('SELECT * FROM payments WHERE id=?', Number(r.lastInsertRowid)), duplicate: false };
  });
}

function logCallback(paymentId, gtx, status, valid, outcome) {
  q.run(
    'INSERT INTO payment_callbacks(payment_id, gateway_txn_id, reported_status, signature_valid, outcome, created_at) VALUES (?,?,?,?,?,?)',
    paymentId,
    gtx,
    status,
    valid ? 1 : 0,
    outcome,
    clock.now(),
  );
}

/**
 * Xử lý callback từ cổng thanh toán (IPN). Idempotent: callback lặp chỉ được xử lý một lần.
 * Trả về { outcome, payment, followUp }
 */
export function handleGatewayCallback({ gatewayTxnId, status, amount, signature }) {
  const p = q.get('SELECT * FROM payments WHERE gateway_txn_id=?', gatewayTxnId);
  const valid = typeof signature === 'string' && safeEqualHex(signature, signCallback({ gatewayTxnId, status, amount }));
  if (!valid) {
    logCallback(p?.id ?? null, gatewayTxnId, status, false, 'REJECTED_BAD_SIGNATURE');
    throw E.badRequest('INVALID_SIGNATURE', 'Chữ ký callback không hợp lệ');
  }
  if (!p) {
    logCallback(null, gatewayTxnId, status, true, 'REJECTED_UNKNOWN_PAYMENT');
    throw E.notFound('Không tìm thấy giao dịch thanh toán');
  }
  if (p.amount !== amount) {
    logCallback(p.id, gatewayTxnId, status, true, 'REJECTED_AMOUNT_MISMATCH');
    throw E.badRequest('AMOUNT_MISMATCH', 'Số tiền callback không khớp');
  }
  if (!['SUCCESS', 'FAILED', 'PENDING'].includes(status)) throw E.badRequest('INVALID_STATUS', 'Trạng thái không hợp lệ');
  q.run('UPDATE payments SET callback_count = callback_count + 1 WHERE id=?', p.id);

  if (p.status !== 'PENDING') {
    logCallback(p.id, gatewayTxnId, status, true, 'DUPLICATE_IGNORED');
    return { outcome: 'DUPLICATE_IGNORED', payment: q.get('SELECT * FROM payments WHERE id=?', p.id) };
  }
  if (status === 'PENDING') {
    logCallback(p.id, gatewayTxnId, status, true, 'STILL_PENDING');
    return { outcome: 'STILL_PENDING', payment: p };
  }
  if (status === 'FAILED') {
    tx(() => {
      const r = q.run("UPDATE payments SET status='FAILED', failure_reason='Cổng thanh toán báo thất bại', updated_at=? WHERE id=? AND status='PENDING'", clock.now(), p.id);
      logCallback(p.id, gatewayTxnId, status, true, Number(r.changes) ? 'MARKED_FAILED' : 'DUPLICATE_IGNORED');
      notify(p.user_id, 'TOPUP_FAILED', 'Nạp tiền thất bại', `Giao dịch ${p.gateway_txn_id} không thành công. Ví không thay đổi.`, '/wallet');
    });
    let followUp = null;
    if (p.booking_id) {
      const b = cancelForPaymentFailure(p.booking_id);
      if (b) followUp = { bookingCancelled: b.id };
    }
    return { outcome: 'MARKED_FAILED', payment: q.get('SELECT * FROM payments WHERE id=?', p.id), followUp };
  }
  // SUCCESS → cộng ví đúng một lần (reference TOPUP:<id> là duy nhất)
  runFinancial('TOPUP_CALLBACK', { paymentId: p.id }, () => {
    const cur = q.get('SELECT * FROM payments WHERE id=?', p.id);
    if (cur.status !== 'PENDING') return;
    const { txn } = postTransaction({
      reference: `TOPUP:${p.id}`,
      type: 'TOPUP',
      description: `Nạp tiền ${p.method === 'VNPAY_MOCK' ? 'VNPay' : 'MoMo'} (mô phỏng) – ${p.gateway_txn_id}`,
      paymentId: p.id,
      createdBy: p.user_id,
      lines: [D(systemAccount('GATEWAY_CLEARING'), p.amount), C(userAccount(p.user_id, 'AVAILABLE'), p.amount)],
    });
    q.run("UPDATE payments SET status='SUCCESS', ledger_txn_id=?, updated_at=? WHERE id=?", txn.id, clock.now(), p.id);
    logCallback(p.id, gatewayTxnId, status, true, 'CREDITED');
    notify(p.user_id, 'TOPUP_SUCCESS', 'Nạp tiền thành công', `+${p.amount.toLocaleString('vi-VN')}đ vào ví khả dụng.`, '/wallet');
  });
  // Nạp tiền gắn với đơn đang giữ chỗ → kiểm tra lại số dư và ký quỹ (Hình 1A bước 8)
  let followUp = null;
  if (p.booking_id) {
    const b = getBooking(p.booking_id);
    if (b && b.status === 'AWAITING_ESCROW') {
      try {
        const r = escrowBooking(b.id, null);
        followUp = { escrowed: true, bookingId: r.booking.id };
      } catch (e) {
        followUp = { escrowed: false, bookingId: b.id, reason: e.code, details: e.details };
        if (e.code === 'INSUFFICIENT_BALANCE') {
          notify(b.renter_id, 'STILL_INSUFFICIENT', 'Nạp xong vẫn chưa đủ số dư', `${b.code}: còn thiếu ${e.details.shortfall.toLocaleString('vi-VN')}đ. Khung giờ sẽ tự nhả khi hết thời gian giữ.`, `/bookings/${b.id}`);
        } else if (!(e instanceof LedgerError)) {
          notify(b.renter_id, 'ESCROW_FAILED', 'Không thể ký quỹ', `${b.code}: ${e.message}`, `/bookings/${b.id}`);
        }
      }
    }
  }
  return { outcome: 'CREDITED', payment: q.get('SELECT * FROM payments WHERE id=?', p.id), followUp, wallet: getWallet(p.user_id) };
}

// Payment PENDING quá hạn → EXPIRED (coi như thất bại – BPMN gộp lỗi/timeout vào nhánh "Không")
export function expirePendingPayments() {
  const cutoff = clock.now() - POLICY.PAYMENT_PENDING_TTL_MS;
  const due = q.all("SELECT * FROM payments WHERE status='PENDING' AND created_at < ?", cutoff);
  for (const p of due) {
    tx(() => {
      const r = q.run("UPDATE payments SET status='EXPIRED', failure_reason='Quá thời gian chờ cổng thanh toán', updated_at=? WHERE id=? AND status='PENDING'", clock.now(), p.id);
      if (Number(r.changes)) notify(p.user_id, 'TOPUP_EXPIRED', 'Giao dịch nạp tiền hết hạn', `${p.gateway_txn_id} quá thời gian chờ, ví không thay đổi.`, '/wallet');
    });
    if (p.booking_id) cancelForPaymentFailure(p.booking_id);
  }
  return due.length;
}

export function publicPayment(p) {
  return { ...p, idempotency_key: undefined, payload: undefined };
}
export { json };
