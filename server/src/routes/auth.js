import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { h, parse, requireAuth, COOKIE } from '../http.js';
import { createUser, login, createSession, destroySession, publicUser, mockOAuthIssueCode, mockOAuthExchange, submitKyc, kycSummary } from '../services/users.js';
import { getWallet } from '../services/ledger.js';
import { randomToken } from '../util.js';
import { parseCookies } from '../http.js';
import { E } from '../errors.js';

const r = Router();

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 7 * 24 * 3600 * 1000, path: '/' });
}

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Email không hợp lệ').max(120),
  password: z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự').max(100),
  displayName: z.string().trim().min(2, 'Tên hiển thị tối thiểu 2 ký tự').max(50),
  role: z.enum(['RENTER', 'COMPANION']),
  phone: z.string().trim().max(20).optional(),
});

r.post(
  '/register',
  h((req, res) => {
    const body = parse(registerSchema, req.body);
    const u = createUser(body);
    setSessionCookie(res, createSession(u.id));
    res.status(201).json({ user: publicUser(u) });
  }),
);

r.post(
  '/login',
  h((req, res) => {
    const { email, password } = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body);
    const u = login(email, password);
    setSessionCookie(res, createSession(u.id));
    res.json({ user: publicUser(u) });
  }),
);

r.post(
  '/logout',
  h((req, res) => {
    destroySession(req.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }),
);

r.get(
  '/me',
  h((req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: publicUser(req.user), wallet: getWallet(req.user.id), kyc: kycSummary(req.user.id) });
  }),
);

// ---- OAuth2 Authorization Code (nhà cung cấp mô phỏng) ----
// 1) /oauth/start → redirect tới trang đồng ý của "provider" (frontend /oauth/mock) kèm state chống CSRF
r.get(
  '/oauth/start',
  h((req, res) => {
    const state = randomToken(16);
    const role = req.query.role === 'COMPANION' ? 'COMPANION' : 'RENTER';
    res.cookie('isq_oauth_state', `${state}.${role}`, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' });
    res.redirect(`/oauth/mock?state=${encodeURIComponent(state)}`);
  }),
);
// 2) Trang đồng ý của provider gọi /oauth/mock/authorize để lấy code (chỉ phục vụ mô phỏng)
r.post(
  '/oauth/mock/authorize',
  h((req, res) => {
    const { email, name, state } = parse(
      z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(2).max(50), state: z.string().min(8) }),
      req.body,
    );
    const code = mockOAuthIssueCode({ email, name });
    res.json({ redirect: `/api/auth/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` });
  }),
);
// 3) Callback: kiểm tra state, đổi code lấy danh tính, tạo phiên
r.get(
  '/oauth/callback',
  h((req, res) => {
    const saved = parseCookies(req.headers.cookie).isq_oauth_state || '';
    const [state, role] = saved.split('.');
    res.clearCookie('isq_oauth_state', { path: '/' });
    if (!state || state !== req.query.state) throw E.badRequest('OAUTH_STATE_MISMATCH', 'Tham số state không khớp (chống CSRF)');
    const u = mockOAuthExchange(String(req.query.code || ''), role);
    setSessionCookie(res, createSession(u.id));
    res.redirect('/');
  }),
);

r.post(
  '/kyc',
  requireAuth,
  h((req, res) => {
    const body = parse(
      z.object({ fullName: z.string().trim().min(3).max(100), idNumber: z.string().trim(), dob: z.string().trim() }),
      req.body,
    );
    res.json(submitKyc(req.user, body));
  }),
);

export default r;
