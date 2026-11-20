import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { get, post, setServerNow } from './api.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// Bus sự kiện realtime (SSE) dùng chung toàn app
const listeners = new Map();
export function onRealtime(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => listeners.get(event).delete(cb);
}
function emit(event, data) {
  for (const cb of listeners.get(event) || []) cb(data);
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, wallet: null, kyc: null });
  const [connected, setConnected] = useState(false);
  const esRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const d = await get('/auth/me');
      setState({ loading: false, user: d.user, wallet: d.wallet || null, kyc: d.kyc || null });
      return d.user;
    } catch {
      setState({ loading: false, user: null, wallet: null, kyc: null });
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Kết nối SSE khi đã đăng nhập. Tự kết nối lại khi mất mạng/backend khởi động lại (UC04 2a):
  // server gửi "ping" mỗi 15 giây; quá 40 giây không nhận gì thì đóng và mở kết nối mới, rồi phát "resync" để các trang tải lại.
  useEffect(() => {
    if (!state.user) return;
    let es = null;
    let watchdog = null;
    let lastSeen = Date.now();
    let first = true;
    let closed = false;
    const seen = () => {
      lastSeen = Date.now();
    };
    const connect = () => {
      es?.close();
      es = new EventSource('/api/events');
      esRef.current = es;
      es.addEventListener('hello', (e) => {
        seen();
        setConnected(true);
        try {
          setServerNow(JSON.parse(e.data).serverNow);
        } catch {
          /* bỏ qua */
        }
        if (!first) emit('resync', {});
        first = false;
      });
      es.addEventListener('ping', (e) => {
        seen();
        const t = Number(e.data);
        if (t) setServerNow(t);
      });
      es.onerror = () => setConnected(false);
      for (const ev of ['notification', 'booking', 'chat', 'rtc']) {
        es.addEventListener(ev, (e) => {
          seen();
          try {
            emit(ev, JSON.parse(e.data));
          } catch {
            /* bỏ qua */
          }
        });
      }
    };
    connect();
    watchdog = setInterval(() => {
      if (!closed && Date.now() - lastSeen > 40000) {
        setConnected(false);
        lastSeen = Date.now();
        connect();
      }
    }, 5000);
    const off = onRealtime('notification', () => refresh());
    const offResync = onRealtime('resync', () => refresh());
    return () => {
      closed = true;
      clearInterval(watchdog);
      off();
      offResync();
      es?.close();
      setConnected(false);
    };
  }, [state.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const logout = async () => {
    await post('/auth/logout');
    setState({ loading: false, user: null, wallet: null, kyc: null });
  };

  return <AuthCtx.Provider value={{ ...state, refresh, logout, connected }}>{children}</AuthCtx.Provider>;
}
