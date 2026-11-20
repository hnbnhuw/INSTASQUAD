// Booking + Slot hold + Escrow + phản hồi 180s + hủy + Session + giải ngân 88/12.
// Bám BPMN Hình 1A, 1B, 1C, 2A, 2B.
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { POLICY } from '../policy.js';
import { E, LedgerError } from '../errors.js';
import { sha256, json, bookingCode, split88_12, splitPct, vnDayKey } from '../util.js';
import { audit, notify, pushBookingUpdate } from './common.js';
import { postTransaction, userAccount, systemAccount, getWallet, runFinancial, D, C } from './ledger.js';
import { recalcTrust, addDeduction } from './trust.js';

export const BOOKING_STATUS = {
  AWAITING_ESCROW: 'Đang giữ chỗ – chờ ký quỹ',
  PENDING_COMPANION: 'Chờ Companion phản hồi',
  ACCEPTED: 'Đã chấp nhận',
  IN_SESSION: 'Đang diễn ra',
  AWAITING_CONFIRMATION: 'Chờ nghiệm thu',
  COMPLETED: 'Hoàn tất',
  DISPUTED: 'Đang tranh chấp',
  RESOLVED_REFUNDED: 'Đã hoàn tiền (khiếu nại)',
  RESOLVED_RELEASED: 'Đã giải phóng tiền (khiếu nại)',
  CANCELLED: 'Đã hủy',
  EXPIRED: 'Hết hạn giữ chỗ',
};

// Bảng chuyển trạng thái hợp lệ (mọi transition khác bị cấm)
const TRANSITIONS = {
  AWAITING_ESCROW: ['PENDING_COMPANION', 'CANCELLED', 'EXPIRED'],
  PENDING_COMPANION: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['IN_SESSION', 'CANCELLED'],
  IN_SESSION: ['AWAITING_CONFIRMATION', 'DISPUTED'],
  AWAITING_CONFIRMATION: ['COMPLETED', 'DISPUTED'],
  DISPUTED: ['RESOLVED_REFUNDED', 'RESOLVED_RELEASED'],
};

export function getBooking(id) {
  return q.get('SELECT * FROM bookings WHERE id=?', id);
}

export function transition(booking, to, { actorId = null, reason = null, ledgerTxnId = null, set = {} } = {}) {
  if (!(TRANSITIONS[booking.status] || []).includes(to)) {
    throw E.conflict('INVALID_TRANSITION', `Không thể chuyển đơn từ "${BOOKING_STATUS[booking.status]}" sang "${BOOKING_STATUS[to]}"`, {
      from: booking.status,
      to,
    });
  }
  const now = clock.now();
  const cols = Object.keys(set);
  const r = q.run(
    `UPDATE bookings SET status=?, updated_at=?${cols.map((c) => `, ${c}=?`).join('')} WHERE id=? AND status=?`,
    to,
    now,
    ...cols.map((c) => set[c]),
    booking.id,
    booking.status,
  );
  if (Number(r.changes) !== 1) throw E.conflict('CONCURRENT_UPDATE', 'Đơn vừa được cập nhật bởi thao tác khác, vui lòng tải lại');
  q.run(
    'INSERT INTO booking_status_history(booking_id, from_status, to_status, actor_id, reason, ledger_txn_id, created_at) VALUES (?,?,?,?,?,?,?)',
    booking.id,
    booking.status,
    to,
    actorId,
    reason,
    ledgerTxnId,
    now,
  );
  const updated = getBooking(booking.id);
  pushBookingUpdate(updated);
  return updated;
}

function releaseSlots(bookingId) {
  // Chỉ mở lại các slot còn ở tương lai; slot đã qua để UNAVAILABLE.
  const now = clock.now();
  q.run("UPDATE slots SET status='AVAILABLE', booking_id=NULL, held_until=NULL WHERE booking_id=? AND start_at > ?", bookingId, now);
  q.run("UPDATE slots SET status='UNAVAILABLE', booking_id=NULL, held_until=NULL WHERE booking_id=? AND start_at <= ?", bookingId, now);
}

// Nếu Companion đang nợ phạt (RECEIVABLE < 0) thì khoản thu nhập mới được bù trừ nợ trước.
function creditCompanionLines(companionId, amount) {
  const avail = userAccount(companionId, 'AVAILABLE');
  const recv = userAccount(companionId, 'RECEIVABLE');
  const lines = [C(avail, amount)];
  const debt = -recv.balance;
  if (debt > 0) {
    const offset = Math.min(debt, amount);
    lines.push(D(avail, offset), C(recv, offset));
  }
  return lines;
}
export { creditCompanionLines };

