// Phòng phiên chơi: chat real-time (SSE) + gọi thoại WebRTC (P2P, server chỉ chuyển tín hiệu).
import { useEffect, useRef, useState, useCallback } from 'react';
import { get, post, fmtHour } from '../api.js';
import { onRealtime, useAuth } from '../auth.jsx';
import { ErrorBox, Countdown } from '../ui.jsx';

export default function Room({ booking }) {
  const { user, connected } = useAuth();
  const [room, setRoom] = useState(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState(null);
  const listRef = useRef(null);
  const load = useCallback(() => get(`/bookings/${booking.id}/room`).then(setRoom).catch(setErr), [booking.id]);
  useEffect(() => {
    load();
  }, [load, booking.status]);
  useEffect(
    () =>
      onRealtime('chat', (m) => {
        if (m.booking_id !== booking.id) return;
        setRoom((r) => (r && !r.messages.some((x) => x.id === m.id) ? { ...r, messages: [...r.messages, m] } : r));
      }),
    [booking.id],
  );
  // Khi SSE kết nối lại, tải lại tin nhắn có thể đã lỡ
  useEffect(() => {
    if (connected) load();
  }, [connected, load]);
  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [room?.messages.length]);

  if (!room) return <ErrorBox error={err} />;
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setErr(null);
    try {
      const r = await post(`/bookings/${booking.id}/messages`, { body: text });
      setText('');
      setRoom((x) => (x.messages.some((m) => m.id === r.message.id) ? x : { ...x, messages: [...x.messages, r.message] }));
    } catch (e2) {
      setErr(e2);
    }
  };
  const isParty = booking.isParty;
  return (
    <div className="room">
      <div className="room-head">
        <div>
          <b>Phòng phiên chơi</b>{' '}
          {room.open ? <span className="badge badge-live">● Đang mở</span> : <span className="badge badge-muted">{booking.status === 'ACCEPTED' ? 'Mở khi đến giờ hẹn' : 'Đã đóng'}</span>}
          <span className={`small ${connected ? 'ok' : 'muted'}`}> · {connected ? 'Realtime đã kết nối' : 'Đang kết nối lại…'}</span>
        </div>
        {room.open && <Countdown to={booking.end_at} prefix="Còn lại " />}
      </div>
      {isParty && room.open && <Voice booking={booking} me={user} />}
      <div className="chat" ref={listRef}>
        {room.messages.length === 0 && <div className="muted small center pad">Chưa có tin nhắn.</div>}
        {room.messages.map((m) => (
          <div key={m.id} className={`msg ${m.sender_id === user.id ? 'me' : ''}`}>
            <div className="bubble">
              {m.body}
              {m.flagged ? <span className="flag" title="Đã ẩn thông tin liên lạc ngoài nền tảng"> ⚠</span> : null}
            </div>
            <small className="muted">
              {m.sender_name} · {fmtHour(m.created_at)}
            </small>
          </div>
        ))}
      </div>
      {isParty && (
        <form className="chat-input" onSubmit={send}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            disabled={!room.open}
            placeholder={room.open ? 'Nhập tin nhắn… (SĐT, link, số tài khoản sẽ bị ẩn)' : 'Phòng chỉ mở trong thời gian phiên chơi'}
          />
          <button className="btn" disabled={!room.open || !text.trim()}>
            Gửi
          </button>
        </form>
      )}
      <ErrorBox error={err} />
    </div>
  );
}

