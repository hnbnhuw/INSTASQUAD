import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ErrorBox, Field } from '../ui.jsx';

const DEMO = [
  ['an.renter@instasquad.local', 'Renter (ví 1.000.000đ)'],
  ['chi.renter@instasquad.local', 'Renter (ví ít tiền)'],
  ['mai.companion@instasquad.local', 'Companion'],
  ['tuan.companion@instasquad.local', 'Companion (có khiếu nại)'],
  ['cs@instasquad.local', 'CS Agent'],
  ['admin@instasquad.local', 'Admin'],
];

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const submit = async (e, creds) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', creds || { email, password });
      const u = await refresh();
      nav(sp.get('next') || (u.role === 'CS' || u.role === 'ADMIN' ? '/admin' : u.role === 'COMPANION' ? '/bookings' : '/'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <h1>Đăng nhập</h1>
        <ErrorBox error={error} />
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </Field>
        <Field label="Mật khẩu">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </Field>
        <button className="btn btn-block" disabled={busy}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
        <a className="btn btn-ghost btn-block" href="/api/auth/oauth/start">
          Đăng nhập bằng Google (OAuth2 mô phỏng)
        </a>
        <p className="muted small center">
          Chưa có tài khoản? <Link to="/register">Đăng ký</Link>
        </p>
      </form>
      <div className="card auth-card demo-accounts">
        <h3>Tài khoản demo</h3>
        <p className="muted small">Mật khẩu chung: <code>Demo@123</code> (chỉ dùng cho demo).</p>
        {DEMO.map(([em, label]) => (
          <button key={em} className="demo-acc" disabled={busy} onClick={() => submit(null, { email: em, password: 'Demo@123' })}>
            <b>{label}</b>
            <span className="muted small">{em}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Register() {
  const [f, setF] = useState({ email: '', password: '', displayName: '', role: 'RENTER' });
  const [error, setError] = useState(null);
  const { refresh } = useAuth();
  const nav = useNavigate();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="auth-wrap">
      <form
        className="card auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await post('/auth/register', f);
            const u = await refresh();
            nav(u.role === 'COMPANION' ? '/companion' : '/');
          } catch (err) {
            setError(err);
          }
        }}
      >
        <h1>Tạo tài khoản</h1>
        <ErrorBox error={error} />
        <div className="seg">
          {[
            ['RENTER', 'Tôi muốn thuê Companion'],
            ['COMPANION', 'Tôi là Companion'],
          ].map(([v, l]) => (
            <button type="button" key={v} className={f.role === v ? 'on' : ''} onClick={() => setF({ ...f, role: v })}>
              {l}
            </button>
          ))}
        </div>
        <Field label="Tên hiển thị">
          <input value={f.displayName} onChange={set('displayName')} required minLength={2} maxLength={50} />
        </Field>
        <Field label="Email">
          <input type="email" value={f.email} onChange={set('email')} required />
        </Field>
        <Field label="Mật khẩu" hint="Tối thiểu 8 ký tự">
          <input type="password" value={f.password} onChange={set('password')} required minLength={8} autoComplete="new-password" />
        </Field>
        {f.role === 'COMPANION' && <div className="alert alert-info small">Companion cần hoàn tất eKYC trước khi xuất hiện trong tìm kiếm và rút tiền.</div>}
        <button className="btn btn-block">Đăng ký</button>
        <a className="btn btn-ghost btn-block" href={`/api/auth/oauth/start?role=${f.role}`}>
          Đăng ký bằng Google (OAuth2 mô phỏng)
        </a>
      </form>
    </div>
  );
}

// Trang "đồng ý" của nhà cung cấp OAuth2 MÔ PHỎNG
export function OAuthMock() {
  const [sp] = useSearchParams();
  const [email, setEmail] = useState('gamer.demo@gmail.test');
  const [name, setName] = useState('Gamer Demo');
  const [error, setError] = useState(null);
  return (
    <div className="auth-wrap">
      <form
        className="card auth-card oauth"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await post('/auth/oauth/mock/authorize', { email, name, state: sp.get('state') || '' });
            window.location.href = r.redirect;
          } catch (err) {
            setError(err);
          }
        }}
      >
        <div className="badge badge-warn">Nhà cung cấp OAuth2 mô phỏng</div>
        <h2>Chọn tài khoản để tiếp tục tới INSTASQUAD</h2>
        <p className="muted small">INSTASQUAD sẽ nhận: tên hiển thị và email. Luồng: Authorization Code + state chống CSRF.</p>
        <ErrorBox error={error} />
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Tên">
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </Field>
        <button className="btn btn-block">Cho phép</button>
        <Link to="/login" className="btn btn-ghost btn-block">
          Hủy
        </Link>
      </form>
    </div>
  );
}