// ---------------------------------------------------------------- Tạo booking (Hình 1A bước 1–4)
export function createBooking(renter, input) {
  if (renter.role !== 'RENTER') throw E.forbidden('Chỉ Renter mới được đặt lịch');
  if (renter.trust_score < POLICY.TRUST_LOCK_THRESHOLD) throw E.forbidden('Tài khoản đang bị tạm khóa do điểm tín nhiệm thấp');
  const { companionId, gameId, startAt, hours, note = '', requestKey } = input;
  const requestHash = sha256(json({ companionId, gameId, startAt, hours, note }));

  // (a) Yêu cầu gửi trùng → trả lại đơn đã có, không tạo thêm (idempotency)
  const dup = q.get('SELECT * FROM bookings WHERE renter_id=? AND request_key=?', renter.id, requestKey);
  if (dup) {
    if (dup.request_hash !== requestHash) throw E.conflict('IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng cho một yêu cầu khác');
    return { booking: dup, duplicate: true };
  }

  const now = clock.now();
  if (!Number.isInteger(hours) || hours < 1 || hours > POLICY.MAX_BOOKING_HOURS) {
    throw E.badRequest('INVALID_HOURS', `Số giờ thuê phải từ 1 đến ${POLICY.MAX_BOOKING_HOURS}`);
  }
  if (startAt % POLICY.SLOT_MS !== 0) throw E.badRequest('INVALID_SLOT', 'Giờ bắt đầu phải trùng đầu một khung giờ');
  if (startAt <= now) throw E.unprocessable('SLOT_IN_PAST', 'Khung giờ đã qua');

  const comp = q.get(
    `SELECT u.id, u.status, u.kyc_status, u.display_name, p.hourly_rate, p.accepting, p.status AS pstatus
       FROM users u JOIN companion_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='COMPANION'`,
    companionId,
  );
  if (!comp) throw E.notFound('Không tìm thấy Companion');
  if (comp.status !== 'ACTIVE' || comp.pstatus !== 'ACTIVE' || !comp.accepting || comp.kyc_status !== 'VERIFIED') {
    throw E.unprocessable('COMPANION_UNAVAILABLE', 'Companion hiện không nhận booking');
  }
  if (!q.get('SELECT 1 FROM companion_games WHERE companion_id=? AND game_id=?', companionId, gameId)) {
    throw E.badRequest('GAME_NOT_OFFERED', 'Companion không cung cấp dịch vụ cho game này');
  }

  const result = tx(() => {
    // Hết hạn các giữ chỗ cũ trước khi kiểm tra (xử lý race giữa expiry và booking mới)
    expireHolds();
    // Kiểm tra lại idempotency bên trong transaction (2 request cùng key đồng thời)
    const dup2 = q.get('SELECT * FROM bookings WHERE renter_id=? AND request_key=?', renter.id, requestKey);
    if (dup2) {
      if (dup2.request_hash !== requestHash) throw E.conflict('IDEMPOTENCY_KEY_REUSED', 'Mã yêu cầu đã được dùng cho một yêu cầu khác');
      return { booking: dup2, duplicate: true };
    }
    const endAt = startAt + hours * POLICY.SLOT_MS;
    const slots = q.all(
      'SELECT * FROM slots WHERE companion_id=? AND start_at>=? AND start_at<? ORDER BY start_at',
      companionId,
      startAt,
      endAt,
    );
    // (b) Khung giờ còn trống
    if (slots.length !== hours || slots.some((s) => s.status !== 'AVAILABLE')) {
      throw E.conflict('SLOT_UNAVAILABLE', 'Khung giờ không còn trống (vừa có người khác đặt hoặc Companion không rảnh)');
    }
    // (c) Giới hạn 10 giờ/ngày/Companion (tính theo ngày giờ Việt Nam)
    const perDay = {};
    for (const s of slots) perDay[vnDayKey(s.start_at)] = (perDay[vnDayKey(s.start_at)] || 0) + 1;
    const taken = q.all("SELECT start_at FROM slots WHERE companion_id=? AND status IN ('HELD','BOOKED')", companionId);
    for (const t of taken) {
      const k = vnDayKey(t.start_at);
      if (perDay[k] !== undefined) perDay[k]++;
    }
    for (const [day, n] of Object.entries(perDay)) {
      if (n > POLICY.MAX_HOURS_PER_DAY) {
        throw E.unprocessable('DAILY_LIMIT_EXCEEDED', `Companion đã đạt giới hạn ${POLICY.MAX_HOURS_PER_DAY} giờ trong ngày ${day}`);
      }
    }
    // Chốt phí tại thời điểm đặt (total_fee_snapshot)
    const total = comp.hourly_rate * hours;
    const heldUntil = now + POLICY.SLOT_HOLD_MS;
    const r = q.run(
      `INSERT INTO bookings(code, renter_id, companion_id, game_id, request_key, request_hash, start_at, end_at, hours,
         hourly_rate_snapshot, total_fee_snapshot, note, status, held_until, created_at, updated_at)
       VALUES ('TMP',?,?,?,?,?,?,?,?,?,?,?,'AWAITING_ESCROW',?,?,?)`,
      renter.id,
      companionId,
      gameId,
      requestKey,
      requestHash,
      startAt,
      endAt,
      hours,
      comp.hourly_rate,
      total,
      note,
      heldUntil,
      now,
      now,
    );
    const id = Number(r.lastInsertRowid);
    q.run('UPDATE bookings SET code=? WHERE id=?', bookingCode(id), id);
    // Khóa tạm slot — cập nhật có điều kiện, số dòng phải đúng bằng số giờ
    const upd = q.run(
      `UPDATE slots SET status='HELD', booking_id=?, held_until=? WHERE companion_id=? AND start_at>=? AND start_at<? AND status='AVAILABLE'`,
      id,
      heldUntil,
      companionId,
      startAt,
      endAt,
    );
    if (Number(upd.changes) !== hours) throw E.conflict('SLOT_UNAVAILABLE', 'Khung giờ không còn trống');
    q.run(
      'INSERT INTO booking_status_history(booking_id, from_status, to_status, actor_id, reason, created_at) VALUES (?,?,?,?,?,?)',
      id,
      null,
      'AWAITING_ESCROW',
      renter.id,
      'Tạo yêu cầu đặt lịch, giữ chỗ khung giờ',
      now,
    );
    audit(renter.id, 'BOOKING_CREATE', 'booking', id, { companionId, startAt, hours, total });
    return { booking: getBooking(id), duplicate: false };
  });
  return result;
}

