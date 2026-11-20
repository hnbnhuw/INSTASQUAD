// Đánh giá hai chiều sau phiên (BPMN Hình 2B bước 5–7). Mỗi người chỉ đánh giá 1 lần/đơn; không ảnh hưởng quyết toán tiền.
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { E } from '../errors.js';
import { audit, notify } from './common.js';
import { getBooking } from './bookings.js';
import { recalcTrust } from './trust.js';

const REVIEWABLE = ['COMPLETED', 'RESOLVED_RELEASED', 'RESOLVED_REFUNDED'];

export function createReview(user, bookingId, { rating, comment = '' }) {
  const b = getBooking(bookingId);
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (b.renter_id !== user.id && b.companion_id !== user.id) throw E.forbidden('Chỉ người tham gia đơn mới được đánh giá');
  if (!REVIEWABLE.includes(b.status)) throw E.conflict('NOT_REVIEWABLE', 'Chỉ đánh giá được sau khi đơn đã hoàn tất');
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw E.badRequest('INVALID_RATING', 'Điểm đánh giá từ 1 đến 5 sao');
  const revieweeId = b.renter_id === user.id ? b.companion_id : b.renter_id;
  return tx(() => {
    if (q.get('SELECT 1 FROM reviews WHERE booking_id=? AND reviewer_id=?', b.id, user.id)) {
      throw E.conflict('ALREADY_REVIEWED', 'Bạn đã đánh giá đơn này');
    }
    const r = q.run(
      'INSERT INTO reviews(booking_id, reviewer_id, reviewee_id, rating, comment, created_at) VALUES (?,?,?,?,?,?)',
      b.id,
      user.id,
      revieweeId,
      rating,
      comment.slice(0, 1000),
      clock.now(),
    );
    const id = Number(r.lastInsertRowid);
    const score = recalcTrust(revieweeId, `REVIEW:${id}`, `Nhận đánh giá ${rating} sao (đơn ${b.code})`);
    notify(revieweeId, 'REVIEW', 'Bạn nhận được đánh giá mới', `${b.code}: ${rating}★. Điểm tín nhiệm hiện tại: ${score}.`, `/bookings/${b.id}`);
    audit(user.id, 'REVIEW_CREATE', 'review', id, { bookingId: b.id, rating });
    return q.get('SELECT * FROM reviews WHERE id=?', id);
  });
}
