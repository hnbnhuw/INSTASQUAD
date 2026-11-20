// Sổ cái ghi kép (double-entry). MỌI thay đổi số dư đều phải đi qua postTransaction().
// - Mỗi giao dịch có reference duy nhất (idempotency): gửi lặp trả về giao dịch cũ, không ghi lần hai.
// - Tổng DEBIT = tổng CREDIT. Số dư tài khoản người dùng không được âm (trừ RECEIVABLE = khoản nợ phạt).
// - Cache balance cập nhật cùng transaction với ledger_entries; reconcile() kiểm tra lại.
import { q, tx, getDb } from '../db.js';
import { clock } from '../clock.js';
import { LedgerError } from '../errors.js';
import { getSetting, setSetting, raiseOpsAlert } from './common.js';

export const USER_ACCOUNT_TYPES = ['AVAILABLE', 'ESCROW', 'FROZEN', 'WITHDRAW_HOLD', 'RECEIVABLE'];
export const SYSTEM_ACCOUNT_TYPES = ['PLATFORM_REVENUE', 'PLATFORM_PENALTY', 'GATEWAY_CLEARING', 'PAYOUT_CLEARING'];
// Tài khoản được phép âm: RECEIVABLE (nợ phạt của Companion), clearing với bên ngoài (tiền đi vào/ra hệ thống).
const MAY_BE_NEGATIVE = new Set(['RECEIVABLE', 'GATEWAY_CLEARING', 'PAYOUT_CLEARING']);

export function ensureSystemAccounts() {
  for (const t of SYSTEM_ACCOUNT_TYPES) {
    q.run(
      'INSERT OR IGNORE INTO ledger_accounts(code, user_id, type, balance, created_at) VALUES (?, NULL, ?, 0, ?)',
      `SYS:${t}`,
      t,
      clock.now(),
    );
  }
}

export function ensureUserAccounts(userId) {
  for (const t of USER_ACCOUNT_TYPES) {
    q.run(
      'INSERT OR IGNORE INTO ledger_accounts(code, user_id, type, balance, created_at) VALUES (?, ?, ?, 0, ?)',
      `U${userId}:${t}`,
      userId,
      t,
      clock.now(),
    );
  }
}

export function userAccount(userId, type) {
  let a = q.get('SELECT * FROM ledger_accounts WHERE user_id=? AND type=?', userId, type);
  if (!a) {
    ensureUserAccounts(userId);
    a = q.get('SELECT * FROM ledger_accounts WHERE user_id=? AND type=?', userId, type);
  }
  return a;
}
export function systemAccount(type) {
  let a = q.get('SELECT * FROM ledger_accounts WHERE code=?', `SYS:${type}`);
  if (!a) {
    ensureSystemAccounts();
    a = q.get('SELECT * FROM ledger_accounts WHERE code=?', `SYS:${type}`);
  }
  return a;
}

// Fault injection (chỉ demo/test): làm lần ghi sổ kế tiếp thất bại để minh họa nhánh lỗi của BPMN.
export function armLedgerFault(on = true) {
  setSetting('fault.ledger_fail_next', on ? '1' : '0');
}
export function isLedgerFaultArmed() {
  return getSetting('fault.ledger_fail_next', '0') === '1';
}

/**
 * Ghi một giao dịch sổ cái. Phải gọi bên trong tx().
 * lines: [{ account: <row ledger_accounts>, direction: 'DEBIT'|'CREDIT', amount: int }]
 * Trả về { txn, duplicate }.
 */