// ---------------------------------------------------------------- Ký quỹ (Hình 1A bước 5, 10, 11, 12)
export function escrowBooking(bookingId, actorId) {
  const pre = getBooking(bookingId);
  if (!pre) throw E.notFound('Không tìm thấy đơn');
  if (actorId && pre.renter_id !== actorId) throw E.forbidden();
  if (pre.status !== 'AWAITING_ESCROW') {
    if (q.get('SELECT 1 FROM escrows WHERE booking_id=?', bookingId)) return { booking: pre, duplicate: true };
    throw E.conflict('INVALID_STATE', `Đơn đang ở trạng thái "${BOOKING_STATUS[pre.status]}", không thể ký quỹ`);
  }
  return runFinancial(
    'ESCROW_HOLD',
    { bookingId },
    () => {
      const b = getBooking(bookingId);
      const now = clock.now();
      if (b.status !== 'AWAITING_ESCROW') throw E.conflict('INVALID_STATE', 'Đơn không còn chờ ký quỹ');
      // Kiểm tra lại trong cùng transaction: còn giữ chỗ + đủ số dư
      if (b.held_until <= now) throw E.conflict('HOLD_EXPIRED', 'Thời gian giữ chỗ đã hết, khung giờ đã được mở lại');
      const held = q.get("SELECT COUNT(*) n FROM slots WHERE booking_id=? AND status='HELD'", b.id).n;
      if (held !== b.hours) throw E.conflict('HOLD_LOST', 'Khung giờ không còn được giữ cho đơn này');
      const w = getWallet(b.renter_id);
      if (w.available < b.total_fee_snapshot) {
        throw E.unprocessable('INSUFFICIENT_BALANCE', 'Số dư khả dụng không đủ để ký quỹ', {
          required: b.total_fee_snapshot,
          available: w.available,
          shortfall: b.total_fee_snapshot - w.available,
        });
      }
      const { txn } = postTransaction({
        reference: `ESCROW_HOLD:${b.id}`,
        type: 'ESCROW_HOLD',
        description: `Ký quỹ đơn ${b.code}`,
        bookingId: b.id,
        createdBy: actorId,
        lines: [D(userAccount(b.renter_id, 'AVAILABLE'), b.total_fee_snapshot), C(userAccount(b.renter_id, 'ESCROW'), b.total_fee_snapshot)],
      });
      q.run(
        `INSERT INTO escrows(booking_id, renter_id, companion_id, amount, status, hold_txn_id, created_at, updated_at) VALUES (?,?,?,?,'HELD',?,?,?)`,
        b.id,
        b.renter_id,
        b.companion_id,
        b.total_fee_snapshot,
        txn.id,
        now,
        now,
      );
      q.run("UPDATE slots SET status='BOOKED', held_until=NULL WHERE booking_id=?", b.id);
      const updated = transition(b, 'PENDING_COMPANION', {
        actorId,
        reason: 'Ký quỹ thành công; bắt đầu đếm ngược 180 giây',
        ledgerTxnId: txn.id,
        set: { respond_deadline: now + POLICY.COMPANION_RESPONSE_MS, held_until: null },
      });
      notify(
        b.companion_id,
        'BOOKING_REQUEST',
        'Yêu cầu đặt lịch mới',
        `Đơn ${b.code}: ${b.hours} giờ, ${b.total_fee_snapshot.toLocaleString('vi-VN')}đ. Bạn có 180 giây để trả lời.`,
        `/bookings/${b.id}`,
      );
      return { booking: updated, duplicate: false };
    },
    { bookingId },
  );
}

