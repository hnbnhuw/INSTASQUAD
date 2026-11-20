import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, vnd, fmtTime } from '../api.js';
import { useAsync, Loading, ErrorBox, Empty, StatusBadge, Countdown } from '../ui.jsx';
import { useAuth, onRealtime } from '../auth.jsx';

const TABS = {
  active: ['AWAITING_ESCROW', 'PENDING_COMPANION', 'ACCEPTED', 'IN_SESSION', 'AWAITING_CONFIRMATION', 'DISPUTED'],
  done: ['COMPLETED', 'RESOLVED_REFUNDED', 'RESOLVED_RELEASED', 'CANCELLED', 'EXPIRED'],
};

export default function Bookings() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(() => get('/bookings'), []);
  const [tab, setTab] = useState('active');
  useEffect(() => onRealtime('booking', () => reload(true)), [reload]);
  useEffect(() => onRealtime('resync', () => reload(true)), [reload]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const list = data.bookings.filter((b) => TABS[tab].includes(b.status));
  const isComp = user.role === 'COMPANION';
  const waiting = data.bookings.filter((b) => b.status === 'PENDING_COMPANION');
  return (
    <>
      <h1>{isComp ? 'Đơn nhận được' : 'Đơn đặt lịch của tôi'}</h1>
      {isComp && waiting.length > 0 && (
        <div className="alert alert-warn">
          Bạn có <b>{waiting.length}</b> yêu cầu đang chờ trả lời. Quá 180 giây đơn tự hủy và bạn bị trừ 3 điểm tín nhiệm.
        </div>
      )}
      <div className="tabs">
        <button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}>
          Đang xử lý ({data.bookings.filter((b) => TABS.active.includes(b.status)).length})
        </button>
        <button className={tab === 'done' ? 'on' : ''} onClick={() => setTab('done')}>
          Đã kết thúc ({data.bookings.filter((b) => TABS.done.includes(b.status)).length})
        </button>
      </div>
      {list.length === 0 ? (
        <Empty>
          Chưa có đơn nào. {!isComp && <Link to="/">Tìm Companion</Link>}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Mã đơn</th>
                <th>{isComp ? 'Renter' : 'Companion'}</th>
                <th>Game</th>
                <th>Giờ hẹn</th>
                <th className="num">Tổng phí</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link to={`/bookings/${b.id}`}>{b.code}</Link>
                  </td>
                  <td>{isComp ? b.renter_name : b.companion_name}</td>
                  <td>{b.game_name}</td>
                  <td>
                    {fmtTime(b.start_at)} · {b.hours}h
                  </td>
                  <td className="num">{vnd(b.total_fee_snapshot)}</td>
                  <td>
                    <StatusBadge status={b.status} />
                    {b.status === 'PENDING_COMPANION' && b.respond_deadline && (
                      <div className="small">
                        <Countdown to={b.respond_deadline} prefix="còn " />
                      </div>
                    )}
                    {b.status === 'AWAITING_ESCROW' && b.held_until && (
                      <div className="small">
                        <Countdown to={b.held_until} prefix="giữ chỗ " />
                      </div>
                    )}
                  </td>
                  <td>
                    <Link className="btn btn-sm btn-ghost" to={`/bookings/${b.id}`}>
                      Chi tiết
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
