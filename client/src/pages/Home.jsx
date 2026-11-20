import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, vnd, fmtTime } from '../api.js';
import { useAsync, Loading, ErrorBox, Empty, Avatar, Stars, TrustPill, Badge } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

export default function Home() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const games = useAsync(() => get('/games'), []);
  const [f, setF] = useState(() => Object.fromEntries(sp.entries()));
  const query = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v != null)).toString();
  const res = useAsync(() => get(`/companions?${query}`), [query]);
  useEffect(() => {
    setSp(new URLSearchParams(query), { replace: true });
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const gameList = games.data?.games || [];
  const selectedGame = gameList.find((g) => String(g.id) === String(f.gameId));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value, ...(k === 'gameId' ? { rank: '' } : {}) }));

  return (
    <>
      <section className="hero">
        <div>
          <h1>Tìm đồng đội chơi game, an toàn với ký quỹ</h1>
          <p>
            Chọn Companion theo game, rank, giá và lịch rảnh. Tiền được giữ trong <b>Escrow</b> và chỉ giải ngân khi bạn nghiệm thu.
          </p>
          {!user && (
            <div className="row gap">
              <Link to="/register" className="btn">
                Bắt đầu ngay
              </Link>
              <Link to="/login" className="btn btn-ghost">
                Dùng tài khoản demo
              </Link>
            </div>
          )}
        </div>
        <ul className="hero-steps">
          <li><b>1</b> Chọn khung giờ – hệ thống giữ chỗ 10 phút</li>
          <li><b>2</b> Ký quỹ từ ví – Companion trả lời trong 180 giây</li>
          <li><b>3</b> Chơi cùng nhau – chat & gọi thoại trong phòng</li>
          <li><b>4</b> Nghiệm thu trong 15 phút – giải ngân 88/12</li>
        </ul>
      </section>

      <section className="card filters">
        <div className="filter-grid">
          <label>
            Game
            <select value={f.gameId || ''} onChange={set('gameId')}>
              <option value="">Tất cả game</option>
              {gameList.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Rank tối thiểu
            <select value={f.rank || ''} onChange={set('rank')} disabled={!selectedGame}>
              <option value="">{selectedGame ? 'Bất kỳ' : 'Chọn game trước'}</option>
              {selectedGame?.ranks.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label>
            Giá/giờ tối đa
            <select value={f.maxPrice || ''} onChange={set('maxPrice')}>
              <option value="">Không giới hạn</option>
              {[40000, 60000, 100000, 200000].map((p) => (
                <option key={p} value={p}>
                  ≤ {vnd(p)}
                </option>
              ))}
            </select>
          </label>
          <label>
            TrustScore tối thiểu
            <select value={f.minTrust || ''} onChange={set('minTrust')}>
              <option value="">Bất kỳ</option>
              {[50, 60, 70].map((p) => (
                <option key={p} value={p}>
                  ≥ {p}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ngày rảnh
            <input type="date" value={f.date || ''} onChange={set('date')} />
          </label>
          <label>
            Sắp xếp
            <select value={f.sort || 'match'} onChange={set('sort')}>
              <option value="match">Phù hợp nhất</option>
              <option value="trust">Uy tín cao</option>
              <option value="rating">Đánh giá cao</option>
              <option value="price_asc">Giá thấp → cao</option>
              <option value="price_desc">Giá cao → thấp</option>
            </select>
          </label>
          <label className="grow">
            Tìm theo tên
            <input placeholder="vd: Mai, Valorant coach…" value={f.q || ''} onChange={set('q')} />
          </label>
        </div>
        {query && (
          <button className="btn btn-ghost btn-sm" onClick={() => setF({})}>
            Xóa bộ lọc
          </button>
        )}
      </section>

      {res.loading && !res.data && <Loading />}
      <ErrorBox error={res.error} onRetry={res.reload} />
      {res.data && (
        <>
          <p className="muted small">
            {res.data.companions.length} Companion phù hợp · truy vấn {res.data.tookMs}ms
          </p>
          {res.data.companions.length === 0 ? (
            <Empty>Không có Companion phù hợp. Hãy thử nới lỏng tiêu chí tìm kiếm.</Empty>
          ) : (
            <div className="grid-cards">
              {res.data.companions.map((c) => (
                <Link to={`/companions/${c.id}`} key={c.id} className="card comp-card">
                  <div className="row gap">
                    <Avatar name={c.display_name} hue={c.avatar_hue} size={52} />
                    <div className="grow">
                      <div className="row between">
                        <b>{c.display_name}</b>
                        <Badge tone="ok">✔ Đã xác thực</Badge>
                      </div>
                      <div className="muted small clamp">{c.headline}</div>
                    </div>
                  </div>
                  <div className="tags">
                    {c.games.map((g) => (
                      <span className="tag" key={g.game_id}>
                        {g.game_name} · {g.rank}
                        {g.rank_verified ? ' ✓' : ''}
                      </span>
                    ))}
                  </div>
                  <div className="row between">
                    <Stars value={c.rating_avg} count={c.rating_count} />
                    <TrustPill score={c.trust_score} />
                  </div>
                  <div className="row between comp-foot">
                    <span className="price">
                      {vnd(c.hourly_rate)}
                      <small>/giờ</small>
                    </span>
                    <span className="muted small">{c.next_slot ? `Rảnh: ${fmtTime(c.next_slot)}` : 'Chưa có lịch rảnh'}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