// Renter hủy khi chưa ký quỹ (không nạp thêm tiền) — Hình 1A bước 9a
function cancelBeforeEscrow(b, actorId, reasonCode, reasonText) {
  return tx(() => {
    const cur = getBooking(b.id);
    releaseSlots(cur.id);
    const updated = transition(cur, 'CANCELLED', { actorId, reason: reasonText, set: { cancel_reason: reasonCode, held_until: null } });
    notify(cur.renter_id, 'BOOKING_CANCELLED', 'Đã hủy yêu cầu đặt lịch', `${cur.code}: ${reasonText}. Không phát sinh ký quỹ.`, `/bookings/${cur.id}`);
    return updated;
  });
}

// Hết thời gian giữ chỗ → EXPIRED, mở lại khung giờ (Hình 1A bước 4, 8)
export function expireHolds() {
  const now = clock.now();
  const due = q.all("SELECT * FROM bookings WHERE status='AWAITING_ESCROW' AND held_until <= ?", now);
  for (const b of due) {
    tx(() => {
      releaseSlots(b.id);
      transition(b, 'EXPIRED', { reason: 'Hết thời gian giữ chỗ mà chưa ký quỹ; khung giờ tự nhả', set: { cancel_reason: 'HOLD_EXPIRED', held_until: null } });
      notify(b.renter_id, 'BOOKING_EXPIRED', 'Hết thời gian giữ chỗ', `${b.code}: khung giờ đã được mở lại. Không phát sinh ký quỹ.`, `/bookings/${b.id}`);
    });
  }
  return due.length;
}

// Thanh toán nạp tiền gắn với đơn thất bại → hủy đơn (Hình 1A bước 9b)
export function cancelForPaymentFailure(bookingId) {
  const b = getBooking(bookingId);
  if (!b || b.status !== 'AWAITING_ESCROW') return null;
  return cancelBeforeEscrow(b, null, 'PAYMENT_FAILED', 'Hủy đặt lịch do thanh toán thất bại');
}

// ---------------------------------------------------------------- Hoàn 100% Escrow (dùng cho từ chối / quá hạn / hủy sớm)
function refundFull(b, { reference, actorId, description }) {
  const esc = q.get('SELECT * FROM escrows WHERE booking_id=?', b.id);
  if (!esc || esc.status !== 'HELD') throw E.conflict('ESCROW_NOT_HELD', 'Khoản ký quỹ không ở trạng thái Đang giữ');
  const { txn } = postTransaction({
    reference,
    type: 'ESCROW_REFUND',
    description,
    bookingId: b.id,
    createdBy: actorId,
    lines: [D(userAccount(b.renter_id, 'ESCROW'), esc.amount), C(userAccount(b.renter_id, 'AVAILABLE'), esc.amount)],
  });
  q.run("UPDATE escrows SET status='REFUNDED', final_txn_id=?, updated_at=? WHERE id=?", txn.id, clock.now(), esc.id);
  return txn;
}

// ---------------------------------------------------------------- Companion phản hồi (Hình 1B)
export function respondToBooking(companion, bookingId, decision) {
  const b = getBooking(bookingId);
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (b.companion_id !== companion.id) throw E.forbidden();
  // Lệnh lặp: trả về kết quả đã có
  if (decision === 'ACCEPT' && b.status === 'ACCEPTED') return { booking: b, duplicate: true };
  if (decision === 'REJECT' && b.status === 'CANCELLED' && b.cancel_reason === 'COMPANION_REJECTED') return { booking: b, duplicate: true };
  if (b.status !== 'PENDING_COMPANION') throw E.conflict('INVALID_STATE', `Đơn đang ở trạng thái "${BOOKING_STATUS[b.status]}"`);
  const now = clock.now();
  if (now > b.respond_deadline) {
    // Quá 180 giây: xử lý quá hạn ngay (không chờ scheduler)
    try {
      timeoutBooking(b.id);
    } catch {
      /* đã có cảnh báo đối soát */
    }
    throw E.conflict('RESPONSE_WINDOW_CLOSED', 'Đã quá 180 giây, yêu cầu đã tự hủy');
  }
  if (decision === 'ACCEPT') {
    const booking = tx(() => {
      const cur = getBooking(bookingId);
      const updated = transition(cur, 'ACCEPTED', { actorId: companion.id, reason: 'Companion chấp nhận; phòng phiên chơi sẵn sàng', set: { respond_deadline: null } });
      notify(cur.renter_id, 'BOOKING_ACCEPTED', 'Companion đã chấp nhận', `${cur.code} đã được chấp nhận. Phiên chơi bắt đầu đúng giờ hẹn.`, `/bookings/${cur.id}`);
      audit(companion.id, 'BOOKING_ACCEPT', 'booking', cur.id, null);
      return updated;
    });
    return { booking, duplicate: false };
  }
  // REJECT → hoàn 100% trước, rồi mới đổi trạng thái (cùng transaction)
  const booking = runFinancial(
    'COMPANION_REJECT',
    { bookingId },
    () => {
      const cur = getBooking(bookingId);
      if (cur.status !== 'PENDING_COMPANION') throw E.conflict('INVALID_STATE', 'Đơn đã thay đổi trạng thái');
      const txn = refundFull(cur, { reference: `REFUND:${cur.id}`, actorId: companion.id, description: `Hoàn 100% ký quỹ ${cur.code} (Companion từ chối)` });
      releaseSlots(cur.id);
      const updated = transition(cur, 'CANCELLED', {
        actorId: companion.id,
        reason: 'Companion từ chối; đã hoàn 100% ký quỹ',
        ledgerTxnId: txn.id,
        set: { cancel_reason: 'COMPANION_REJECTED', respond_deadline: null },
      });
      notify(cur.renter_id, 'BOOKING_REJECTED', 'Companion từ chối', `${cur.code}: đã hoàn 100% (${cur.total_fee_snapshot.toLocaleString('vi-VN')}đ) về ví.`, `/bookings/${cur.id}`);
      return updated;
    },
    { bookingId },
  );
  return { booking, duplicate: false };
}

