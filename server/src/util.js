import crypto from 'node:crypto';
import { config } from './config.js';
import { POLICY } from './policy.js';

// ---- Mật khẩu: scrypt (chuẩn của Node), salt ngẫu nhiên, so sánh hằng thời gian ----
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

// ---- AES-256-GCM cho dữ liệu nhạy cảm (NFR-002) ----
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.DATA_KEY, iv);
  const data = Buffer.concat([c.update(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
export function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', config.DATA_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
export const encryptText = (s) => encrypt(s).toString('base64');
export const decryptText = (s) => decrypt(Buffer.from(s, 'base64')).toString('utf8');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ---- Tiền: số nguyên VND, chia theo phần trăm với phần dư dồn cho bên còn lại để bảo toàn tổng ----
export function assertVnd(n, name = 'amount') {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} phải là số nguyên VND dương`);
}
// Trả về [phần pct%, phần còn lại]; phần pct làm tròn xuống, tổng luôn = amount.
export function splitPct(amount, pct) {
  assertVnd(amount);
  const a = Math.floor((amount * pct) / 100);
  return [a, amount - a];
}
// 88/12: phí nền tảng = floor(12%), Companion nhận phần còn lại (DEMO_POLICY DP-10)
export function split88_12(amount) {
  const [platform, companion] = splitPct(amount, POLICY.PLATFORM_FEE_PCT);
  return { companion, platform };
}

// ---- Ngày theo giờ Việt Nam (DEMO_POLICY DP-09) ----
export function vnDayKey(ms) {
  const d = new Date(ms + POLICY.TIMEZONE_OFFSET_MIN * 60000);
  return d.toISOString().slice(0, 10);
}
export function vnDayStart(dayKey) {
  return Date.parse(`${dayKey}T00:00:00Z`) - POLICY.TIMEZONE_OFFSET_MIN * 60000;
}

export const json = (v) => JSON.stringify(v ?? null);
export const parseJson = (s, d = null) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};

export function bookingCode(id) {
  return `BK${String(id).padStart(6, '0')}`;
}

// Che thông tin liên lạc ngoài nền tảng trong chat (BPMN Luồng 2: chặn SĐT, đường dẫn, số tài khoản)
const PATTERNS = [
  /\b(?:https?:\/\/|www\.)\S+/gi,
  /\b[a-z0-9-]+\.(?:com|net|vn|org|io|gg|me|xyz|info)(?:\/\S*)?\b/gi,
  /(?:\+?84|0)(?:[\s.-]?\d){9,10}\b/g,
  /\b\d(?:[\s.-]?\d){8,18}\b/g, // chuỗi 9–19 chữ số: số tài khoản/thẻ
];
export function filterChat(text) {
  let flagged = false;
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, () => {
      flagged = true;
      return '[đã ẩn]';
    });
  }
  return { text: out, flagged };
}