// ---------------- WebRTC Voice ----------------
function Voice({ booking, me }) {
  const [state, setState] = useState('idle'); // idle | calling | ringing | connecting | in-call | error
  const [msg, setMsg] = useState('');
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const iceQueue = useRef([]); // ICE đến trước remoteDescription thì xếp hàng
  const signal = useCallback((type, data) => post(`/bookings/${booking.id}/rtc`, { type, data }).catch((e) => setMsg(e.message)), [booking.id]);

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    iceQueue.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const createPc = useCallback(async () => {
    // Không dùng STUN/TURN bên ngoài: hoạt động trong mạng LAN/localhost (giới hạn đã ghi trong tài liệu)
    const pc = new RTCPeerConnection({ iceServers: [] });
    pcRef.current = pc;
    pc.onicecandidate = (e) => e.candidate && signal('ice', e.candidate.toJSON());
    pc.ontrack = (e) => {
      if (audioRef.current) audioRef.current.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setState('in-call');
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        setState('error');
        setMsg('Không thiết lập được kết nối thoại – vui lòng tiếp tục bằng chat.');
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    return pc;
  }, [signal]);

  useEffect(() => {
    const off = onRealtime('rtc', async (s) => {
      if (s.bookingId !== booking.id || s.from === me.id) return;
      try {
        if (s.type === 'call-request') {
          setState('ringing');
          setMsg('Đối phương đang gọi thoại…');
        } else if (s.type === 'call-accept') {
          const pc = await createPc();
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          setState('connecting');
          signal('offer', offer);
        } else if (s.type === 'offer') {
          const pc = pcRef.current || (await createPc());
          await pc.setRemoteDescription(s.data);
          for (const c of iceQueue.current.splice(0)) await pc.addIceCandidate(c).catch(() => {});
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          signal('answer', ans);
        } else if (s.type === 'answer') {
          await pcRef.current?.setRemoteDescription(s.data);
          for (const c of iceQueue.current.splice(0)) await pcRef.current?.addIceCandidate(c).catch(() => {});
        } else if (s.type === 'ice') {
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) await pc.addIceCandidate(s.data).catch(() => {});
          else iceQueue.current.push(s.data);
        } else if (s.type === 'hangup' || s.type === 'call-decline') {
          cleanup();
          setState('idle');
          setMsg(s.type === 'hangup' ? 'Cuộc gọi đã kết thúc.' : 'Đối phương từ chối cuộc gọi.');
        }
      } catch (e) {
        setState('error');
        setMsg(`Lỗi WebRTC/micro: ${e.message}. Tiếp tục giao tiếp bằng chat.`);
      }
    });
    return () => {
      off();
    };
  }, [booking.id, me.id, createPc, signal, cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  const supported = typeof RTCPeerConnection !== 'undefined' && navigator.mediaDevices?.getUserMedia;
  if (!supported) return <div className="alert alert-info small">Trình duyệt không hỗ trợ gọi thoại WebRTC – hãy dùng chat.</div>;
  return (
    <div className="voice">
      <audio ref={audioRef} autoPlay />
      {state === 'idle' || state === 'error' ? (
        <button
          className="btn btn-sm"
          onClick={async () => {
            setMsg('Đang gọi…');
            setState('calling');
            const r = await signal('call-request');
            if (r && !r.delivered) {
              setState('idle');
              setMsg('Đối phương chưa vào phòng (offline).');
            }
          }}
        >
          📞 Gọi thoại
        </button>
      ) : null}
      {state === 'ringing' && (
        <>
          <button
            className="btn btn-sm"
            onClick={async () => {
              try {
                await createPc();
                setState('connecting');
                signal('call-accept');
              } catch (e) {
                setState('error');
                setMsg(`Không truy cập được micro: ${e.message}`);
                signal('call-decline');
              }
            }}
          >
            Nghe máy
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setState('idle');
              signal('call-decline');
            }}
          >
            Từ chối
          </button>
        </>
      )}
      {['calling', 'connecting', 'in-call'].includes(state) && (
        <button
          className="btn btn-sm btn-danger"
          onClick={() => {
            signal('hangup');
            cleanup();
            setState('idle');
            setMsg('Đã kết thúc cuộc gọi.');
          }}
        >
          Kết thúc {state === 'in-call' ? '(đang thoại)' : ''}
        </button>
      )}
      <span className="muted small">{msg}</span>
    </div>
  );
}
