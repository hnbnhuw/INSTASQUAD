import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, vnd, fmtDay, fmtHour, fmtTime, newKey, dayKey } from '../api.js';
import { useAsync, Loading, ErrorBox, Avatar, Stars, TrustPill, Badge, Empty, useToast } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

const HOUR = 3600 * 1000;

export default function CompanionProfile() {
  const { id } = useParams();
  const { user, wallet, refresh } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get(`/companions/${id}`), [id]);
  const [sel, setSel] = useState(null); // start_at
  const [hours, setHours] = useState(1);
  const [gameId, setGameId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Một mã request riêng cho mỗi lần chọn (chống double click / mạng chập chờn)
  const [requestKey, setRequestKey] = useState(() => newKey('bk'));

  const c = data?.companion;
  const days = useMemo(() => {
    if (!c) return [];
    const m = new Map();
    for (const s of c.slots) {
      const k = dayKey(s.start_at);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return [...m.entries()];
  }, [c]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const slotMap = new Map(c.slots.map((s) => [s.start_at, s]));
  const contiguousFree = (start, n) => {
    for (let i = 0; i < n; i++) if (slotMap.get(start + i * HOUR)?.status !== 'AVAILABLE') return false;
    return true;
  };
  const maxHours = sel ? [1, 2, 3, 4, 5].filter((n) => contiguousFree(sel, n)).at(-1) || 1 : 1;
  const total = c.hourly_rate * hours;
  const game = gameId || c.games[0]?.game_id;
  const canBook = user?.role === 'RENTER' && c.bookable;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post('/bookings', { companionId: c.id, gameId: Number(game), startAt: sel, hours, note, requestKey });
      await refresh();
      if (r.escrow?.escrowed) toast('Đã ký quỹ! Companion có 180 giây để trả lời.', 'success');
      else if (r.escrow?.reason === 'INSUFFICIENT_BALANCE') toast(`Số dư chưa đủ – còn thiếu ${vnd(r.escrow.details.shortfall)}. Khung giờ được giữ 10 phút.`, 'warn');
      nav(`/bookings/${r.booking.id}`);
    } catch (e) {
      setErr(e);
      if (e.code === 'SLOT_UNAVAILABLE') {
        reload();
        setSel(null);
      }
      setRequestKey(newKey('bk'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profile-layout">
      <section className="card">
        <div className="row gap">
          <Avatar name={c.display_name} hue={c.avatar_hue} size={84} />
          <div className="grow">
            <h1 className="mb0">{c.display_name}</h1>
            <div className="muted">{c.headline}</div>
            <div className="row gap wrap mt">
              {c.verified ? <Badge tone="ok">✔ Đã eKYC</Badge> : <Badge tone="warn">Chưa xác thực danh tính</Badge>}
              <TrustPill score={c.trust_score} />
              <Stars value={c.rating_avg} count={c.rating_count} />
              <span className="muted small">{c.completed_count} đơn hoàn tất</span>
            </div>
          </div>
          <div className="price big">
            {vnd(c.hourly_rate)}
            <small>/giờ</small>
          </div>
        </div>
        <p className="bio">{c.bio}</p>
        <h3>Game & rank</h3>
        <div className="tags">
          {c.games.map((g) => (
            <span className="tag" key={g.game_id} title={g.rank_verified ? 'Rank đã đối chiếu qua Game API (mô phỏng)' : 'Chưa đối chiếu rank'}>
              {g.game_name} · {g.rank} {g.rank_verified ? '✓' : ''}
            </span>
          ))}
        </div>

        <h3>Lịch rảnh (giờ Việt Nam)</h3>
        {!c.bookable && <div className="alert alert-warn">Companion hiện không nhận đặt lịch.</div>}
        {days.length === 0 ? (
          <Empty>Companion chưa mở lịch trong 7 ngày tới.</Empty>
        ) : (
          <div className="calendar">
            {days.map(([k, slots]) => (
              <div className="cal-day" key={k}>
                <div className="cal-head">{fmtDay(slots[0].start_at)}</div>
                <div className="cal-slots">
                  {slots.map((s) => {
                    const inSel = sel && s.start_at >= sel && s.start_at < sel + hours * HOUR;
                    return (
                      <button
                        key={s.id}
                        className={`slot slot-${s.status.toLowerCase()} ${inSel ? 'sel' : ''}`}
                        disabled={s.status !== 'AVAILABLE' || !canBook}
                        title={s.status === 'AVAILABLE' ? 'Còn trống' : 'Đã có người giữ/đặt'}
                        onClick={() => {
                          setSel(s.start_at);
                          setHours(1);
                          setErr(null);
                          setRequestKey(newKey('bk'));
                        }}
                      >
                        {fmtHour(s.start_at)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="legend small muted">
          <span className="slot slot-available">Trống</span> <span className="slot slot-busy">Đã giữ/đặt</span> <span className="slot sel">Đang chọn</span>
        </div>

        <h3>Đánh giá gần đây</h3>
        {c.reviews.length === 0 ? (
          <Empty>Chưa có đánh giá.</Empty>
        ) : (
          c.reviews.map((r, i) => (
            <div key={i} className="review">
              <div className="row between">
                <b>{r.reviewer_name}</b>
                <span className="stars">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
              </div>
              <div>{r.comment}</div>
              <small className="muted">{fmtTime(r.created_at)}</small>
            </div>
          ))
        )}
      </section>

      <aside className="card sticky booking-box">
        <h2>Đặt lịch</h2>
        {!user && (
          <div className="alert alert-info">
            <Link to={`/login?next=/companions/${c.id}`}>Đăng nhập</Link> bằng tài khoản Renter để đặt lịch.
          </div>
        )}
        {user && user.role !== 'RENTER' && <div className="alert alert-info">Chỉ tài khoản Renter mới đặt lịch được.</div>}
        {canBook && (
          <>
            <label className="field">
              <span className="field-label">Game</span>
              <select value={game} onChange={(e) => setGameId(e.target.value)}>
                {c.games.map((g) => (
                  <option key={g.game_id} value={g.game_id}>
                    {g.game_name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="field-label">Khung giờ</span>
              {sel ? <b>{fmtTime(sel)}</b> : <span className="muted">Chọn một ô giờ trống trên lịch</span>}
            </div>
            <label className="field">
              <span className="field-label">Số giờ thuê</span>
              <select value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={!sel}>
                {Array.from({ length: maxHours }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} giờ {sel ? `(${fmtHour(sel)}–${fmtHour(sel + n * HOUR)})` : ''}
                  </option>
                ))}
              </select>
              <span className="field-hint">Chỉ chọn được các giờ liên tiếp còn trống. Tối đa 5 giờ/đơn, 10 giờ/ngày/Companion.</span>
            </label>
            <label className="field">
              <span className="field-label">Ghi chú cho Companion</span>
              <textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="vd: leo rank, luyện aim…" />
            </label>
            <div className="sum">
              <div className="row between">
                <span>
                  {vnd(c.hourly_rate)} × {hours} giờ
                </span>
                <b>{vnd(total)}</b>
              </div>
              <div className="row between muted small">
                <span>Số dư khả dụng</span>
                <span>{vnd(wallet?.available)}</span>
              </div>
              {wallet && wallet.available < total && <div className="alert alert-warn small">Số dư chưa đủ. Bạn vẫn có thể gửi yêu cầu: khung giờ được giữ 10 phút để bạn nạp thêm.</div>}
              <div className="muted small">Phí được chốt tại thời điểm đặt. Tiền được giữ trong Escrow tới khi bạn nghiệm thu.</div>
            </div>
            <ErrorBox error={err} />
            <button className="btn btn-block" disabled={!sel || busy} onClick={submit}>
              {busy ? 'Đang gửi…' : 'Gửi yêu cầu đặt lịch'}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
