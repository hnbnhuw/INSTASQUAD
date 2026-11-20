import { useEffect, useState } from 'react';
import { NavLink, Routes, Route, Link, useParams, useNavigate } from 'react-router-dom';
import { get, post, vnd, fmtTime, BOOKING_LABEL, ACCOUNT_LABEL, ROLE_LABEL, KYC_LABEL, setServerNow } from '../../api.js';
import { useAsync, Loading, ErrorBox, Empty, Badge, StatusBadge, ConfirmButton, Field, useToast, TrustPill } from '../../ui.jsx';
import { useAuth, onRealtime } from '../../auth.jsx';
import { EvidenceList, EvidenceForm } from '../DisputePanel.jsx';

export default function Admin() {
  const { user } = useAuth();
  const isAdmin = user.role === 'ADMIN';
  return (
    <div className="admin">
      <nav className="subnav">
        {isAdmin && (
          <NavLink to="/admin" end>
            Tổng quan
          </NavLink>
        )}
        <NavLink to="/admin/disputes">Khiếu nại</NavLink>
        {isAdmin && <NavLink to="/admin/withdrawals">Rút tiền</NavLink>}
        {isAdmin && <NavLink to="/admin/ops">Cảnh báo đối soát</NavLink>}
        {isAdmin && <NavLink to="/admin/ledger">Sổ cái & đối soát</NavLink>}
        {isAdmin && <NavLink to="/admin/users">Người dùng</NavLink>}
        {isAdmin && <NavLink to="/admin/audit">Nhật ký</NavLink>}
        {isAdmin && <NavLink to="/admin/demo">Công cụ demo</NavLink>}
      </nav>
      <Routes>
        <Route index element={isAdmin ? <Dashboard /> : <Disputes />} />
        <Route path="disputes" element={<Disputes />} />
        <Route path="disputes/:id" element={<DisputeCase />} />
        {isAdmin && (
          <>
            <Route path="withdrawals" element={<Withdrawals />} />
            <Route path="ops" element={<Ops />} />
            <Route path="ledger" element={<Ledger />} />
            <Route path="users" element={<Users />} />
            <Route path="audit" element={<Audit />} />
            <Route path="demo" element={<Demo />} />
          </>
        )}
      </Routes>
    </div>
  );
}

