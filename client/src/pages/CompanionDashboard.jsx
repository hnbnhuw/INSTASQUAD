import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, put, post, del, fmtDay, fmtHour, dayKey, serverNow } from '../api.js';
import { useAsync, Loading, ErrorBox, Badge, ConfirmButton, Field, useToast, Empty } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

export default function CompanionDashboard() {
  const { user } = useAuth();
  return (
    <>
      <h1>Hồ sơ & Lịch rảnh</h1>
      {user.kyc_status !== 'VERIFIED' && (
        <div className="alert alert-warn">
          Hồ sơ chưa hiển thị trong tìm kiếm vì bạn chưa hoàn tất eKYC. <Link to="/account">Xác thực ngay</Link>
        </div>
      )}
      <div className="two-col">
        <ProfileForm />
        <SlotManager />
      </div>
    </>
  );
}

function ProfileForm() {
  const toast = useToast();
  const games = useAsync(() => get('/games'), []);
  const prof = useAsync(() => get('/me/companion/profile'), []);
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (prof.data)
      setF({
        headline: prof.data.profile.headline,
        bio: prof.data.profile.bio,
        hourlyRate: prof.data.profile.hourly_rate,
        accepting: Boolean(prof.data.profile.accepting),
        games: prof.data.profile.games.map((g) => ({ gameId: g.game_id, rank: g.rank, inGameName: g.in_game_name, verified: g.rank_verified })),
      });
  }, [prof.data]);
  if (prof.loading || games.loading || !f) return <Loading />;
  const gl = games.data.games;
  const save = async () => {
    setErr(null);
    try {
      await put('/me/companion/profile', { ...f, games: f.games.map(({ gameId, rank, inGameName }) => ({ gameId: Number(gameId), rank, inGameName })) });
      toast('Đã lưu hồ sơ. Giá mới chỉ áp dụng cho đơn đặt sau.', 'success');
      prof.reload(true);
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <section className="card">
      <h2>Hồ sơ dịch vụ</h2>
      <div className="row between">
        <span>
          Trạng thái hồ sơ: {prof.data.profile.status === 'ACTIVE' ? <Badge tone="ok">Hoạt động</Badge> : <Badge tone="danger">Tạm khóa (TrustScore &lt; 40)</Badge>}
        </span>
        <label className="switch">
          <input type="checkbox" checked={f.accepting} onChange={(e) => setF({ ...f, accepting: e.target.checked })} /> Đang nhận booking
        </label>
      </div>
      <Field label="Tiêu đề">
        <input value={f.headline} maxLength={80} onChange={(e) => setF({ ...f, headline: e.target.value })} />
      </Field>
      <Field label="Giới thiệu">
        <textarea rows={3} value={f.bio} maxLength={1000} onChange={(e) => setF({ ...f, bio: e.target.value })} />
      </Field>
      <Field label="Giá mỗi giờ (VND)" hint="10.000đ – 2.000.000đ. Đơn đã đặt giữ nguyên giá đã chốt.">
        <input type="number" step={5000} value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: Number(e.target.value) })} />
      </Field>
      <h3>Game cung cấp</h3>
      {f.games.map((g, i) => {
        const game = gl.find((x) => x.id === Number(g.gameId));
        const upd = (patch) => setF({ ...f, games: f.games.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div className="game-row" key={i}>
            <select value={g.gameId} onChange={(e) => upd({ gameId: Number(e.target.value), rank: gl.find((x) => x.id === Number(e.target.value)).ranks[0] })}>
              {gl.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            <select value={g.rank} onChange={(e) => upd({ rank: e.target.value })}>
              {game?.ranks.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <input placeholder="Tên in-game" value={g.inGameName || ''} onChange={(e) => upd({ inGameName: e.target.value })} />
            {g.verified ? (
              <Badge tone="ok">Rank ✓</Badge>
            ) : (
              <ConfirmButton
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  try {
                    const r = await post(`/me/companion/games/${g.gameId}/verify-rank`);
                    toast(r.message, r.verified ? 'success' : 'warn');
                    prof.reload(true);
                  } catch (e) {
                    toast(e.code === 'NOT_FOUND' ? 'Hãy lưu hồ sơ trước khi đối chiếu rank' : e.message, 'error');
                  }
                }}
              >
                Đối chiếu Game API
              </ConfirmButton>
            )}
            <button className="icon-btn" onClick={() => setF({ ...f, games: f.games.filter((_, j) => j !== i) })} aria-label="Xóa">
              ✕
            </button>
          </div>
        );
      })}
      <button className="btn btn-ghost btn-sm" onClick={() => setF({ ...f, games: [...f.games, { gameId: gl[0].id, rank: gl[0].ranks[0], inGameName: '' }] })}>
        + Thêm game
      </button>
      <p className="muted small">Game API là mô phỏng: tên in-game chứa "fake" → không khớp, chứa "offline" → API lỗi.</p>
      <ErrorBox error={err} />
      <ConfirmButton className="btn btn-block" onClick={save}>
        Lưu hồ sơ
      </ConfirmButton>
    </section>
  );
}