// Quá 180 giây không trả lời → tự hủy, trừ 3 điểm, hoàn 100% (Hình 1B bước 3–7)
export function timeoutBooking(bookingId) {
  return runFinancial(
    'COMPANION_TIMEOUT',
    { bookingId },
    () => {
      const b = getBooking(bookingId);
      if (b.status !== 'PENDING_COMPANION') return b;
      if (clock.now() <= b.respond_deadline) return b;
      const txn = refundFull(b, { reference: `REFUND:${b.id}`, description: `Hoàn 100% ký quỹ ${b.code} (Companion quá 180 giây)` });
      releaseSlots(b.id);
      const updated = transition(b, 'CANCELLED', {
        reason: 'Companion không phản hồi trong 180 giây; tự hủy, trừ 3 điểm tín nhiệm, hoàn 100%',
        ledgerTxnId: txn.id,
        set: { cancel_reason: 'COMPANION_TIMEOUT', respond_deadline: null },
      });
      addDeduction(b.companion_id, `TIMEOUT:${b.id}`, POLICY.TIMEOUT_TRUST_DEDUCTION, `Quá 180 giây không phản hồi đơn ${b.code}`);
      recalcTrust(b.companion_id, `TIMEOUT:${b.id}`, 'Quá hạn phản hồi 180 giây (−3 điểm)');
      notify(b.renter_id, 'BOOKING_TIMEOUT', 'Companion không phản hồi', `${b.code}: đã tự hủy và hoàn 100% về ví.`, `/bookings/${b.id}`);
      notify(b.companion_id, 'BOOKING_TIMEOUT', 'Bạn đã bỏ lỡ một yêu cầu', `${b.code}: quá 180 giây, bị trừ ${POLICY.TIMEOUT_TRUST_DEDUCTION} điểm tín nhiệm.`, `/bookings/${b.id}`);
      return updated;
    },
    { bookingId },
  );
}

// ---------------------------------------------------------------- Renter hủy (Hình 1C)
export function cancelPreview(b) {
  const now = clock.now();
  const total = b.total_fee_snapshot;
  if (b.status === 'AWAITING_ESCROW') return { allowed: true, rule: 'NO_ESCROW', refund: 0, companion: 0, platform: 0, note: 'Chưa ký quỹ, không phát sinh tiền' };
  if (b.status === 'PENDING_COMPANION') return { allowed: true, rule: 'FULL_REFUND_BEFORE_ACCEPT', refund: total, companion: 0, platform: 0, note: 'Companion chưa chấp nhận: hoàn 100% (DEMO_POLICY DP-05)' };
  if (b.status !== 'ACCEPTED') return { allowed: false, rule: 'NOT_CANCELLABLE', note: 'Đơn ở trạng thái này không thể hủy. Nếu phiên đã bắt đầu, hãy dùng "Báo sự cố".' };
  if (now >= b.start_at) return { allowed: false, rule: 'SESSION_STARTED', note: 'Đã đến giờ hẹn, không thể hủy thường; hãy dùng "Báo sự cố".' };
  const minutesLeft = (b.start_at - now) / 60000;
  if (minutesLeft >= POLICY.CANCEL_FULL_REFUND_MIN) return { allowed: true, rule: 'FULL_REFUND', minutesLeft, refund: total, companion: 0, platform: 0, note: 'Còn ≥ 30 phút: hoàn 100%' };
  if (minutesLeft >= POLICY.CANCEL_PARTIAL_MIN) {
    const [refund, companion] = splitPct(total, POLICY.CANCEL_PARTIAL_RENTER_PCT);
    return { allowed: true, rule: 'PARTIAL_70_30', minutesLeft, refund, companion, platform: 0, note: 'Còn 10–29 phút: hoàn 70%, Companion nhận 30%' };
  }
  const { companion, platform } = split88_12(total);
  return {
    allowed: true,
    rule: 'LATE_PENALTY',
    minutesLeft,
    refund: 0,
    companion,
    platform,
    note: 'Còn < 10 phút: phạt 100%. Phân bổ 88% Companion / 12% nền tảng là DEMO_POLICY DP-04 (chưa được PO duyệt)',
  };
}

