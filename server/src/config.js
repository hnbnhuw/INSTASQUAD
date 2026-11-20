// Đọc và kiểm tra biến môi trường khi khởi động (fail-fast).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..');

// Nạp server/.env nếu có (định dạng KEY=VALUE, không cần thư viện dotenv).
function loadDotEnv() {
  const file = path.join(SERVER_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const env = process.env;
const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

function requireHexKey(name, fallbackForDev) {
  const v = env[name];
  if (v) {
    if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} phải là 64 ký tự hex (32 byte)`);
    return Buffer.from(v, 'hex');
  }
  if (isProd) throw new Error(`Thiếu biến môi trường ${name} trong production`);
  return crypto.createHash('sha256').update(fallbackForDev).digest();
}

export const config = {
  NODE_ENV,
  isProd,
  isTest: NODE_ENV === 'test',
  PORT: Number(env.PORT || 4000),
  DB_FILE: env.DB_FILE || path.join(SERVER_ROOT, 'data', 'instasquad.db'),
  UPLOAD_DIR: env.UPLOAD_DIR || path.join(SERVER_ROOT, 'data', 'uploads'),
  // Khóa AES-256 cho dữ liệu eKYC/bằng chứng (NFR-002). Dev dùng khóa dẫn xuất cố định, prod bắt buộc cấu hình.
  DATA_KEY: requireHexKey('DATA_ENCRYPTION_KEY', 'instasquad-dev-data-key'),
  // Bí mật ký callback của cổng thanh toán mô phỏng (giống chữ ký HMAC của VNPay/MoMo).
  GATEWAY_SECRET: env.PAYMENT_GATEWAY_SECRET || (isProd ? null : 'dev-gateway-secret'),
  DEMO_TOOLS: env.DEMO_TOOLS ? env.DEMO_TOOLS === 'true' : !isProd,
  SCHEDULER_INTERVAL_MS: Number(env.SCHEDULER_INTERVAL_MS || 2000),
  CLIENT_DIST: path.resolve(SERVER_ROOT, '..', 'client', 'dist'),
};

if (!config.GATEWAY_SECRET) throw new Error('Thiếu PAYMENT_GATEWAY_SECRET trong production');
if (config.isProd && config.DEMO_TOOLS) throw new Error('DEMO_TOOLS không được bật trong production');
if (!Number.isInteger(config.PORT) || config.PORT <= 0) throw new Error('PORT không hợp lệ');