const STATUS_TEXT = { AVAILABLE: 'Trống', HELD: 'Đang giữ', BOOKED: 'Đã đặt', UNAVAILABLE: 'Đã qua' };

function SlotManager() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get('/me/companion/slots'), []);
  const [date, setDate] = useState(() => dayKey(serverNow()));
  const [hours, setHours] = useState([]);
  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of data?.slots || []) {
      const k = dayKey(s.start_at);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return [...m.entries()];
  }, [data]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const toggle = (h) => setHours((x) => (x.includes(h) ? x.filter((y) => y !== h) : [...x, h]));
  return (
    <section className="card">
      <h2>Slot Calendar</h2>
      <p className="muted small">Mỗi slot 1 giờ (giờ Việt Nam). Renter đặt nhiều giờ liên tiếp. Tối đa 10 giờ được đặt mỗi ngày.</p>
      <div className="row gap wrap">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="chip" onClick={() => setHours([19, 20, 21, 22])}>
          Tối (19–23h)
        </button>
        <button className="chip" onClick={() => setHours([9, 10, 11])}>
          Sáng (9–12h)
        </button>
        <button className="chip" onClick={() => setHours([])}>
          Bỏ chọn
        </button>
      </div>
      <div className="hour-grid">
        {Array.from({ length: 24 }, (_, h) => (
          <button key={h} className={`hour ${hours.includes(h) ? 'on' : ''}`} onClick={() => toggle(h)}>
            {String(h).padStart(2, '0')}h
          </button>
        ))}
      </div>
      <ConfirmButton
        className="btn"
        disabled={!hours.length}
        onClick={async () => {
          try {
            const r = await post('/me/companion/slots', { date, hours });
            toast(`Đã mở ${r.created} khung giờ (bỏ qua giờ đã qua/đã có)`, 'success');
            setHours([]);
            reload(true);
          } catch (e) {
            toast(e.message, 'error');
          }
        }}
      >
        Mở {hours.length || ''} khung giờ ngày {date}
      </ConfirmButton>

      <h3>Lịch 14 ngày</h3>
      {byDay.length === 0 && <Empty>Chưa có khung giờ.</Empty>}
      {byDay.map(([k, slots]) => (
        <div key={k} className="slot-day">
          <b>{fmtDay(slots[0].start_at)}</b>
          <div className="cal-slots">
            {slots.map((s) => {
              const past = s.start_at <= serverNow();
              const cls = s.booking_code ? 'busy' : past || s.status === 'UNAVAILABLE' ? 'unavailable' : 'available';
              return (
              <span key={s.id} className={`slot slot-${cls}`} title={s.booking_code ? `${s.booking_code} – ${s.booking_status}` : STATUS_TEXT[s.status]}>
                {fmtHour(s.start_at)}
                {s.booking_code ? (
                  <Link to={`/bookings/${s.booking_id}`} className="slot-link">
                    {s.booking_code}
                  </Link>
                ) : null}
                {s.status === 'AVAILABLE' && !past && (
                  <button
                    className="x"
                    title="Đóng khung giờ"
                    onClick={async () => {
                      try {
                        await del(`/me/companion/slots/${s.id}`);
                        reload(true);
                      } catch (e) {
                        toast(e.message, 'error');
                      }
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
              );
            })}
          </div>
        </div>
      ))}
      <p className="muted small">
        Thu nhập & rút tiền: trang <Link to="/wallet">Ví</Link>.
      </p>
    </section>
  );
}