export function cancelByRenter(renter, bookingId) {
  const b = getBooking(bookingId);
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (b.renter_id !== renter.id) throw E.forbidden();
  if (b.status === 'CANCELLED' && b.cancel_reason === 'RENTER_CANCELLED') return { booking: b, duplicate: true };
  if (b.status === 'AWAITING_ESCROW') return { booking: cancelBeforeEscrow(b, renter.id, 'RENTER_CANCELLED', 'Renter hủy trước khi ký quỹ'), duplicate: false };
  const booking = runFinancial(
    'RENTER_CANCEL',
    { bookingId, renterId: renter.id },
    () => {
      const cur = getBooking(bookingId);
      const p = cancelPreview(cur);
      if (!p.allowed) throw E.conflict(p.rule, p.note);
      const esc = q.get('SELECT * FROM escrows WHERE booking_id=?', cur.id);
      if (!esc || esc.status !== 'HELD') throw E.conflict('ESCROW_NOT_HELD', 'Khoản ký quỹ không ở trạng thái Đang giữ');
      const escrowAcc = userAccount(cur.renter_id, 'ESCROW');
      let lines;
      let escStatus;
      if (p.rule === 'FULL_REFUND' || p.rule === 'FULL_REFUND_BEFORE_ACCEPT') {
        lines = [D(escrowAcc, esc.amount), C(userAccount(cur.renter_id, 'AVAILABLE'), esc.amount)];
        escStatus = 'REFUNDED';
      } else if (p.rule === 'PARTIAL_70_30') {
        lines = [D(escrowAcc, esc.amount), C(userAccount(cur.renter_id, 'AVAILABLE'), p.refund), ...creditCompanionLines(cur.companion_id, p.companion)];
        escStatus = 'SPLIT';
      } else {
        lines = [D(escrowAcc, esc.amount), ...creditCompanionLines(cur.companion_id, p.companion), C(systemAccount('PLATFORM_REVENUE'), p.platform)];
        escStatus = 'FORFEITED';
      }
      const { txn } = postTransaction({
        reference: `CANCEL:${cur.id}`,
        type: `CANCEL_${p.rule}`,
        description: `Renter hủy ${cur.code}: ${p.note}`,
        bookingId: cur.id,
        createdBy: renter.id,
        lines,
      });
      if (p.rule === 'LATE_PENALTY') {
        q.run("INSERT INTO platform_revenue(booking_id, ledger_txn_id, kind, amount, created_at) VALUES (?,?, 'LATE_CANCEL_FEE', ?, ?)", cur.id, txn.id, p.platform, clock.now());
      }
      q.run('UPDATE escrows SET status=?, final_txn_id=?, updated_at=? WHERE id=?', escStatus, txn.id, clock.now(), esc.id);
      releaseSlots(cur.id);
      const updated = transition(cur, 'CANCELLED', {
        actorId: renter.id,
        reason: `Renter hủy – ${p.note}`,
        ledgerTxnId: txn.id,
        set: { cancel_reason: 'RENTER_CANCELLED', respond_deadline: null },
      });
      recalcTrust(cur.renter_id, `CANCEL:${cur.id}`, 'Renter hủy đơn');
      const vnd = (n) => `${n.toLocaleString('vi-VN')}đ`;
      notify(cur.renter_id, 'BOOKING_CANCELLED', 'Đã hủy đơn', `${cur.code}: hoàn ${vnd(p.refund)} về ví.`, `/bookings/${cur.id}`);
      notify(cur.companion_id, 'BOOKING_CANCELLED', 'Renter đã hủy đơn', `${cur.code}: bạn nhận ${vnd(p.companion)}.`, `/bookings/${cur.id}`);
      audit(renter.id, 'BOOKING_CANCEL', 'booking', cur.id, p);
      return updated;
    },
    { bookingId },
  );
  return { booking, duplicate: false };
}

