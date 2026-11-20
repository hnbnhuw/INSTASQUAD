// Tài khoản, phiên đăng nhập, OAuth2 (mô phỏng), eKYC (mô phỏng, dữ liệu mã hóa AES-256-GCM).
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { E, AppError } from '../errors.js';
import { hashPassword, verifyPassword, randomToken, sha256, encryptText } from '../util.js';
import { ensureUserAccounts } from './ledger.js';
import { audit, notify } from './common.js';

const SESSION_TTL = 7 * 24 * 3600 * 1000;

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
    kyc_status: u.kyc_status,
    trust_score: u.trust_score,
    oauth_provider: u.oauth_provider,
    created_at: u.created_at,
  };
}

export function createUser({ email, password, displayName, role, phone = null, oauthProvider = null, oauthSubject = null, kycStatus = 'NONE' }) {
  return tx(() => {
    if (q.get('SELECT 1 FROM users WHERE email=?', email)) throw E.conflict('EMAIL_TAKEN', 'Email đã được sử dụng');
    const r = q.run(
      `INSERT INTO users(email, password_hash, oauth_provider, oauth_subject, display_name, phone, role, kyc_status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      email,
      password ? hashPassword(password) : null,
      oauthProvider,
      oauthSubject,
      displayName,
      phone,
      role,
      kycStatus,
      clock.now(),
    );
    const id = Number(r.lastInsertRowid);
    ensureUserAccounts(id);
    if (role === 'COMPANION') {
      q.run(
        'INSERT INTO companion_profiles(user_id, headline, bio, hourly_rate, accepting, avatar_hue, updated_at) VALUES (?,?,?,?,1,?,?)',
        id,
        'Companion mới',
        '',
        50000,
        (id * 47) % 360,
        clock.now(),
      );
    }
    audit(id, 'USER_REGISTER', 'user', id, { role, oauthProvider });
    return q.get('SELECT * FROM users WHERE id=?', id);
  });
}

export function login(email, password) {
  const u = q.get('SELECT * FROM users WHERE email=?', email);
  if (!u || !verifyPassword(password, u.password_hash)) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng');
  if (u.status !== 'ACTIVE') throw E.forbidden('Tài khoản đang bị khóa');
  return u;
}

export function createSession(userId) {
  const token = randomToken(32);
  const now = clock.now();
  q.run('INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha256(token), userId, now, Date.now() + SESSION_TTL);
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  const s = q.get('SELECT * FROM auth_sessions WHERE token_hash=?', sha256(token));
  // Hạn phiên dùng giờ thật (không theo demo clock) để dịch thời gian không làm đăng xuất.
  if (!s || s.expires_at < Date.now()) return null;
  const u = q.get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u || u.status !== 'ACTIVE') return null;
  return u;
}

export function destroySession(token) {
  if (token) q.run('DELETE FROM auth_sessions WHERE token_hash=?', sha256(token));
}

// ---------------- OAuth2 Authorization Code (nhà cung cấp MÔ PHỎNG chạy nội bộ) ----------------
const oauthCodes = new Map(); // code -> { email, name, subject, exp }
export function mockOAuthIssueCode({ email, name }) {
  const code = randomToken(24);
  oauthCodes.set(code, { email, name, subject: `mock-${sha256(email).slice(0, 16)}`, exp: Date.now() + 60_000 });
  return code;
}
export function mockOAuthExchange(code, role) {
  const data = oauthCodes.get(code);
  oauthCodes.delete(code); // mã chỉ dùng được 1 lần
  if (!data || data.exp < Date.now()) throw E.badRequest('OAUTH_INVALID_CODE', 'Mã ủy quyền OAuth2 không hợp lệ hoặc đã hết hạn');
  let u = q.get('SELECT * FROM users WHERE oauth_provider=? AND oauth_subject=?', 'mock-google', data.subject);
  if (!u) {
    const byEmail = q.get('SELECT * FROM users WHERE email=?', data.email);
    if (byEmail) throw E.conflict('EMAIL_TAKEN', 'Email đã có tài khoản mật khẩu; hãy đăng nhập bằng mật khẩu');
    u = createUser({ email: data.email, displayName: data.name, role: role === 'COMPANION' ? 'COMPANION' : 'RENTER', oauthProvider: 'mock-google', oauthSubject: data.subject });
  }
  if (u.status !== 'ACTIVE') throw E.forbidden('Tài khoản đang bị khóa');
  return u;
}

// ---------------- eKYC MÔ PHỎNG ----------------
// Quy tắc của dịch vụ giả lập (để demo đủ nhánh UC01):
//   CCCD 12 chữ số; kết thúc "000" → từ chối; "111" → cần bổ sung; "999" → dịch vụ tạm không khả dụng; còn lại → xác thực.
export function submitKyc(user, { fullName, idNumber, dob }) {
  if (!/^\d{12}$/.test(idNumber || '')) throw E.badRequest('INVALID_ID_NUMBER', 'Số CCCD phải gồm 12 chữ số');
  if (!fullName || fullName.trim().length < 3) throw E.badRequest('INVALID_NAME', 'Họ tên không hợp lệ');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) throw E.badRequest('INVALID_DOB', 'Ngày sinh không hợp lệ');
  if (user.kyc_status === 'VERIFIED') throw E.conflict('ALREADY_VERIFIED', 'Tài khoản đã xác thực');
  if (idNumber.endsWith('999')) {
    audit(user.id, 'KYC_PROVIDER_UNAVAILABLE', 'user', user.id, null);
    throw new AppError(503, 'EKYC_UNAVAILABLE', 'Dịch vụ eKYC tạm thời không khả dụng, vui lòng thử lại sau');
  }
  let status = 'VERIFIED';
  let message = 'Xác thực thành công';
  if (idNumber.endsWith('000')) {
    status = 'REJECTED';
    message = 'Ảnh/thông tin giấy tờ không khớp (mô phỏng)';
  } else if (idNumber.endsWith('111')) {
    status = 'NEEDS_MORE_INFO';
    message = 'Cần chụp lại mặt sau CCCD rõ nét hơn (mô phỏng)';
  }
  return tx(() => {
    const now = clock.now();
    q.run(
      `INSERT INTO kyc_records(user_id, full_name_enc, id_number_enc, dob_enc, id_last4, status, provider_ref, message, attempts, updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,?)
       ON CONFLICT(user_id) DO UPDATE SET full_name_enc=excluded.full_name_enc, id_number_enc=excluded.id_number_enc, dob_enc=excluded.dob_enc,
         id_last4=excluded.id_last4, status=excluded.status, provider_ref=excluded.provider_ref, message=excluded.message,
         attempts=kyc_records.attempts+1, updated_at=excluded.updated_at`,
      user.id,
      encryptText(fullName.trim()),
      encryptText(idNumber),
      encryptText(dob),
      idNumber.slice(-4),
      status,
      `EKYC-MOCK-${randomToken(6)}`,
      message,
      now,
    );
    q.run('UPDATE users SET kyc_status=? WHERE id=?', status, user.id);
    audit(user.id, 'KYC_SUBMIT', 'user', user.id, { status });
    notify(user.id, 'KYC', 'Kết quả eKYC', message, '/account');
    return { status, message };
  });
}

export function kycSummary(userId) {
  const k = q.get('SELECT status, id_last4, message, attempts, updated_at, provider_ref FROM kyc_records WHERE user_id=?', userId);
  return k ? { ...k, id_masked: `********${k.id_last4}` } : null;
}