function Dashboard() {
  const { data, loading, error, reload } = useAsync(() => get('/admin/dashboard'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const d = data;
  const rev = d.revenue || {};
  return (
    <>
      <h1>Dashboard quản trị</h1>
      <p className="muted small">Số liệu tính trực tiếp từ cơ sở dữ liệu (dữ liệu demo seed + thao tác của bạn).</p>
      <div className="stat-grid">
        <div className="stat primary">
          <span>GMV (đơn hoàn tất)</span>
          <b>{vnd(d.gmv)}</b>
        </div>
        <div className="stat">
          <span>Hoa hồng 12%</span>
          <b>{vnd(rev.COMMISSION || 0)}</b>
        </div>
        <div className="stat">
          <span>Phí hủy muộn</span>
          <b>{vnd(rev.LATE_CANCEL_FEE || 0)}</b>
        </div>
        <div className="stat">
          <span>Phạt khiếu nại</span>
          <b>{vnd(rev.DISPUTE_PENALTY || 0)}</b>
        </div>
        <div className="stat">
          <span>Booking tạo / hoàn tất</span>
          <b>
            {d.bookingsCreated} / {d.bookingsCompleted}
          </b>
        </div>
        <div className="stat">
          <span>Conversion (xem hồ sơ → đặt lịch)</span>
          <b>{d.conversionRate == null ? '—' : `${d.conversionRate}%`}</b>
          <small className="muted">
            {d.conversionPairs.converted}/{d.conversionPairs.viewed} lượt xem (người xem × Companion) · mục tiêu BR-003 ≥ 7,5%
          </small>
        </div>
        <div className="stat">
          <span>Khiếu nại (đã xử lý/tổng)</span>
          <b>
            {d.disputes.resolved}/{d.disputes.total}
          </b>
          <small className="muted">TB xử lý: {d.disputes.avgResolveMinutes ?? '—'} phút (mục tiêu &lt; 45)</small>
        </div>
        <div className={`stat ${d.openAlerts ? 'danger' : ''}`}>
          <span>Cảnh báo đối soát mở</span>
          <b>{d.openAlerts}</b>
        </div>
        <div className="stat">
          <span>Rút tiền chờ xử lý</span>
          <b>{d.pendingWithdrawals}</b>
        </div>
        <div className="stat">
          <span>Kết nối realtime</span>
          <b>{d.realtimeConnections}</b>
        </div>
      </div>
      <section className="card">
        <h3>Booking theo trạng thái</h3>
        <div className="bars">
          {Object.entries(d.bookingsByStatus).map(([k, v]) => {
            const max = Math.max(...Object.values(d.bookingsByStatus));
            return (
              <div className="bar-row" key={k}>
                <span className="bar-label">{BOOKING_LABEL[k] || k}</span>
                <span className="bar">
                  <span style={{ width: `${(v / max) * 100}%` }} />
                </span>
                <b>{v}</b>
              </div>
            );
          })}
        </div>
        <p className="muted small">
          Người dùng: {Object.entries(d.users).map(([r, n]) => `${ROLE_LABEL[r]} ${n}`).join(' · ')}
        </p>
      </section>
    </>
  );
}

function Disputes() {
  const { data, loading, error, reload } = useAsync(() => get('/admin/disputes'), []);
  useEffect(() => onRealtime('notification', (n) => n.type?.startsWith('DISPUTE') && reload(true)), [reload]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <>
      <h1>Hàng chờ khiếu nại</h1>
      {data.disputes.length === 0 ? (
        <Empty>Không có khiếu nại.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Đơn</th>
                <th>Renter → Companion</th>
                <th>Lý do</th>
                <th className="num">Giá trị</th>
                <th>Mở lúc</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {data.disputes.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={`/admin/disputes/${d.id}`}>#{d.id}</Link>
                  </td>
                  <td>{d.code}</td>
                  <td>
                    {d.renter_name} → {d.companion_name}
                  </td>
                  <td>{d.reason}</td>
                  <td className="num">{vnd(d.total_fee_snapshot)}</td>
                  <td>{fmtTime(d.created_at)}</td>
                  <td>
                    <Badge tone={d.status.startsWith('RESOLVED') ? 'ok' : 'warn'}>{d.status_label}</Badge>
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

function DisputeCase() {
  const { id } = useParams();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get(`/admin/disputes/${id}/case`), [id]);
  const [fault, setFault] = useState(50);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const { dispute: d, booking: b, messages, events, companionTrust: t, policy } = data;
  const open = !d.status.startsWith('RESOLVED');
  const refund = fault >= policy.threshold;
  return (
    <>
      <div className="muted small">
        <Link to="/admin/disputes">← Hàng chờ</Link>
      </div>
      <h1>
        Khiếu nại #{d.id} · {b.code} <Badge tone={open ? 'warn' : 'ok'}>{d.status_label}</Badge>
      </h1>
      <div className="detail-layout">
        <div className="stack">
          <section className="card">
            <h3>Thông tin đơn</h3>
            <div className="info-grid">
              <div>
                <span className="muted small">Renter</span>
                <div>{b.renter.display_name}</div>
              </div>
              <div>
                <span className="muted small">Companion</span>
                <div>
                  {b.companion.display_name} <TrustPill score={b.companion.trust_score} />
                </div>
              </div>
              <div>
                <span className="muted small">Giờ hẹn</span>
                <div>
                  {fmtTime(b.start_at)} · {b.hours}h
                </div>
              </div>
              <div>
                <span className="muted small">Giá trị đơn</span>
                <div>{vnd(b.total_fee_snapshot)}</div>
              </div>
              <div>
                <span className="muted small">Ký quỹ</span>
                <div>
                  <Badge tone={b.escrow?.status === 'FROZEN' ? 'danger' : 'muted'}>{b.escrow?.status}</Badge> {vnd(b.escrow?.amount)}
                </div>
              </div>
              <div>
                <span className="muted small">Lịch sử Companion</span>
                <div className="small">
                  {t.completed} hoàn tất · {t.failed} lỗi · {t.complaints} khiếu nại · ★{t.ratingAvg}
                </div>
              </div>
            </div>
            <p>
              <b>Lý do khiếu nại:</b> {d.reason}
            </p>
          </section>
          <section className="card">
            <h3>Bằng chứng</h3>
            <EvidenceList evidence={d.evidence} />
            {open && <EvidenceForm disputeId={d.id} onDone={() => reload(true)} />}
          </section>
          <section className="card">
            <h3>Nhật ký chat phiên ({messages.length})</h3>
            <div className="chat small-chat">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.sender_id === b.renter.id ? '' : 'me'}`}>
                  <div className="bubble">
                    {m.body}
                    {m.flagged ? ' ⚠' : ''}
                  </div>
                  <small className="muted">
                    {m.sender_name} · {fmtTime(m.created_at)}
                  </small>
                </div>
              ))}
            </div>
            <h4>Sự kiện phiên (kết nối, gọi thoại, lọc tin nhắn)</h4>
            <ul className="small">
              {events.map((e) => (
                <li key={e.id}>
                  {fmtTime(e.created_at)} · {e.user_name || 'Hệ thống'} · <code>{e.type}</code> {e.detail || ''}
                </li>
              ))}
            </ul>
          </section>
        </div>
        <aside className="stack">
          {open ? (
            <>
              <section className="card">
                <h3>Phán quyết</h3>
                <Field label={`Tỷ lệ lỗi của Companion: ${fault}%`}>
                  <input type="range" min={0} max={100} value={fault} onChange={(e) => setFault(Number(e.target.value))} />
                </Field>
                <div className={`alert ${refund ? 'alert-warn' : 'alert-info'} small`}>
                  {refund ? (
                    <>
                      ≥ {policy.threshold}%: <b>hoàn 100%</b> ({vnd(b.total_fee_snapshot)}) cho Renter và <b>phạt Companion {policy.penaltyPct}%</b> ({vnd(Math.floor((b.total_fee_snapshot * policy.penaltyPct) / 100))}). Phần phạt không đủ số dư sẽ ghi nợ (quy ước demo).
                    </>
                  ) : (
                    <>
                      &lt; {policy.threshold}%: <b>giải phóng tiền</b> cho Companion 88% / nền tảng 12% (nhánh "Không" theo giả định nhóm – cần PO xác nhận).
                    </>
                  )}
                </div>
                <Field label="Lý do phán quyết (bắt buộc)">
                  <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Căn cứ vào bằng chứng nào…" />
                </Field>
                <ErrorBox error={err} />
                <ConfirmButton
                  className={`btn btn-block ${refund ? 'btn-danger' : ''}`}
                  disabled={reason.trim().length < 10}
                  confirm={`Xác nhận phán quyết lỗi ${fault}%? Thao tác tài chính không thể hoàn tác.`}
                  onClick={async () => {
                    setErr(null);
                    try {
                      await post(`/admin/disputes/${d.id}/decide`, { faultPercent: fault, reason });
                      toast('Đã phán quyết và xử lý tiền', 'success');
                      reload(true);
                    } catch (e) {
                      setErr(e);
                    }
                  }}
                >
                  Phán quyết & xử lý tiền
                </ConfirmButton>
              </section>
              {d.status === 'OPEN' && (
                <section className="card">
                  <h3>Chưa đủ bằng chứng?</h3>
                  <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Yêu cầu hai bên bổ sung…" />
                  <ConfirmButton
                    className="btn btn-ghost btn-block"
                    disabled={note.trim().length < 5}
                    onClick={async () => {
                      try {
                        await post(`/admin/disputes/${d.id}/request-evidence`, { note });
                        toast('Đã gửi yêu cầu bổ sung; tiền tiếp tục đóng băng', 'success');
                        setNote('');
                        reload(true);
                      } catch (e) {
                        toast(e.message, 'error');
                      }
                    }}
                  >
                    Yêu cầu bổ sung bằng chứng
                  </ConfirmButton>
                </section>
              )}
            </>
          ) : (
            <section className="card">
              <h3>Đã phán quyết</h3>
              <p>
                Lỗi Companion: <b>{d.fault_percent}%</b>
              </p>
              <p>{d.decision_reason}</p>
              <small className="muted">
                {d.decided_by_name} · {fmtTime(d.decided_at)}
              </small>
            </section>
          )}
          <section className="card">
            <h3>Bút toán liên quan</h3>
            {b.transactions.map((t2) => (
              <div key={t2.id} className="txn small">
                <b>{t2.description}</b>
                <div className="muted">
                  {t2.entries.map((e, i) => (
                    <div key={i}>
                      {e.direction === 'DEBIT' ? 'Nợ' : 'Có'} {e.owner} · {ACCOUNT_LABEL[e.account_type] || e.account_type}: {vnd(e.amount)}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}

function Withdrawals() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get('/admin/withdrawals'), []);
  const [reasons, setReasons] = useState({});
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const act = async (id, action, reason) => {
    try {
      await post(`/admin/withdrawals/${id}/${action}`, { reason });
      toast('Đã cập nhật yêu cầu rút tiền', 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
    reload(true);
  };
  return (
    <>
      <h1>Yêu cầu rút tiền (mô phỏng)</h1>
      <p className="muted small">PENDING → PROCESSING → COMPLETED / REJECTED. Từ chối sẽ trả tiền giữ về ví bằng bút toán sổ cái.</p>
      {data.withdrawals.length === 0 ? (
        <Empty>Chưa có yêu cầu.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Companion</th>
                <th className="num">Số tiền</th>
                <th>Mã nhận</th>
                <th>Tạo lúc</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {data.withdrawals.map((w) => (
                <tr key={w.id}>
                  <td>{w.id}</td>
                  <td>
                    {w.display_name}
                    <div className="muted small">{w.email}</div>
                  </td>
                  <td className="num">{vnd(w.amount)}</td>
                  <td>{w.payout_code}</td>
                  <td>{fmtTime(w.created_at)}</td>
                  <td>
                    <Badge tone={{ PENDING: 'warn', PROCESSING: 'info', COMPLETED: 'ok', REJECTED: 'danger' }[w.status]}>{w.status_label}</Badge>
                    {w.reject_reason && <div className="small muted">{w.reject_reason}</div>}
                  </td>
                  <td>
                    {w.status === 'PENDING' && (
                      <ConfirmButton className="btn btn-sm" onClick={() => act(w.id, 'process')}>
                        Duyệt xử lý
                      </ConfirmButton>
                    )}
                    {w.status === 'PROCESSING' && (
                      <ConfirmButton className="btn btn-sm" confirm={`Xác nhận đã chuyển ${vnd(w.amount)} (mô phỏng)?`} onClick={() => act(w.id, 'complete')}>
                        Đã chuyển
                      </ConfirmButton>
                    )}
                    {['PENDING', 'PROCESSING'].includes(w.status) && (
                      <div className="row gap mt">
                        <input placeholder="Lý do từ chối" value={reasons[w.id] || ''} onChange={(e) => setReasons({ ...reasons, [w.id]: e.target.value })} />
                        <ConfirmButton className="btn btn-sm btn-danger" disabled={(reasons[w.id] || '').trim().length < 5} onClick={() => act(w.id, 'reject', reasons[w.id])}>
                          Từ chối
                        </ConfirmButton>
                      </div>
                    )}
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

function Ops() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get('/admin/alerts'), []);
  const [notes, setNotes] = useState({});
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <>
      <h1>Cảnh báo đối soát</h1>
      <p className="muted small">
        Khi ghi sổ thất bại, mọi thay đổi bị hoàn tác (tiền giữ nguyên trạng thái) và cảnh báo được tạo tại đây. Kiểm toán viên có thể <b>thử lại</b> (dùng lại đúng reference ⇒ không ghi trùng) hoặc đóng
        cảnh báo kèm ghi chú.
      </p>
      {data.alerts.length === 0 ? (
        <Empty>Không có cảnh báo. Có thể tạo lỗi giả lập ở mục "Công cụ demo".</Empty>
      ) : (
        data.alerts.map((a) => (
          <section key={a.id} className={`card alert-card ${a.status === 'OPEN' ? 'open' : ''}`}>
            <div className="row between wrap">
              <b>
                #{a.id} · {a.operation} {a.booking_id && <Link to={`/bookings/${a.booking_id}`}>(đơn #{a.booking_id})</Link>}
              </b>
              <Badge tone={a.status === 'OPEN' ? 'danger' : 'ok'}>{a.status === 'OPEN' ? 'Đang mở' : 'Đã xử lý'}</Badge>
            </div>
            <div className="small">Lỗi: {a.error}</div>
            <code className="small muted">{a.payload}</code>
            <div className="small muted">
              {fmtTime(a.created_at)}
              {a.resolution && ` · Xử lý: ${a.resolution} (${fmtTime(a.resolved_at)})`}
            </div>
            {a.status === 'OPEN' && (
              <div className="row gap wrap mt">
                <ConfirmButton
                  className="btn btn-sm"
                  onClick={async () => {
                    try {
                      await post(`/admin/alerts/${a.id}/retry`);
                      toast('Thử lại thành công', 'success');
                    } catch (e) {
                      toast(`Thử lại thất bại: ${e.message}`, 'error');
                    }
                    reload(true);
                  }}
                >
                  Thử lại thao tác
                </ConfirmButton>
                <input placeholder="Ghi chú xử lý thủ công" value={notes[a.id] || ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                <ConfirmButton
                  className="btn btn-sm btn-ghost"
                  disabled={(notes[a.id] || '').trim().length < 5}
                  onClick={async () => {
                    try {
                      await post(`/admin/alerts/${a.id}/resolve`, { note: notes[a.id] });
                    } catch (e) {
                      toast(e.message, 'error');
                    }
                    reload(true);
                  }}
                >
                  Đóng cảnh báo
                </ConfirmButton>
              </div>
            )}
          </section>
        ))
      )}
    </>
  );
}

function Ledger() {
  const rec = useAsync(() => get('/admin/reconcile'), []);
  const led = useAsync(() => get('/admin/ledger'), []);
  return (
    <>
      <h1>Sổ cái & đối soát</h1>
      <section className="card">
        <div className="row between wrap">
          <h3 className="mb0">Kết quả đối soát</h3>
          <button className="btn btn-sm" onClick={() => rec.reload()}>
            Chạy đối soát lại
          </button>
        </div>
        {rec.loading && <Loading />}
        <ErrorBox error={rec.error} />
        {rec.data && (
          <>
            <div className={`alert ${rec.data.ok ? 'alert-ok' : 'alert-error'}`}>
              {rec.data.ok ? '✔ Sổ cái khớp: mọi giao dịch cân bằng, số dư cache = tổng bút toán, Escrow/rút tiền khớp tài khoản.' : `✖ Phát hiện ${rec.data.issues.length} sai lệch (không tự sửa).`}
            </div>
            <div className="row gap wrap small">
              <span>{rec.data.accounts} tài khoản</span>·<span>{rec.data.transactions} giao dịch</span>·<span>{rec.data.entries} bút toán</span>·<span>kiểm tra lúc {fmtTime(rec.data.checkedAt)}</span>
            </div>
            <div className="row gap wrap small mt">
              {Object.entries(rec.data.systemBalances).map(([k, v]) => (
                <span key={k} className="tag">
                  {k}: {vnd(v)}
                </span>
              ))}
            </div>
            {rec.data.issues.length > 0 && <pre className="ev-text">{JSON.stringify(rec.data.issues, null, 2)}</pre>}
          </>
        )}
      </section>
      <section className="card">
        <h3>100 giao dịch gần nhất</h3>
        {led.loading && <Loading />}
        {led.data && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Reference (idempotency)</th>
                  <th>Loại</th>
                  <th>Bút toán (Nợ = Có)</th>
                  <th>Thời gian</th>
                </tr>
              </thead>
              <tbody>
                {led.data.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td>
                      <code className="small">{t.reference}</code>
                      <div className="small muted">{t.description}</div>
                    </td>
                    <td className="small">{t.type}</td>
                    <td className="small">
                      {t.entries.map((e, i) => (
                        <div key={i}>
                          <span className={e.direction === 'DEBIT' ? 'neg' : 'pos'}>{e.direction === 'DEBIT' ? 'Nợ' : 'Có'}</span> {e.account}: {vnd(e.amount)}
                        </div>
                      ))}
                    </td>
                    <td className="small nowrap">{fmtTime(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Users() {
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get('/admin/users'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <>
      <h1>Người dùng</h1>
      <p className="muted small">Dữ liệu eKYC chỉ hiển thị dạng che (4 số cuối); CS/Admin không xem được mật khẩu.</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Tên / Email</th>
              <th>Vai trò</th>
              <th>eKYC</th>
              <th>Uy tín</th>
              <th className="num">Khả dụng</th>
              <th className="num">Ký quỹ/Đóng băng</th>
              <th>Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>
                  {u.display_name}
                  <div className="muted small">{u.email}</div>
                </td>
                <td>{ROLE_LABEL[u.role]}</td>
                <td className="small">
                  {KYC_LABEL[u.kyc_status]}
                  {u.kyc && <div className="muted">{u.kyc.id_masked}</div>}
                </td>
                <td>
                  <TrustPill score={u.trust_score} />
                </td>
                <td className="num">{vnd(u.wallet.available)}</td>
                <td className="num">
                  {vnd(u.wallet.escrow)} / {vnd(u.wallet.frozen)}
                  {u.wallet.receivable < 0 && <div className="neg small">Nợ {vnd(-u.wallet.receivable)}</div>}
                </td>
                <td>
                  {u.role !== 'ADMIN' && (
                    <ConfirmButton
                      className={`btn btn-sm ${u.status === 'ACTIVE' ? 'btn-ghost' : ''}`}
                      confirm={u.status === 'ACTIVE' ? `Khóa tài khoản ${u.email}?` : `Mở khóa ${u.email}?`}
                      onClick={async () => {
                        try {
                          await post(`/admin/users/${u.id}/status`, { status: u.status === 'ACTIVE' ? 'LOCKED' : 'ACTIVE' });
                        } catch (e) {
                          toast(e.message, 'error');
                        }
                        reload(true);
                      }}
                    >
                      {u.status === 'ACTIVE' ? 'Khóa' : 'Mở khóa'}
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Audit() {
  const { data, loading, error } = useAsync(() => get('/admin/audit'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  return (
    <>
      <h1>Nhật ký kiểm toán (audit log)</h1>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Thời gian</th>
              <th>Người thực hiện</th>
              <th>Hành động</th>
              <th>Đối tượng</th>
              <th>Dữ liệu</th>
            </tr>
          </thead>
          <tbody>
            {data.logs.map((l) => (
              <tr key={l.id}>
                <td className="nowrap small">{fmtTime(l.created_at)}</td>
                <td>{l.actor_name || 'Hệ thống'}</td>
                <td>
                  <code className="small">{l.action}</code>
                </td>
                <td className="small">
                  {l.entity} #{l.entity_id}
                </td>
                <td className="small muted mono-wrap">{l.data !== 'null' ? l.data : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Demo() {
  const toast = useToast();
  const nav = useNavigate();
  const { data, loading, error, reload } = useAsync(() => get('/admin/demo'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={{ ...error, message: 'Công cụ demo đang tắt (DEMO_TOOLS=false).' }} />;
  const clockAct = async (body) => {
    const r = await post('/admin/demo/clock', body);
    setServerNow(r.serverNow);
    const s = r.scheduler;
    toast(`Giờ hệ thống: ${fmtTime(r.serverNow)}. Scheduler: ${s.started} phiên bắt đầu, ${s.ended} kết thúc, ${s.autoConfirmed} tự nghiệm thu, ${s.timeouts} quá 180s, ${s.holds} hết giữ chỗ.`, 'success');
    reload(true);
  };
  return (
    <>
      <h1>Công cụ demo</h1>
      <div className="alert alert-warn">Chỉ có trong môi trường phát triển/demo (DEMO_TOOLS=true). Không tồn tại ở production.</div>
      <section className="card">
        <h3>Đồng hồ hệ thống</h3>
        <p>
          Giờ server hiện tại: <b>{fmtTime(data.serverNow)}</b> (lệch {Math.round(data.offsetMs / 60000)} phút so với giờ thật)
        </p>
        <p className="muted small">Dịch thời gian để demo 180 giây, giờ hẹn, 15 phút nghiệm thu mà không phải chờ. Sau khi dịch, scheduler chạy ngay.</p>
        <div className="row gap wrap">
          {[
            [3, '+3 phút (quá 180s)'],
            [11, '+11 phút (hết giữ chỗ)'],
            [16, '+16 phút (quá hạn nghiệm thu)'],
            [60, '+1 giờ'],
            [180, '+3 giờ'],
            [1440, '+1 ngày'],
          ].map(([m, l]) => (
            <ConfirmButton key={m} className="btn btn-sm" onClick={() => clockAct({ advanceMinutes: m })}>
              {l}
            </ConfirmButton>
          ))}
          <ConfirmButton className="btn btn-sm btn-ghost" onClick={() => clockAct({ reset: true })}>
            Về giờ thật
          </ConfirmButton>
        </div>
      </section>
      <section className="card">
        <h3>Giả lập lỗi ghi sổ</h3>
        <p className="small">
          Khi bật, <b>lần ghi sổ kế tiếp</b> sẽ thất bại để minh họa nhánh “Ghi sổ thành công? → Không” của BPMN: hoàn tác toàn bộ, tiền giữ nguyên, tạo cảnh báo đối soát.
        </p>
        <p>
          Trạng thái: {data.ledgerFaultArmed ? <Badge tone="danger">ĐANG BẬT – lần ghi sổ tới sẽ lỗi</Badge> : <Badge tone="muted">Tắt</Badge>}
        </p>
        <ConfirmButton
          className={`btn btn-sm ${data.ledgerFaultArmed ? 'btn-ghost' : 'btn-danger'}`}
          onClick={async () => {
            await post('/admin/demo/ledger-fault', { armed: !data.ledgerFaultArmed });
            reload(true);
          }}
        >
          {data.ledgerFaultArmed ? 'Tắt' : 'Bật lỗi cho lần ghi sổ kế tiếp'}
        </ConfirmButton>
      </section>
      <section className="card">
        <h3>Đặt lại dữ liệu demo</h3>
        <p className="small">Xóa toàn bộ dữ liệu và nạp lại bộ seed (tài khoản demo, lịch rảnh, lịch sử đơn, 1 khiếu nại mở).</p>
        <ConfirmButton
          className="btn btn-sm btn-danger"
          confirm="Xóa toàn bộ dữ liệu hiện tại và seed lại?"
          onClick={async () => {
            await post('/admin/demo/reset', { confirm: 'RESET' });
            toast('Đã reset dữ liệu demo. Vui lòng đăng nhập lại.', 'success');
            nav('/login');
            window.location.reload();
          }}
        >
          Reset dữ liệu demo
        </ConfirmButton>
      </section>
    </>
  );
}
