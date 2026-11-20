// Tiện ích HTTP: xác thực, phân quyền, validate (zod), xử lý lỗi thống nhất.
import { z } from 'zod';
import { AppError, E } from './errors.js';
import { userFromToken } from './services/users.js';

export const COOKIE = 'isq_session';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function attachUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.token = token;
  req.user = userFromToken(token);
  next();
}

export const requireAuth = (req, _res, next) => (req.user ? next() : next(E.unauthorized()));
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(E.unauthorized());
    if (!roles.includes(req.user.role)) return next(E.forbidden());
    next();
  };

// Validate body/query bằng zod; lỗi trả 400 kèm chi tiết từng trường
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw E.badRequest(
      'VALIDATION_ERROR',
      'Dữ liệu không hợp lệ',
      r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};

export const id = z.coerce.number().int().positive();
export const idemKey = z.string().trim().min(8, 'Mã idempotency tối thiểu 8 ký tự').max(80);

export function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'JSON không hợp lệ' } });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Dữ liệu gửi lên quá lớn' } });
  if (err instanceof AppError) {
    if (err.status >= 500) console.error(`[${err.code}] ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, alertId: err.alertId } });
  }
  // Lỗi ràng buộc DB (unique...) → 409, không lộ chi tiết nội bộ
  if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE|constraint/i.test(err.message)) {
    return res.status(409).json({ error: { code: 'CONSTRAINT_VIOLATION', message: 'Dữ liệu bị trùng hoặc vi phạm ràng buộc' } });
  }
  console.error(`[500] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống, vui lòng thử lại' } });
}