// ---------------------------------------------------------------- Session (Hình 2A)
export function startDueSessions() {
  const now = clock.now();
  const due = q.all("SELECT * FROM bookings WHERE status='ACCEPTED' AND start_at <= ?", now);
  for (const b of due) {
    tx(() => {
      q.run(
        "INSERT OR IGNORE INTO play_sessions(booking_id, status, started_at, scheduled_end_at) VALUES (?, 'ACTIVE', ?, ?)",
        b.id,
        Math.max(b.start_at, Math.min(now, b.end_at)),
        b.end_at,
      );
      transition(b, 'IN_SESSION', { reason: 'Đến giờ hẹn: bắt đầu phiên chơi, mở phòng chat/thoại' });
      q.run('INSERT INTO session_events(booking_id, type, detail, created_at) VALUES (?,?,?,?)', b.id, 'SESSION_STARTED', null, now);
      for (const u of [b.renter_id, b.companion_id]) notify(u, 'SESSION_STARTED', 'Phiên chơi đã bắt đầu', `${b.code}: vào phòng để trò chuyện.`, `/bookings/${b.id}`);
    });
  }
  return due.length;
}

export function endDueSessions() {
  const now = clock.now();
  const due = q.all("SELECT * FROM bookings WHERE status='IN_SESSION' AND end_at <= ?", now);
  for (const b of due) {
    tx(() => {
      q.run("UPDATE play_sessions SET status='ENDED', ended_at=? WHERE booking_id=? AND status='ACTIVE'", b.end_at, b.id);
      transition(b, 'AWAITING_CONFIRMATION', {
        reason: 'Hết thời lượng thuê: đóng phòng, yêu cầu Renter nghiệm thu trong 15 phút',
        set: { confirm_deadline: b.end_at + POLICY.CONFIRM_WINDOW_MS },
      });
      q.run('INSERT INTO session_events(booking_id, type, detail, created_at) VALUES (?,?,?,?)', b.id, 'SESSION_ENDED', null, now);
      notify(b.renter_id, 'CONFIRM_REQUIRED', 'Hãy nghiệm thu phiên chơi', `${b.code}: chọn "Hoàn tất" hoặc "Báo sự cố" trong 15 phút.`, `/bookings/${b.id}`);
      notify(b.companion_id, 'SESSION_ENDED', 'Phiên chơi đã kết thúc', `${b.code}: đang chờ Renter nghiệm thu.`, `/bookings/${b.id}`);
    });
  }
  return due.length;
}

// Giải ngân 88/12 (Hình 2B bước 1–3). Chỉ khi Escrow đang HELD (không có tranh chấp).
export function settleBooking(bookingId, { actorId = null, reason }) {
  return runFinancial(
    'SETTLE',
    { bookingId },
    () => {
      const b = getBooking(bookingId);
      if (b.status === 'COMPLETED') return b; // lệnh lặp
      if (b.status !== 'AWAITING_CONFIRMATION') throw E.conflict('INVALID_STATE', `Đơn đang ở trạng thái "${BOOKING_STATUS[b.status]}", không thể giải ngân`);
      const esc = q.get('SELECT * FROM escrows WHERE booking_id=?', b.id);
      if (esc.status === 'FROZEN') throw E.conflict('DISPUTE_OPEN', 'Tiền đang bị đóng băng do khiếu nại');
      if (esc.status !== 'HELD') throw E.conflict('ESCROW_NOT_HELD', 'Khoản ký quỹ không ở trạng thái Đang giữ');
      const { companion, platform } = split88_12(esc.amount);
      const { txn } = postTransaction({
        reference: `SETTLE:${b.id}`,
        type: 'ESCROW_RELEASE',
        description: `Giải ngân ${b.code}: 88% Companion / 12% nền tảng`,
        bookingId: b.id,
        createdBy: actorId,
        lines: [D(userAccount(b.renter_id, 'ESCROW'), esc.amount), ...creditCompanionLines(b.companion_id, companion), C(systemAccount('PLATFORM_REVENUE'), platform)],
      });
      q.run("INSERT INTO platform_revenue(booking_id, ledger_txn_id, kind, amount, created_at) VALUES (?,?, 'COMMISSION', ?, ?)", b.id, txn.id, platform, clock.now());
      q.run("UPDATE escrows SET status='RELEASED', final_txn_id=?, updated_at=? WHERE id=?", txn.id, clock.now(), esc.id);
      const updated = transition(b, 'COMPLETED', { actorId, reason, ledgerTxnId: txn.id, set: { confirm_deadline: null } });
      recalcTrust(b.companion_id, `COMPLETE:${b.id}`, 'Hoàn tất phiên chơi');
      recalcTrust(b.renter_id, `COMPLETE:${b.id}`, 'Hoàn tất phiên chơi');
      notify(b.companion_id, 'PAYOUT', 'Đã giải ngân', `${b.code}: +${companion.toLocaleString('vi-VN')}đ (88%) vào ví.`, `/bookings/${b.id}`);
      notify(b.renter_id, 'BOOKING_COMPLETED', 'Đơn hoàn tất', `${b.code} đã hoàn tất. Hãy để lại đánh giá!`, `/bookings/${b.id}`);
      return updated;
    },
    { bookingId },
  );
}

