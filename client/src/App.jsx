import { useEffect, useState } from 'react';
import { Routes, Route, NavLink, Link, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth, onRealtime } from './auth.jsx';
import { useToast, Loading } from './ui.jsx';
import { get, post, vnd, fmtTime, ROLE_LABEL } from './api.js';
import Home from './pages/Home.jsx';
import { Login, Register, OAuthMock } from './pages/Auth.jsx';
import CompanionProfile from './pages/CompanionProfile.jsx';
import Bookings from './pages/Bookings.jsx';
import BookingDetail from './pages/BookingDetail.jsx';
import Wallet from './pages/Wallet.jsx';
import PaySim from './pages/PaySim.jsx';
import CompanionDashboard from './pages/CompanionDashboard.jsx';
import Account from './pages/Account.jsx';
import Admin from './pages/admin/Admin.jsx';

function RequireRole({ roles, children }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (roles && !roles.includes(user.role)) return <div className="alert alert-error">Trang này dành cho vai trò: {roles.map((r) => ROLE_LABEL[r]).join(', ')}.</div>;
  return children;
}

function Bell() {
  const [data, setData] = useState({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const load = () => get('/notifications').then(setData).catch(() => {});
  useEffect(() => {
    load();
    return onRealtime('notification', load);
  }, []);
  return (
    <div className="bell">
      <button
        className="icon-btn"
        aria-label="Thông báo"
        onClick={async () => {
          setOpen(!open);
          if (!open && data.unread) {
            await post('/notifications/read').catch(() => {});
            setData((d) => ({ ...d, unread: 0 }));
          }
        }}
      >
        🔔{data.unread > 0 && <span className="dot">{data.unread}</span>}
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          {data.items.length === 0 && <div className="muted pad">Chưa có thông báo</div>}
          {data.items.map((n) => (
            <button
              key={n.id}
              className={`notif ${n.read_at ? '' : 'unread'}`}
              onClick={() => {
                setOpen(false);
                if (n.link) nav(n.link);
              }}
            >
              <b>{n.title}</b>
              <span>{n.body}</span>
              <small className="muted">{fmtTime(n.created_at)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Header() {
  const { user, wallet, logout, connected } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (!user) return;
    return onRealtime('notification', (n) => toast(`${n.title}: ${n.body}`, 'info'));
  }, [user, toast]);
  const close = () => setMenu(false);
  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <Link to="/" className="brand" onClick={close}>
          <span className="logo">IS</span> INSTASQUAD
        </Link>
        <button className="icon-btn burger" onClick={() => setMenu(!menu)} aria-label="Menu">
          ☰
        </button>
        <nav className={`nav ${menu ? 'open' : ''}`} onClick={close}>
          <NavLink to="/" end>
            Tìm Companion
          </NavLink>
          {user && (user.role === 'RENTER' || user.role === 'COMPANION') && <NavLink to="/bookings">Đơn của tôi</NavLink>}
          {user && (user.role === 'RENTER' || user.role === 'COMPANION') && <NavLink to="/wallet">Ví</NavLink>}
          {user?.role === 'COMPANION' && <NavLink to="/companion">Hồ sơ & Lịch</NavLink>}
          {user && (user.role === 'CS' || user.role === 'ADMIN') && <NavLink to="/admin">Quản trị</NavLink>}
          {user && (
            <NavLink to="/account" className="mobile-only">
              Tài khoản ({user.display_name})
            </NavLink>
          )}
          {user && (
            <button
              className="mobile-only nav-btn"
              onClick={async () => {
                await logout();
                nav('/');
              }}
            >
              Đăng xuất
            </button>
          )}
          {!user && (
            <NavLink to="/login" className="mobile-only">
              Đăng nhập / Đăng ký
            </NavLink>
          )}
        </nav>
        <div className="topbar-right">
          {user ? (
            <>
              {wallet && (user.role === 'RENTER' || user.role === 'COMPANION') && (
                <Link to="/wallet" className="wallet-chip" title="Số dư khả dụng">
                  {vnd(wallet.available)}
                </Link>
              )}
              <Bell />
              <Link to="/account" className="user-chip" title={connected ? 'Realtime đã kết nối' : 'Đang kết nối realtime…'}>
                <span className={`live-dot ${connected ? 'on' : ''}`} />
                {user.display_name} <small className="muted">· {ROLE_LABEL[user.role]}</small>
              </Link>
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  await logout();
                  nav('/');
                }}
              >
                Đăng xuất
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn-ghost btn-sm">
                Đăng nhập
              </Link>
              <Link to="/register" className="btn btn-sm">
                Đăng ký
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const { loading } = useAuth();
  if (loading)
    return (
      <div className="container">
        <Loading text="Đang khởi động…" />
      </div>
    );
  return (
    <>
      <Header />
      <main className="container main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/oauth/mock" element={<OAuthMock />} />
          <Route path="/companions/:id" element={<CompanionProfile />} />
          <Route path="/bookings" element={<RequireRole roles={['RENTER', 'COMPANION']}><Bookings /></RequireRole>} />
          <Route path="/bookings/:id" element={<RequireRole><BookingDetail /></RequireRole>} />
          <Route path="/wallet" element={<RequireRole roles={['RENTER', 'COMPANION']}><Wallet /></RequireRole>} />
          <Route path="/pay/:gtx" element={<RequireRole><PaySim /></RequireRole>} />
          <Route path="/companion" element={<RequireRole roles={['COMPANION']}><CompanionDashboard /></RequireRole>} />
          <Route path="/account" element={<RequireRole><Account /></RequireRole>} />
          <Route path="/admin/*" element={<RequireRole roles={['CS', 'ADMIN']}><Admin /></RequireRole>} />
          <Route path="*" element={<div className="state empty">Không tìm thấy trang. <Link to="/">Về trang chủ</Link></div>} />
        </Routes>
      </main>
      <footer className="footer">
        <div className="container muted small">
          INSTASQUAD – Đồ án TMĐT (bản demo). Thanh toán, eKYC, OAuth2, Game API và chi trả là <b>mô phỏng</b>; không dùng tiền thật.
        </div>
      </footer>
    </>
  );
}
