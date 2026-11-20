import { q, onCommit } from '../db.js';
import { clock } from '../clock.js';
import { json } from '../util.js';
import { pushToUser } from './realtime.js';

export function audit(actorId, action, entity, entityId, data) {
  q.run(
    'INSERT INTO audit_logs(actor_id, action, entity, entity_id, data, created_at) VALUES (?,?,?,?,?,?)',
    actorId ?? null,
    action,
    entity,
    entityId ?? null,
    json(data),
    clock.now(),
  );
}

export function notify(userId, type, title, body, link = null) {
  const r = q.run(
    'INSERT INTO notifications(user_id, type, title, body, link, created_at) VALUES (?,?,?,?,?,?)',
    userId,
    type,
    title,
    body,
    link,
    clock.now(),
  );
  const n = { id: Number(r.lastInsertRowid), type, title, body, link, created_at: clock.now(), read_at: null };
  onCommit(() => pushToUser(userId, 'notification', n));
}

export function notifyRole(roles, type, title, body, link) {
  const users = q.all(
    `SELECT id FROM users WHERE role IN (${roles.map(() => '?').join(',')}) AND status='ACTIVE'`,
    ...roles,
  );
  for (const u of users) notify(u.id, type, title, body, link);
}

// Báo client (bên liên quan) tải lại booking — sau khi commit.
export function pushBookingUpdate(booking) {
  const data = { bookingId: booking.id, status: booking.status };
  onCommit(() => {
    pushToUser(booking.renter_id, 'booking', data);
    pushToUser(booking.companion_id, 'booking', data);
  });
}

export function getSetting(key, def = null) {
  const r = q.get('SELECT value FROM settings WHERE key=?', key);
  return r ? r.value : def;
}
export function setSetting(key, value) {
  q.run(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    key,
    String(value),
  );
}

// Cảnh báo đối soát (BPMN: "gửi cảnh báo cho bộ phận đối soát", "chờ kiểm toán viên xử lý").
// Gọi NGOÀI transaction đã rollback để cảnh báo luôn được lưu.
export function raiseOpsAlert({ kind, bookingId = null, operation, payload, error }) {
  const r = q.run(
    'INSERT INTO ops_alerts(kind, booking_id, operation, payload, error, created_at) VALUES (?,?,?,?,?,?)',
    kind,
    bookingId,
    operation,
    json(payload),
    String(error),
    clock.now(),
  );
  notifyRole(['ADMIN'], 'OPS_ALERT', 'Cảnh báo đối soát', `Ghi sổ thất bại: ${operation}`, '/admin/ops');
  console.warn(`[ops-alert] ${kind} ${operation}: ${error}`);
  return Number(r.lastInsertRowid);
}
