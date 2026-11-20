// Tham số nghiệp vụ. Nhãn: SOURCE = có trong tài liệu nguồn (BPMN/Requirements);
// DEMO_POLICY = quy ước của nhóm để demo, CHƯA được PO duyệt (xem docs/DEMO_POLICY.md).
export const POLICY = {
  // SOURCE (BPMN Hình 1A–1C)
  COMPANION_RESPONSE_MS: 180 * 1000, // Companion có 180 giây để trả lời
  MAX_HOURS_PER_DAY: 10, // mỗi Companion nhận tối đa 10 giờ/ngày
  CANCEL_FULL_REFUND_MIN: 30, // >= 30 phút: hoàn 100%
  CANCEL_PARTIAL_MIN: 10, // 10–29 phút: hoàn 70% / 30% cho Companion
  CANCEL_PARTIAL_RENTER_PCT: 70,
  // SOURCE (BPMN Hình 2A–2C)
  CONFIRM_WINDOW_MS: 15 * 60 * 1000, // Renter có 15 phút nghiệm thu
  COMPANION_SHARE_PCT: 88,
  PLATFORM_FEE_PCT: 12,
  DISPUTE_FAULT_THRESHOLD: 80, // lỗi Companion >= 80% → hoàn 100% + phạt 20%
  DISPUTE_PENALTY_PCT: 20,
  TIMEOUT_TRUST_DEDUCTION: 3, // quá 180 giây → trừ 3 điểm tín nhiệm
  TRUST_LOCK_THRESHOLD: 40, // dưới 40 điểm → tạm khóa
  TRUST_WEIGHTS: { rating: 0.4, completion: 0.4, complaint: 1.2 },

  // DEMO_POLICY
  SLOT_HOLD_MS: 10 * 60 * 1000, // DP-01: giữ chỗ 10 phút, KHÔNG gia hạn khi payment pending
  PAYMENT_PENDING_TTL_MS: 15 * 60 * 1000, // DP-02: payment PENDING quá 15 phút → EXPIRED
  AUTO_CONFIRM_ON_TIMEOUT: true, // DP-03: hết 15 phút không phản hồi → tự nghiệm thu (đề xuất nhóm trong BPMN)
  LATE_CANCEL_SPLIT: 'SETTLE_88_12', // DP-04: hủy < 10 phút → phạt 100%, chia như hoàn tất 88/12
  EVIDENCE_WINDOW_MS: 24 * 60 * 60 * 1000, // DP-07: hạn bổ sung chứng cứ 24 giờ
  TRUST_PRIOR_BOOKINGS: 10, // DP-08: làm mượt tỷ lệ hoàn thành/khiếu nại bằng 10 đơn ảo
  TIMEZONE_OFFSET_MIN: 7 * 60, // DP-09: "ngày" tính theo giờ Việt Nam (UTC+7)
  MIN_TOPUP: 10_000,
  MAX_TOPUP: 50_000_000,
  MIN_WITHDRAW: 50_000,
  MIN_HOURLY_RATE: 10_000,
  MAX_HOURLY_RATE: 2_000_000,
  MAX_BOOKING_HOURS: 5,
  MAX_EVIDENCE_BYTES: 2 * 1024 * 1024,
  EVIDENCE_MIME: ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'],
  SLOT_MS: 60 * 60 * 1000, // slot rời rạc 1 giờ
};
