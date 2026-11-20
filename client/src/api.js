// Gọi API backend. Lỗi nghiệp vụ được ném ra dạng ApiError { status, code, message, details }.
let skew = 0; // serverNow - Date.now() (đồng hồ server là nguồn quyết định, kể cả khi demo dịch thời gian)

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Lỗi ${status}`);
    this.status = status;
    this.code = body?.error?.code || 'HTTP_ERROR';
    this.details = body?.error?.details;
    this.alertId = body?.error?.alertId;
  }
}

function trackClock(data) {
  if (data && typeof data === 'object' && typeof data.serverNow === 'number') skew = data.serverNow - Date.now();
  if (data?.booking?.serverNow) skew = data.booking.serverNow - Date.now();
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let res;
  const payload = body !== undefined ? body : method === 'GET' ? undefined : {};
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Không kết nối được máy chủ. Kiểm tra backend đã chạy chưa.' } });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  trackClock(data);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}, headers) => api(p, { method: 'POST', body, headers });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

export const serverNow = () => Date.now() + skew;
export const setServerNow = (t) => {
  skew = t - Date.now();
};

export const newKey = (prefix = 'k') => `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('')}`;

// ---- Định dạng ----
const TZ = 'Asia/Ho_Chi_Minh';
export const vnd = (n) => (n == null ? '—' : `${Number(n).toLocaleString('vi-VN')}đ`);
export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
export const fmtHour = (ms) => new Date(ms).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
export const fmtDay = (ms) => new Date(ms).toLocaleDateString('vi-VN', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
export const dayKey = (ms) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);

export const BOOKING_LABEL = {
  AWAITING_ESCROW: 'Giữ chỗ – chờ ký quỹ',
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
export const CANCEL_REASON = {
  COMPANION_REJECTED: 'Companion từ chối',
  COMPANION_TIMEOUT: 'Companion không phản hồi trong 180 giây',
  RENTER_CANCELLED: 'Renter hủy',
  PAYMENT_FAILED: 'Thanh toán thất bại',
  HOLD_EXPIRED: 'Hết thời gian giữ chỗ',
};
export const ESCROW_LABEL = { HELD: 'Đang giữ', FROZEN: 'Đóng băng', RELEASED: 'Đã giải ngân', REFUNDED: 'Đã hoàn', SPLIT: 'Đã chia (hủy 70/30)', FORFEITED: 'Bị phạt (hủy muộn)' };
export const ACCOUNT_LABEL = { AVAILABLE: 'Khả dụng', ESCROW: 'Ký quỹ', FROZEN: 'Đóng băng', WITHDRAW_HOLD: 'Chờ rút', RECEIVABLE: 'Nợ phạt' };
export const ROLE_LABEL = { RENTER: 'Renter', COMPANION: 'Companion', CS: 'CS Agent', ADMIN: 'Admin' };
export const KYC_LABEL = { NONE: 'Chưa xác thực', PENDING: 'Đang xử lý', VERIFIED: 'Đã xác thực', REJECTED: 'Bị từ chối', NEEDS_MORE_INFO: 'Cần bổ sung' };
