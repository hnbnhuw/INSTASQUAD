// TrustScore (BPMN Hình 2B bước 7a/7b):
// Điểm = 0,40 × rating(thang 100) + 0,40 × tỷ lệ hoàn thành(%) − 1,20 × tỷ lệ bị khiếu nại(%) − tổng điểm trừ trực tiếp, giới hạn 0..100.
// Dưới 40 điểm → tạm khóa. Quy ước đổi thang & mẫu số: DEMO_POLICY DP-08.
import { q } from '../db.js';
import { clock } from '../clock.js';
import { POLICY } from '../policy.js';
import { json } from '../util.js';
import { notify } from './common.js';

const COMPLETED = "('COMPLETED','RESOLVED_RELEASED')";

export function trustInputs(userId) {
  const user = q.get('SELECT id, role FROM users WHERE id=?', userId);
  const r = q.get('SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE reviewee_id=?', userId);
  const ratingAvg = r.n ? r.avg : 5; // chưa có đánh giá → coi như 5 sao (DP-08)
  const rating100 = (ratingAvg / 5) * 100;
  let completed = 0;
  let failed = 0;
  let sessions = 0;
  let complaints = 0;
  if (user.role === 'COMPANION') {
    completed = q.get(`SELECT COUNT(*) n FROM bookings WHERE companion_id=? AND status IN ${COMPLETED}`, userId).n;
    failed = q.get(
      `SELECT COUNT(*) n FROM bookings WHERE companion_id=? AND (cancel_reason='COMPANION_TIMEOUT' OR status='RESOLVED_REFUNDED')`,
      userId,
    ).n;
    sessions = q.get(
      `SELECT COUNT(*) n FROM bookings WHERE companion_id=? AND status IN ('COMPLETED','RESOLVED_RELEASED','RESOLVED_REFUNDED','DISPUTED')`,
      userId,
    ).n;
    complaints = q.get('SELECT COUNT(*) n FROM disputes d JOIN bookings b ON b.id=d.booking_id WHERE b.companion_id=?', userId).n;
  } else {
    completed = q.get(`SELECT COUNT(*) n FROM bookings WHERE renter_id=? AND status IN ('COMPLETED','RESOLVED_RELEASED','RESOLVED_REFUNDED')`, userId).n;
    // Renter "không hoàn thành": tự hủy sau khi đã ký quỹ.
    failed = q.get(
      `SELECT COUNT(*) n FROM bookings WHERE renter_id=? AND cancel_reason='RENTER_CANCELLED' AND EXISTS(SELECT 1 FROM escrows e WHERE e.booking_id=bookings.id)`,
      userId,
    ).n;
    sessions = 0;
    complaints = 0; // nguồn chưa định nghĩa khiếu nại đối với Renter (DP-08)
  }
  // DP-08: làm mượt bằng PRIOR đơn "ảo" hoàn thành tốt để vài đơn đầu không làm điểm dao động cực đoan
  const P = POLICY.TRUST_PRIOR_BOOKINGS;
  const completionRate = ((completed + P) / (completed + failed + P)) * 100;
  const complaintRate = (complaints / (sessions + P)) * 100;
  const deductions = q.get('SELECT COALESCE(SUM(points),0) s FROM trust_deductions WHERE user_id=?', userId).s;
  return {
    ratingAvg: Math.round(ratingAvg * 100) / 100,
    ratingCount: r.n,
    rating100: Math.round(rating100 * 100) / 100,
    completed,
    failed,
    completionRate: Math.round(completionRate * 100) / 100,
    sessions,
    complaints,
    complaintRate: Math.round(complaintRate * 100) / 100,
    deductions,
  };
}

export function computeTrust(i) {
  const w = POLICY.TRUST_WEIGHTS;
  const raw = w.rating * i.rating100 + w.completion * i.completionRate - w.complaint * i.complaintRate - i.deductions;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// Trừ điểm trực tiếp (vd quá 180 giây: −3). ref duy nhất ⇒ phát lại sự kiện không trừ hai lần.
export function addDeduction(userId, ref, points, reason) {
  q.run(
    'INSERT OR IGNORE INTO trust_deductions(user_id, ref, points, reason, created_at) VALUES (?,?,?,?,?)',
    userId,
    ref,
    points,
    reason,
    clock.now(),
  );
}

// Tính lại điểm. Idempotent theo (userId, eventRef). Phải gọi trong tx của sự kiện gốc.
export function recalcTrust(userId, eventRef, reason) {
  const done = q.get('SELECT new_score FROM trust_score_logs WHERE user_id=? AND event_ref=?', userId, eventRef);
  if (done) return done.new_score;
  const user = q.get('SELECT id, role, trust_score FROM users WHERE id=?', userId);
  const inputs = trustInputs(userId);
  const score = computeTrust(inputs);
  q.run('UPDATE users SET trust_score=? WHERE id=?', score, userId);
  q.run(
    'INSERT INTO trust_score_logs(user_id, event_ref, old_score, new_score, reason, inputs, created_at) VALUES (?,?,?,?,?,?,?)',
    userId,
    eventRef,
    user.trust_score,
    score,
    reason,
    json(inputs),
    clock.now(),
  );
  if (user.role === 'COMPANION') {
    const p = q.get('SELECT status FROM companion_profiles WHERE user_id=?', userId);
    if (p && score < POLICY.TRUST_LOCK_THRESHOLD && p.status === 'ACTIVE') {
      q.run("UPDATE companion_profiles SET status='SUSPENDED' WHERE user_id=?", userId);
      notify(userId, 'TRUST_LOCK', 'Hồ sơ bị tạm khóa', `Điểm tín nhiệm ${score} < ${POLICY.TRUST_LOCK_THRESHOLD}. Hồ sơ tạm ẩn khỏi tìm kiếm.`, '/companion');
    } else if (p && score >= POLICY.TRUST_LOCK_THRESHOLD && p.status === 'SUSPENDED') {
      q.run("UPDATE companion_profiles SET status='ACTIVE' WHERE user_id=?", userId);
    }
  }
  return score;
}
