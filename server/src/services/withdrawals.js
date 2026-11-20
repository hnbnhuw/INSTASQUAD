// Rút tiền MÔ PHỎNG (không gọi ngân hàng). PENDING → PROCESSING → COMPLETED / REJECTED.
// Tạo yêu cầu: giữ tiền (AVAILABLE → WITHDRAW_HOLD). Từ chối: trả lại bằng bút toán, không sửa số dư trực tiếp.
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { POLICY } from '../policy.js';
import { E } from '../errors.js';
import { audit, notify, notifyRole } from './common.js';
import { postTransaction, userAccount, systemAccount, runFinancial, getWallet, D, C } from './ledger.js';

export const WITHDRAW_STATUS = { PENDING: 'Chờ xử lý', PROCESSING: 'Đang xử lý', COMPLETED: 'Đã chuyển', REJECTED: 'Bị từ chối' };

export function createWithdrawal(user, { amount, payoutCode, idempotencyKey }) {
  if (user.role !== 'COMPANION') throw E.forbidden('Chỉ Companion được rút tiền');
  if (user.kyc_status !== 'VERIFIED') throw E.forbidden('Cần hoàn tất eKYC trước khi rút tiền');
  if (!Number.isSafeInteger(amount) || amount < POLICY.MIN_WITHDRAW) {
    throw E.badRequest('INVALID_AMOUNT', `Số tiền rút tối thiểu ${POLICY.MIN_WITHDRAW.toLocaleString('vi-VN')}đ (số nguyên VND)`);
  }
  if (!/^PAYOUT-[A-Z0-9]{4,20}$/.test(payoutCode || '')) throw E.badRequest('INVALID_PAYOUT_CODE', 'Mã nhận tiền mô phỏng có dạng PAYOUT-XXXX (không dùng số tài khoản thật)');
  const dup = q.get('SELECT * FROM withdraw_requests WHERE user_id=? AND idempotency_key=?', user.id, idempotencyKey);
  if (dup) {
    if (dup.amount !== amount) throw E.conflict('IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã dùng cho yêu cầu khác');
    return { withdrawal: dup, duplicate: true };
  }
  return runFinancial('WITHDRAW_CREATE', { userId: user.id, amount }, () => {
    const w = getWallet(user.id);
    if (w.receivable < 0) throw E.unprocessable('OUTSTANDING_DEBT', `Bạn đang nợ phạt ${(-w.receivable).toLocaleString('vi-VN')}đ, chưa thể rút tiền`);
    if (amount > w.available) throw E.unprocessable('INSUFFICIENT_BALANCE', 'Số tiền rút vượt quá số dư khả dụng', { available: w.available });
    const now = clock.now();
    const { txn } = postTransaction({
      reference: `WITHDRAW_RESERVE:U${user.id}:${idempotencyKey}`,
      type: 'WITHDRAW_RESERVE',
      description: `Giữ tiền cho yêu cầu rút ${amount.toLocaleString('vi-VN')}đ`,
      createdBy: user.id,
      lines: [D(userAccount(user.id, 'AVAILABLE'), amount), C(userAccount(user.id, 'WITHDRAW_HOLD'), amount)],
    });
    const r = q.run(
      `INSERT INTO withdraw_requests(user_id, amount, payout_code, status, idempotency_key, reserve_txn_id, created_at, updated_at)
       VALUES (?,?,?, 'PENDING', ?,?,?,?)`,
      user.id,
      amount,
      payoutCode,
      idempotencyKey,
      txn.id,
      now,
      now,
    );
    const id = Number(r.lastInsertRowid);
    q.run('UPDATE ledger_transactions SET withdrawal_id=? WHERE id=?', id, txn.id);
    audit(user.id, 'WITHDRAW_CREATE', 'withdrawal', id, { amount });
    notifyRole(['ADMIN'], 'WITHDRAW_NEW', 'Yêu cầu rút tiền mới', `${user.display_name}: ${amount.toLocaleString('vi-VN')}đ`, '/admin/withdrawals');
    return { withdrawal: q.get('SELECT * FROM withdraw_requests WHERE id=?', id), duplicate: false };
  });
}