export function confirmCompletion(renter, bookingId) {
  const b = getBooking(bookingId);
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (b.renter_id !== renter.id) throw E.forbidden();
  if (b.status === 'COMPLETED') return { booking: b, duplicate: true };
  if (b.status !== 'AWAITING_CONFIRMATION') throw E.conflict('INVALID_STATE', `Đơn đang ở trạng thái "${BOOKING_STATUS[b.status]}"`);
  return { booking: settleBooking(bookingId, { actorId: renter.id, reason: 'Renter nghiệm thu: Hoàn tất' }), duplicate: false };
}

export function autoConfirmDue() {
  if (!POLICY.AUTO_CONFIRM_ON_TIMEOUT) return 0;
  const now = clock.now();
  const due = q.all(
    `SELECT b.* FROM bookings b WHERE b.status='AWAITING_CONFIRMATION' AND b.confirm_deadline < ?
       AND NOT EXISTS (SELECT 1 FROM ops_alerts a WHERE a.booking_id=b.id AND a.status='OPEN' AND a.operation='SETTLE')`,
    now,
  );
  let n = 0;
  for (const b of due) {
    try {
      settleBooking(b.id, { reason: 'Quá 15 phút không phản hồi: tự động nghiệm thu (DEMO_POLICY DP-03)' });
      n++;
    } catch (e) {
      if (!(e instanceof LedgerError)) console.error('[autoConfirm]', e.message);
    }
  }
  return n;
}

export function timeoutDue() {
  const now = clock.now();
  const due = q.all(
    `SELECT b.id FROM bookings b WHERE b.status='PENDING_COMPANION' AND b.respond_deadline < ?
       AND NOT EXISTS (SELECT 1 FROM ops_alerts a WHERE a.booking_id=b.id AND a.status='OPEN' AND a.operation='COMPANION_TIMEOUT')`,
    now,
  );
  let n = 0;
  for (const b of due) {
    try {
      timeoutBooking(b.id);
      n++;
    } catch (e) {
      if (!(e instanceof LedgerError)) console.error('[timeout]', e.message);
    }
  }
  return n;
}

// ---------------------------------------------------------------- Đọc dữ liệu
export function canViewBooking(user, b) {
  return b.renter_id === user.id || b.companion_id === user.id || user.role === 'CS' || user.role === 'ADMIN';
}

export function bookingDetail(b, viewer) {
  const game = q.get('SELECT id, name, code FROM games WHERE id=?', b.game_id);
  const renter = q.get('SELECT id, display_name, trust_score FROM users WHERE id=?', b.renter_id);
  const companion = q.get(
    'SELECT u.id, u.display_name, u.trust_score, p.avatar_hue FROM users u LEFT JOIN companion_profiles p ON p.user_id=u.id WHERE u.id=?',
    b.companion_id,
  );
  const history = q.all(
    `SELECT h.*, u.display_name AS actor_name FROM booking_status_history h LEFT JOIN users u ON u.id=h.actor_id WHERE booking_id=? ORDER BY h.id`,
    b.id,
  );
  const escrow = q.get('SELECT * FROM escrows WHERE booking_id=?', b.id);
  const txns = q.all('SELECT id, reference, type, description, created_at FROM ledger_transactions WHERE booking_id=? ORDER BY id', b.id);
  for (const t of txns) {
    t.entries = q.all(
      `SELECT e.direction, e.amount, a.type AS account_type, a.user_id,
              CASE WHEN a.user_id IS NULL THEN a.code ELSE (SELECT display_name FROM users WHERE id=a.user_id) END AS owner
         FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE e.txn_id=? ORDER BY e.id`,
      t.id,
    );
  }
  const session = q.get('SELECT * FROM play_sessions WHERE booking_id=?', b.id);
  const dispute = q.get('SELECT id, status, reason, fault_percent, decision_reason, decided_at, evidence_deadline, created_at FROM disputes WHERE booking_id=?', b.id);
  const reviews = q.all('SELECT r.*, u.display_name AS reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id WHERE booking_id=?', b.id);
  const isParty = viewer.id === b.renter_id || viewer.id === b.companion_id;
  return {
    ...b,
    request_hash: undefined,
    status_label: BOOKING_STATUS[b.status],
    game,
    renter,
    companion,
    history,
    escrow,
    transactions: txns,
    session,
    dispute,
    reviews,
    cancelPreview: viewer.id === b.renter_id ? cancelPreview(b) : null,
    serverNow: clock.now(),
    viewerRole: viewer.id === b.renter_id ? 'RENTER' : viewer.id === b.companion_id ? 'COMPANION' : viewer.role,
    isParty,
    myReview: reviews.find((r) => r.reviewer_id === viewer.id) || null,
  };
}
