// Phòng phiên chơi: chat real-time (SSE) + tín hiệu WebRTC Voice (P2P, server chỉ chuyển tiếp offer/answer/ICE).
// Không ghi âm (DEFERRED). Chỉ hai bên của đơn được vào; CS/Admin chỉ xem nhật ký khi đơn có khiếu nại.
import { q } from '../db.js';
import { clock } from '../clock.js';
import { E } from '../errors.js';
import { filterChat } from '../util.js';
import { getBooking } from './bookings.js';
import { pushToUser, isOnline } from './realtime.js';

export function canReadRoom(user, b) {
  if (b.renter_id === user.id || b.companion_id === user.id) return true;
  if (user.role === 'CS' || user.role === 'ADMIN') return Boolean(q.get('SELECT 1 FROM disputes WHERE booking_id=?', b.id));
  return false;
}

export function roomInfo(user, bookingId) {
  const b = getBooking(bookingId);
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (!canReadRoom(user, b)) throw E.forbidden('Bạn không thuộc phiên dịch vụ này');
  const messages = q.all(
    `SELECT m.id, m.sender_id, u.display_name AS sender_name, m.body, m.flagged, m.created_at
       FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.booking_id=? ORDER BY m.id LIMIT 500`,
    b.id,
  );
  const otherId = user.id === b.renter_id ? b.companion_id : b.renter_id;
  return {
    bookingId: b.id,
    status: b.status,
    open: b.status === 'IN_SESSION',
    messages,
    otherOnline: isOnline(otherId),
    session: q.get('SELECT * FROM play_sessions WHERE booking_id=?', b.id),
    serverNow: clock.now(),
  };
}

function requireOpenRoom(user, bookingId) {
  const b = getBooking(bookingId);
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (b.renter_id !== user.id && b.companion_id !== user.id) throw E.forbidden('Bạn không thuộc phiên dịch vụ này');
  if (b.status !== 'IN_SESSION') throw E.conflict('ROOM_CLOSED', 'Phòng chỉ mở trong thời gian phiên chơi');
  return b;
}

export function sendMessage(user, bookingId, body) {
  const b = requireOpenRoom(user, bookingId);
  const text = String(body || '').trim();
  if (!text) throw E.badRequest('EMPTY_MESSAGE', 'Tin nhắn trống');
  if (text.length > 1000) throw E.badRequest('MESSAGE_TOO_LONG', 'Tin nhắn tối đa 1000 ký tự');
  const { text: clean, flagged } = filterChat(text);
  const now = clock.now();
  const r = q.run('INSERT INTO messages(booking_id, sender_id, body, flagged, created_at) VALUES (?,?,?,?,?)', b.id, user.id, clean, flagged ? 1 : 0, now);
  const msg = { id: Number(r.lastInsertRowid), booking_id: b.id, sender_id: user.id, sender_name: user.display_name, body: clean, flagged: flagged ? 1 : 0, created_at: now };
  if (flagged) q.run('INSERT INTO session_events(booking_id, user_id, type, detail, created_at) VALUES (?,?,?,?,?)', b.id, user.id, 'MESSAGE_FILTERED', 'Đã ẩn thông tin liên lạc ngoài nền tảng', now);
  for (const uid of [b.renter_id, b.companion_id]) pushToUser(uid, 'chat', msg);
  return msg;
}

const RTC_TYPES = new Set(['call-request', 'call-accept', 'call-decline', 'offer', 'answer', 'ice', 'hangup']);
export function relaySignal(user, bookingId, { type, data }) {
  const b = requireOpenRoom(user, bookingId);
  if (!RTC_TYPES.has(type)) throw E.badRequest('INVALID_SIGNAL', 'Loại tín hiệu không hợp lệ');
  const to = user.id === b.renter_id ? b.companion_id : b.renter_id;
  if (['call-request', 'call-accept', 'hangup', 'call-decline'].includes(type)) {
    q.run('INSERT INTO session_events(booking_id, user_id, type, detail, created_at) VALUES (?,?,?,?,?)', b.id, user.id, `VOICE_${type.toUpperCase().replace('-', '_')}`, null, clock.now());
  }
  const delivered = pushToUser(to, 'rtc', { bookingId: b.id, from: user.id, type, data });
  return { delivered: delivered > 0 };
}

export function logConnection(user, bookingId, type) {
  const b = getBooking(bookingId);
  if (!b || (b.renter_id !== user.id && b.companion_id !== user.id)) return;
  if (b.status !== 'IN_SESSION') return;
  q.run('INSERT INTO session_events(booking_id, user_id, type, detail, created_at) VALUES (?,?,?,?,?)', b.id, user.id, type, null, clock.now());
}