export function postTransaction({ reference, type, description, lines, bookingId, paymentId, withdrawalId, disputeId, createdBy }) {
  const existing = q.get('SELECT * FROM ledger_transactions WHERE reference=?', reference);
  if (existing) return { txn: existing, duplicate: true };

  if (isLedgerFaultArmed()) {
    const err = new LedgerError('Lỗi ghi sổ (fault injection demo)', { reference });
    err.faultInjected = true;
    throw err;
  }

  const merged = lines.filter((l) => l.amount !== 0);
  if (merged.length < 2) throw new LedgerError('Giao dịch phải có ít nhất 2 bút toán', { reference });
  let debit = 0;
  let credit = 0;
  for (const l of merged) {
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0) throw new LedgerError('Số tiền bút toán phải là số nguyên dương', { reference, amount: l.amount });
    if (l.direction === 'DEBIT') debit += l.amount;
    else if (l.direction === 'CREDIT') credit += l.amount;
    else throw new LedgerError('Chiều bút toán không hợp lệ', { reference });
  }
  if (debit !== credit) throw new LedgerError('Giao dịch lệch: tổng DEBIT ≠ tổng CREDIT', { reference, debit, credit });

  const now = clock.now();
  const r = q.run(
    `INSERT INTO ledger_transactions(reference, type, booking_id, payment_id, withdrawal_id, dispute_id, description, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    reference,
    type,
    bookingId ?? null,
    paymentId ?? null,
    withdrawalId ?? null,
    disputeId ?? null,
    description,
    createdBy ?? null,
    now,
  );
  const txnId = Number(r.lastInsertRowid);
  const updBal = getDb().prepare('UPDATE ledger_accounts SET balance = balance + ? WHERE id = ?');
  const insEntry = getDb().prepare(
    'INSERT INTO ledger_entries(txn_id, account_id, direction, amount, balance_after, created_at) VALUES (?,?,?,?,?,?)',
  );
  for (const l of merged) {
    const delta = l.direction === 'CREDIT' ? l.amount : -l.amount;
    updBal.run(delta, l.account.id);
    const acc = q.get('SELECT * FROM ledger_accounts WHERE id=?', l.account.id);
    if (acc.balance < 0 && !MAY_BE_NEGATIVE.has(acc.type)) {
      throw new LedgerError('Số dư không đủ', { reference, account: acc.code, type: acc.type, shortBy: -acc.balance, code: 'INSUFFICIENT_FUNDS' });
    }
    insEntry.run(txnId, acc.id, l.direction, l.amount, acc.balance, now);
  }
  return { txn: q.get('SELECT * FROM ledger_transactions WHERE id=?', txnId), duplicate: false };
}

// Tiện ích tạo bút toán chuyển: debit nguồn, credit đích
export const D = (account, amount) => ({ account, direction: 'DEBIT', amount });
export const C = (account, amount) => ({ account, direction: 'CREDIT', amount });

export function getWallet(userId) {
  ensureUserAccounts(userId);
  const rows = q.all('SELECT type, balance FROM ledger_accounts WHERE user_id=?', userId);
  const w = { available: 0, escrow: 0, frozen: 0, withdrawHold: 0, receivable: 0 };
  for (const r of rows) {
    if (r.type === 'AVAILABLE') w.available = r.balance;
    if (r.type === 'ESCROW') w.escrow = r.balance;
    if (r.type === 'FROZEN') w.frozen = r.balance;
    if (r.type === 'WITHDRAW_HOLD') w.withdrawHold = r.balance;
    if (r.type === 'RECEIVABLE') w.receivable = r.balance;
  }
  return w;
}

export function listUserEntries(userId, limit = 100) {
  return q.all(
    `SELECT e.id, e.direction, e.amount, e.balance_after, e.created_at, a.type AS account_type,
            t.reference, t.type AS txn_type, t.description, t.booking_id, t.payment_id, t.withdrawal_id, t.id AS txn_id
       FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN ledger_transactions t ON t.id = e.txn_id
      WHERE a.user_id = ?
      ORDER BY e.id DESC LIMIT ?`,
    userId,
    limit,
  );
}

export function getTxnWithEntries(txnId) {
  const t = q.get('SELECT * FROM ledger_transactions WHERE id=?', txnId);
  if (!t) return null;
  t.entries = q.all(
    `SELECT e.direction, e.amount, e.balance_after, a.code AS account, a.type AS account_type
       FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.txn_id=? ORDER BY e.id`,
    txnId,
  );
  return t;
}

/**
 * Đối soát: KHÔNG tự sửa dữ liệu, chỉ báo cáo sai lệch.
 */
export function reconcile() {
  const issues = [];
  const accounts = q.all(
    `SELECT a.id, a.code, a.type, a.balance,
            COALESCE(SUM(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END),0) AS ledger_sum,
            COUNT(e.id) AS n
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id`,
  );
  for (const a of accounts) {
    if (a.balance !== a.ledger_sum) issues.push({ type: 'BALANCE_MISMATCH', account: a.code, cached: a.balance, ledger: a.ledger_sum });
    if (a.n > 0) {
      const last = q.get('SELECT balance_after FROM ledger_entries WHERE account_id=? ORDER BY id DESC LIMIT 1', a.id);
      if (last.balance_after !== a.balance) issues.push({ type: 'BALANCE_AFTER_MISMATCH', account: a.code, cached: a.balance, last: last.balance_after });
    }
    if (a.balance < 0 && !MAY_BE_NEGATIVE.has(a.type)) issues.push({ type: 'NEGATIVE_BALANCE', account: a.code, balance: a.balance });
  }
  const unbalanced = q.all(
    `SELECT txn_id, SUM(CASE WHEN direction='DEBIT' THEN amount ELSE 0 END) d, SUM(CASE WHEN direction='CREDIT' THEN amount ELSE 0 END) c
       FROM ledger_entries GROUP BY txn_id HAVING d <> c`,
  );
  for (const u of unbalanced) issues.push({ type: 'UNBALANCED_TXN', txnId: u.txn_id, debit: u.d, credit: u.c });
  const total = q.get('SELECT COALESCE(SUM(balance),0) s FROM ledger_accounts').s;
  if (total !== 0) issues.push({ type: 'GLOBAL_SUM_NOT_ZERO', total });

  // Trạng thái Escrow phải khớp số dư tài khoản ESCROW/FROZEN
  const held = q.get("SELECT COALESCE(SUM(amount),0) s FROM escrows WHERE status='HELD'").s;
  const escrowBal = q.get("SELECT COALESCE(SUM(balance),0) s FROM ledger_accounts WHERE type='ESCROW'").s;
  if (held !== escrowBal) issues.push({ type: 'ESCROW_HELD_MISMATCH', escrowsHeld: held, escrowAccounts: escrowBal });
  const frozen = q.get("SELECT COALESCE(SUM(amount),0) s FROM escrows WHERE status='FROZEN'").s;
  const frozenBal = q.get("SELECT COALESCE(SUM(balance),0) s FROM ledger_accounts WHERE type='FROZEN'").s;
  if (frozen !== frozenBal) issues.push({ type: 'ESCROW_FROZEN_MISMATCH', escrowsFrozen: frozen, frozenAccounts: frozenBal });
  const wPending = q.get("SELECT COALESCE(SUM(amount),0) s FROM withdraw_requests WHERE status IN ('PENDING','PROCESSING')").s;
  const wBal = q.get("SELECT COALESCE(SUM(balance),0) s FROM ledger_accounts WHERE type='WITHDRAW_HOLD'").s;
  if (wPending !== wBal) issues.push({ type: 'WITHDRAW_HOLD_MISMATCH', pending: wPending, holdAccounts: wBal });
  // Mỗi payment SUCCESS phải có đúng 1 giao dịch nạp tiền
  const badPay = q.all(
    `SELECT p.id FROM payments p WHERE (p.status='SUCCESS') <> EXISTS(SELECT 1 FROM ledger_transactions t WHERE t.reference = 'TOPUP:' || p.id)`,
  );
  for (const p of badPay) issues.push({ type: 'PAYMENT_LEDGER_MISMATCH', paymentId: p.id });

  const stats = q.get('SELECT (SELECT COUNT(*) FROM ledger_transactions) txns, (SELECT COUNT(*) FROM ledger_entries) entries');
  return {
    ok: issues.length === 0,
    checkedAt: clock.now(),
    accounts: accounts.length,
    transactions: stats.txns,
    entries: stats.entries,
    systemBalances: Object.fromEntries(
      q.all('SELECT type, balance FROM ledger_accounts WHERE user_id IS NULL').map((r) => [r.type, r.balance]),
    ),
    issues,
  };
}

// Bao một thao tác tài chính: chạy trong tx; nếu lỗi ghi sổ → rollback (do tx) rồi tạo cảnh báo đối soát.
export function runFinancial(operation, payload, fn, { bookingId = null, alert = true } = {}) {
  try {
    const result = tx(fn);
    if (bookingId) {
      q.run(
        "UPDATE ops_alerts SET status='RESOLVED', resolution='Tự động: thao tác thành công khi thực hiện lại', resolved_at=? WHERE booking_id=? AND operation=? AND status='OPEN'",
        clock.now(),
        bookingId,
        operation,
      );
    }
    return result;
  } catch (e) {
    if (e.faultInjected) armLedgerFault(false);
    if (alert && e instanceof LedgerError && e.details?.code !== 'INSUFFICIENT_FUNDS') {
      e.alertId = raiseOpsAlert({ kind: 'LEDGER_FAILURE', bookingId, operation, payload, error: e.message });
    }
    throw e;
  }
}
