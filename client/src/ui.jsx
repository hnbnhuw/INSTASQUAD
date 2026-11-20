import { useEffect, useState, useCallback, createContext, useContext, useRef } from 'react';
import { serverNow, BOOKING_LABEL } from './api.js';

// ---------------- Toast ----------------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, type = 'info') => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, type }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), type === 'error' ? 7000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------- Async data hook với trạng thái loading/error ----------------
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback(async (silent = false) => {
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      setState({ loading: false, error: null, data });
    } catch (e) {
      setState((s) => ({ loading: false, error: e, data: silent ? s.data : null }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

export function Loading({ text = 'Đang tải…' }) {
  return (
    <div className="state">
      <span className="spinner" /> {text}
    </div>
  );
}
export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="alert alert-error">
      <b>{error.status === 403 ? 'Không có quyền' : error.status === 404 ? 'Không tìm thấy' : 'Có lỗi xảy ra'}:</b> {error.message}
      {error.details && Array.isArray(error.details) && (
        <ul>
          {error.details.map((d, i) => (
            <li key={i}>
              {d.field}: {d.message}
            </li>
          ))}
        </ul>
      )}
      {error.alertId && <div className="muted">Đã tạo cảnh báo đối soát #{error.alertId}. Tiền được giữ nguyên trạng thái trước đó.</div>}
      {onRetry && (
        <button className="btn btn-sm" onClick={() => onRetry()}>
          Thử lại
        </button>
      )}
    </div>
  );
}
export function Empty({ children }) {
  return <div className="state empty">{children}</div>;
}

const STATUS_TONE = {
  AWAITING_ESCROW: 'warn',
  PENDING_COMPANION: 'warn',
  ACCEPTED: 'info',
  IN_SESSION: 'live',
  AWAITING_CONFIRMATION: 'warn',
  COMPLETED: 'ok',
  DISPUTED: 'danger',
  RESOLVED_REFUNDED: 'muted',
  RESOLVED_RELEASED: 'muted',
  CANCELLED: 'muted',
  EXPIRED: 'muted',
};
export function StatusBadge({ status, label }) {
  return <span className={`badge badge-${STATUS_TONE[status] || 'info'}`}>{label || BOOKING_LABEL[status] || status}</span>;
}
export function Badge({ tone = 'info', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

// Đếm ngược theo đồng hồ server
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
export function Countdown({ to, prefix = '', onEnd }) {
  const now = useNow();
  const left = Math.max(0, to - now);
  const fired = useRef(false);
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onEnd?.();
    }
  }, [left, onEnd]);
  const s = Math.ceil(left / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const text = hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  return (
    <span className={`countdown ${s <= 30 ? 'urgent' : ''}`}>
      {prefix}
      {text}
    </span>
  );
}

export function Avatar({ name = '?', hue = 260, size = 44 }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 70% 55%), hsl(${(hue + 40) % 360} 70% 45%))` }}>
      {initials}
    </div>
  );
}

export function Stars({ value, count }) {
  if (value == null) return <span className="muted small">Chưa có đánh giá</span>;
  return (
    <span className="stars" title={`${value}/5`}>
      ★ {value.toFixed(1)}
      {count != null && <span className="muted small"> ({count})</span>}
    </span>
  );
}

export function TrustPill({ score }) {
  const tone = score >= 70 ? 'ok' : score >= 40 ? 'warn' : 'danger';
  return <span className={`badge badge-${tone}`} title="TrustScore 0–100">Uy tín {score}</span>;
}

export function Field({ label, hint, children, error }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function ConfirmButton({ children, confirm, onClick, className = 'btn', disabled }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={disabled || busy}
      onClick={async () => {
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="spinner sm" /> : null} {children}
    </button>
  );
}