export function processWithdrawal(admin, id, action, reason) {
  const w0 = q.get('SELECT * FROM withdraw_requests WHERE id=?', id);
  if (!w0) throw E.notFound();
  if (action === 'PROCESS') {
    return tx(() => {
      const r = q.run("UPDATE withdraw_requests SET status='PROCESSING', processed_by=?, updated_at=? WHERE id=? AND status='PENDING'", admin.id, clock.now(), id);
      if (!Number(r.changes)) throw E.conflict('INVALID_STATE', `Yêu cầu đang ở trạng thái "${WITHDRAW_STATUS[w0.status]}"`);
      audit(admin.id, 'WITHDRAW_PROCESS', 'withdrawal', id, null);
      notify(w0.user_id, 'WITHDRAW_PROCESSING', 'Yêu cầu rút tiền đang xử lý', `${w0.amount.toLocaleString('vi-VN')}đ`, '/wallet');
      return q.get('SELECT * FROM withdraw_requests WHERE id=?', id);
    });
  }
  if (action === 'COMPLETE') {
    return runFinancial('WITHDRAW_COMPLETE', { id }, () => {
      const w = q.get('SELECT * FROM withdraw_requests WHERE id=?', id);
      if (w.status !== 'PROCESSING') throw E.conflict('INVALID_STATE', `Chỉ hoàn tất được yêu cầu đang xử lý (hiện: "${WITHDRAW_STATUS[w.status]}")`);
      const { txn } = postTransaction({
        reference: `WITHDRAW_PAYOUT:${id}`,
        type: 'WITHDRAW_PAYOUT',
        description: `Chi trả rút tiền #${id} tới ${w.payout_code} (mô phỏng)`,
        withdrawalId: id,
        createdBy: admin.id,
        lines: [D(userAccount(w.user_id, 'WITHDRAW_HOLD'), w.amount), C(systemAccount('PAYOUT_CLEARING'), w.amount)],
      });
      q.run("UPDATE withdraw_requests SET status='COMPLETED', final_txn_id=?, processed_by=?, updated_at=? WHERE id=?", txn.id, admin.id, clock.now(), id);
      audit(admin.id, 'WITHDRAW_COMPLETE', 'withdrawal', id, null);
      notify(w.user_id, 'WITHDRAW_COMPLETED', 'Rút tiền thành công', `${w.amount.toLocaleString('vi-VN')}đ đã chuyển tới ${w.payout_code} (mô phỏng).`, '/wallet');
      return q.get('SELECT * FROM withdraw_requests WHERE id=?', id);
    });
  }
  if (action === 'REJECT') {
    if (!reason || reason.trim().length < 5) throw E.badRequest('REASON_REQUIRED', 'Cần nhập lý do từ chối');
    return runFinancial('WITHDRAW_REJECT', { id }, () => {
      const w = q.get('SELECT * FROM withdraw_requests WHERE id=?', id);
      if (!['PENDING', 'PROCESSING'].includes(w.status)) throw E.conflict('INVALID_STATE', `Yêu cầu đang ở trạng thái "${WITHDRAW_STATUS[w.status]}"`);
      const { txn } = postTransaction({
        reference: `WITHDRAW_RELEASE:${id}`,
        type: 'WITHDRAW_RELEASE',
        description: `Trả lại tiền giữ do từ chối rút #${id}`,
        withdrawalId: id,
        createdBy: admin.id,
        lines: [D(userAccount(w.user_id, 'WITHDRAW_HOLD'), w.amount), C(userAccount(w.user_id, 'AVAILABLE'), w.amount)],
      });
      q.run("UPDATE withdraw_requests SET status='REJECTED', final_txn_id=?, processed_by=?, reject_reason=?, updated_at=? WHERE id=?", txn.id, admin.id, reason, clock.now(), id);
      audit(admin.id, 'WITHDRAW_REJECT', 'withdrawal', id, { reason });
      notify(w.user_id, 'WITHDRAW_REJECTED', 'Yêu cầu rút tiền bị từ chối', `Đã trả ${w.amount.toLocaleString('vi-VN')}đ về ví. Lý do: ${reason}`, '/wallet');
      return q.get('SELECT * FROM withdraw_requests WHERE id=?', id);
    });
  }
  throw E.badRequest('INVALID_ACTION', 'Thao tác không hợp lệ');
}
