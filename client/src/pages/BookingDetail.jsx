import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, vnd, fmtTime, fmtHour, newKey, CANCEL_REASON, ESCROW_LABEL, ACCOUNT_LABEL } from '../api.js';
import { useAsync, Loading, ErrorBox, StatusBadge, Countdown, ConfirmButton, useToast, Avatar, Badge, Field } from '../ui.jsx';
import { useAuth, onRealtime } from '../auth.jsx';
import Room from './Room.jsx';
import DisputePanel from './DisputePanel.jsx';

const FLOW = ['AWAITING_ESCROW', 'PENDING_COMPANION', 'ACCEPTED', 'IN_SESSION', 'AWAITING_CONFIRMATION', 'COMPLETED'];
const FLOW_LABEL = ['Giữ chỗ', 'Ký quỹ & chờ phản hồi', 'Đã chấp nhận', 'Phiên chơi', 'Nghiệm thu', 'Hoàn tất'];

export default function BookingDetail() {
  const { id } = useParams();
  const { refresh } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get(`/bookings/${id}`), [id]);
  const [actErr, setActErr] = useState(null);
  useEffect(() => onRealtime('booking', (e) => String(e.bookingId) === String(id) && reload(true)), [id, reload]);
  useEffect(() => onRealtime('resync', () => reload(true)), [reload]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const b = data.booking;
  const role = b.viewerRole;
  const act = async (path, body, okMsg) => {
    setActErr(null);
    try {
      await post(`/bookings/${b.id}/${path}`, body);
      if (okMsg) toast(okMsg, 'success');
    } catch (e) {
      setActErr(e);
      if (e.code !== 'INSUFFICIENT_BALANCE') toast(e.message, 'error');
    }
    await reload(true);
    refresh();
  };
  const step = FLOW.indexOf(b.status);
  const isTerminalOther = step < 0;

  return (
    <div className="detail-layout">
      <div className="stack">
        <section className="card">
          <div className="row between wrap">
            <div>
              <div className="muted small">
                <Link to="/bookings">← Đơn của tôi</Link>
              </div>
              <h1 className="mb0">
                Đơn {b.code} <StatusBadge status={b.status} />
              </h1>
              {b.cancel_reason && <div className="muted">Lý do: {CANCEL_REASON[b.cancel_reason] || b.cancel_reason}</div>}
            </div>
            <div className="price big">{vnd(b.total_fee_snapshot)}</div>
          </div>
          {!isTerminalOther ? (
            <ol className="stepper">
              {FLOW.map((s, i) => (
                <li key={s} className={i < step ? 'done' : i === step ? 'cur' : ''}>
                  <span>{i + 1}</span>
                  {FLOW_LABEL[i]}
                </li>
              ))}
            </ol>
          ) : null}
          <div className="info-grid">
            <div>
              <span className="muted small">Companion</span>
              <div className="row gap">
                <Avatar name={b.companion.display_name} hue={b.companion.avatar_hue} size={32} />
                <Link to={`/companions/${b.companion.id}`}>{b.companion.display_name}</Link>
              </div>
            </div>
            <div>
              <span className="muted small">Renter</span>
              <div>{b.renter.display_name}</div>
            </div>
            <div>
              <span className="muted small">Game</span>
              <div>{b.game.name}</div>
            </div>
            <div>
              <span className="muted small">Giờ hẹn</span>
              <div>
                {fmtTime(b.start_at)} – {fmtHour(b.end_at)} ({b.hours} giờ)
              </div>
            </div>
            <div>
              <span className="muted small">Đơn giá đã chốt</span>
              <div>{vnd(b.hourly_rate_snapshot)}/giờ</div>
            </div>
            <div>
              <span className="muted small">Ký quỹ</span>
              <div>{b.escrow ? <Badge tone={b.escrow.status === 'FROZEN' ? 'danger' : b.escrow.status === 'HELD' ? 'warn' : 'muted'}>{ESCROW_LABEL[b.escrow.status]} · {vnd(b.escrow.amount)}</Badge> : <span className="muted">Chưa ký quỹ</span>}</div>
            </div>
          </div>
          {b.note && <p className="muted">Ghi chú: {b.note}</p>}
        </section>

        <ActionPanel b={b} role={role} act={act} reload={reload} />
        <ErrorBox error={actErr} />

        {['ACCEPTED', 'IN_SESSION', 'AWAITING_CONFIRMATION', 'COMPLETED', 'DISPUTED', 'RESOLVED_REFUNDED', 'RESOLVED_RELEASED'].includes(b.status) && (b.isParty || b.dispute) && (
          <section className="card">
            <Room booking={b} />
          </section>
        )}

        {b.dispute && (
          <section className="card">
            <DisputePanel disputeId={b.dispute.id} booking={b} />
          </section>
        )}

        {['COMPLETED', 'RESOLVED_REFUNDED', 'RESOLVED_RELEASED'].includes(b.status) && b.isParty && <ReviewBox b={b} reload={reload} />}
      </div>

      <aside className="stack">
        <section className="card">
          <h3>Dòng tiền của đơn (sổ cái)</h3>
          {b.transactions.length === 0 && <div className="muted small">Chưa phát sinh bút toán.</div>}
          {b.transactions.map((t) => (
            <div key={t.id} className="txn">
              <div className="row between">
                <b className="small">{t.description}</b>
              </div>
              <code className="small muted">{t.reference}</code>
              <table className="mini">
                <tbody>
                  {t.entries.map((e, i) => (
                    <tr key={i}>
                      <td>{e.direction === 'DEBIT' ? 'Nợ' : 'Có'}</td>
                      <td>
                        {e.owner} · {ACCOUNT_LABEL[e.account_type] || e.account_type}
                      </td>
                      <td className={`num ${e.direction === 'DEBIT' ? 'neg' : 'pos'}`}>
                        {e.direction === 'DEBIT' ? '−' : '+'}
                        {vnd(e.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <small className="muted">{fmtTime(t.created_at)}</small>
            </div>
          ))}
        </section>
        <section className="card">
          <h3>Lịch sử trạng thái</h3>
          <ol className="timeline">
            {b.history.map((h) => (
              <li key={h.id}>
                <StatusBadge status={h.to_status} />
                <div className="small">{h.reason}</div>
                <small className="muted">
                  {fmtTime(h.created_at)} · {h.actor_name || 'Hệ thống'}
                  {h.ledger_txn_id ? ` · bút toán #${h.ledger_txn_id}` : ''}
                </small>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </div>
  );
}

function ActionPanel({ b, role, act, reload }) {
  const { wallet } = useAuth();
  const [topupBusy, setTopupBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const [showReport, setShowReport] = useState(false);
  const toast = useToast();

  if (b.status === 'AWAITING_ESCROW' && role === 'RENTER') {
    const short = Math.max(0, b.total_fee_snapshot - (wallet?.available || 0));
    return (
      <section className="card action">
        <h3>Bước tiếp theo: ký quỹ</h3>
        <p>
          Khung giờ đang được giữ cho bạn: <Countdown to={b.held_until} onEnd={() => setTimeout(() => reload(true), 2500)} />. Hết thời gian mà chưa ký quỹ, khung giờ tự mở lại.
        </p>
        <div className="row between">
          <span>Cần ký quỹ</span>
          <b>{vnd(b.total_fee_snapshot)}</b>
        </div>
        <div className="row between">
          <span>Số dư khả dụng</span>
          <b>{vnd(wallet?.available)}</b>
        </div>
        {short > 0 ? (
          <>
            <div className="alert alert-warn">Còn thiếu {vnd(short)}. Nạp thêm qua cổng thanh toán (mô phỏng):</div>
            <div className="row gap wrap">
              {['VNPAY_MOCK', 'MOMO_MOCK'].map((m) => (
                <button
                  key={m}
                  className="btn"
                  disabled={topupBusy}
                  onClick={async () => {
                    setTopupBusy(true);
                    try {
                      const r = await post('/payments/topup', { amount: Math.max(short, 10000), method: m, idempotencyKey: newKey('tp'), bookingId: b.id });
                      window.location.href = r.payUrl;
                    } catch (e) {
                      toast(e.message, 'error');
                      setTopupBusy(false);
                    }
                  }}
                >
                  Nạp {vnd(Math.max(short, 10000))} qua {m === 'VNPAY_MOCK' ? 'VNPay' : 'MoMo'}
                </button>
              ))}
            </div>
          </>
        ) : (
          <ConfirmButton className="btn btn-block" onClick={() => act('escrow', {}, 'Ký quỹ thành công, đang chờ Companion phản hồi')}>
            Ký quỹ {vnd(b.total_fee_snapshot)} từ ví
          </ConfirmButton>
        )}
        <ConfirmButton className="btn btn-ghost btn-sm" confirm="Hủy yêu cầu đặt lịch này? (chưa phát sinh tiền)" onClick={() => act('cancel', {}, 'Đã hủy yêu cầu')}>
          Không nạp thêm – hủy yêu cầu
        </ConfirmButton>
      </section>
    );
  }

  if (b.status === 'PENDING_COMPANION') {
    return (
      <section className="card action">
        <h3>{role === 'COMPANION' ? 'Yêu cầu đặt lịch mới' : 'Đang chờ Companion phản hồi'}</h3>
        <p className="big-count">
          <Countdown to={b.respond_deadline} onEnd={() => setTimeout(() => reload(true), 2500)} />
        </p>
        <p className="muted small">Tiền đã được giữ trong Escrow. Quá 180 giây không trả lời: đơn tự hủy, hoàn 100% cho Renter và Companion bị trừ 3 điểm tín nhiệm.</p>
        {role === 'COMPANION' && (
          <div className="row gap">
            <ConfirmButton className="btn" onClick={() => act('respond', { decision: 'ACCEPT' }, 'Đã chấp nhận đơn')}>
              Chấp nhận
            </ConfirmButton>
            <ConfirmButton className="btn btn-danger" confirm="Từ chối đơn này? Renter được hoàn 100%." onClick={() => act('respond', { decision: 'REJECT' }, 'Đã từ chối, Renter được hoàn tiền')}>
              Từ chối
            </ConfirmButton>
          </div>
        )}
        {role === 'RENTER' && <CancelBox b={b} act={act} />}
      </section>
    );
  }

  if (b.status === 'ACCEPTED') {
    return (
      <section className="card action">
        <h3>Đơn đã được chấp nhận</h3>
        <p>
          Phiên chơi tự bắt đầu lúc <b>{fmtTime(b.start_at)}</b> (<Countdown to={b.start_at} prefix="còn " onEnd={() => setTimeout(() => reload(true), 2500)} />
          ).
        </p>
        {role === 'RENTER' && <CancelBox b={b} act={act} />}
      </section>
    );
  }

  if (b.status === 'IN_SESSION') {
    return (
      <section className="card action">
        <h3>Phiên chơi đang diễn ra</h3>
        <p>
          Kết thúc lúc {fmtHour(b.end_at)} (<Countdown to={b.end_at} prefix="còn " onEnd={() => setTimeout(() => reload(true), 2500)} />
          ). Sau đó Renter có 15 phút để nghiệm thu.
        </p>
        {role === 'RENTER' && <ReportButton show={showReport} setShow={setShowReport} reason={reason} setReason={setReason} detail={detail} setDetail={setDetail} act={act} label="Companion vắng mặt / có sự cố? Báo sự cố" />}
      </section>
    );
  }

  if (b.status === 'AWAITING_CONFIRMATION') {
    return (
      <section className="card action">
        <h3>{role === 'RENTER' ? 'Nghiệm thu phiên chơi' : 'Chờ Renter nghiệm thu'}</h3>
        <p>
          Hạn nghiệm thu: <Countdown to={b.confirm_deadline} onEnd={() => setTimeout(() => reload(true), 2500)} />. Quá hạn không phản hồi, hệ thống tự nghiệm thu (quy ước demo) và giải ngân 88% cho Companion, 12% phí nền tảng.
        </p>
        {role === 'RENTER' && (
          <>
            <ConfirmButton className="btn btn-block" confirm={`Xác nhận hoàn tất? ${vnd(b.total_fee_snapshot)} sẽ được giải ngân cho Companion.`} onClick={() => act('confirm', {}, 'Đã nghiệm thu, tiền đã giải ngân')}>
              ✔ Hoàn tất – giải ngân cho Companion
            </ConfirmButton>
            <ReportButton show={showReport} setShow={setShowReport} reason={reason} setReason={setReason} detail={detail} setDetail={setDetail} act={act} label="Báo sự cố (từ chối nghiệm thu)" />
          </>
        )}
      </section>
    );
  }
  return null;
}

function ReportButton({ show, setShow, reason, setReason, detail, setDetail, act, label }) {
  if (!show)
    return (
      <button className="btn btn-ghost btn-danger-text" onClick={() => setShow(true)}>
        ⚠ {label}
      </button>
    );
  return (
    <div className="report">
      <div className="alert alert-warn small">Khi gửi khiếu nại, toàn bộ tiền ký quỹ bị đóng băng ngay và chuyển cho CS xử lý.</div>
      <Field label="Lý do">
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">— Chọn lý do —</option>
          <option>Companion vắng mặt / vào trễ</option>
          <option>Phiên bị gián đoạn</option>
          <option>Companion có thái độ tiêu cực</option>
          <option>Dịch vụ không đúng cam kết</option>
        </select>
      </Field>
      <Field label="Mô tả chi tiết (tùy chọn)">
        <textarea rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} />
      </Field>
      <div className="row gap">
        <ConfirmButton className="btn btn-danger" disabled={!reason} onClick={() => act('dispute', { reason, detail }, 'Đã gửi khiếu nại, tiền đã được đóng băng')}>
          Gửi khiếu nại
        </ConfirmButton>
        <button className="btn btn-ghost" onClick={() => setShow(false)}>
          Đóng
        </button>
      </div>
    </div>
  );
}

function CancelBox({ b, act }) {
  const p = b.cancelPreview;
  if (!p) return null;
  if (!p.allowed) return <div className="muted small">{p.note}</div>;
  return (
    <div className="cancel-box">
      <div className="small">
        <b>Nếu hủy bây giờ:</b> {p.note}
        <div className="row gap wrap">
          <span>Hoàn cho bạn: <b>{vnd(p.refund)}</b></span>
          {p.companion > 0 && <span>Companion nhận: <b>{vnd(p.companion)}</b></span>}
          {p.platform > 0 && <span>Nền tảng: <b>{vnd(p.platform)}</b></span>}
        </div>
        <div className="muted">Quy tắc: còn ≥ 30 phút hoàn 100%; 10–29 phút hoàn 70%; dưới 10 phút phạt 100%. Số tiền cuối cùng do máy chủ tính tại thời điểm hủy.</div>
      </div>
      <ConfirmButton className="btn btn-ghost btn-danger-text btn-sm" confirm={`Xác nhận hủy đơn ${b.code}? ${p.note}`} onClick={() => act('cancel', {}, 'Đã hủy đơn')}>
        Hủy đơn
      </ConfirmButton>
    </div>
  );
}

function ReviewBox({ b, reload }) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState(null);
  const toast = useToast();
  if (b.myReview)
    return (
      <section className="card">
        <h3>Đánh giá của bạn</h3>
        <div className="stars">{'★'.repeat(b.myReview.rating)}{'☆'.repeat(5 - b.myReview.rating)}</div>
        <p>{b.myReview.comment}</p>
      </section>
    );
  return (
    <section className="card">
      <h3>Đánh giá {b.viewerRole === 'RENTER' ? 'Companion' : 'Renter'}</h3>
      <p className="muted small">Không bắt buộc. Mỗi người chỉ đánh giá một lần; đánh giá được dùng để tính lại TrustScore.</p>
      <div className="star-input">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)} aria-label={`${n} sao`}>
            ★
          </button>
        ))}
      </div>
      <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Nhận xét của bạn…" maxLength={1000} />
      <ErrorBox error={err} />
      <ConfirmButton
        className="btn"
        onClick={async () => {
          try {
            await post(`/bookings/${b.id}/review`, { rating, comment });
            toast('Cảm ơn bạn đã đánh giá!', 'success');
            reload(true);
          } catch (e) {
            setErr(e);
          }
        }}
      >
        Gửi đánh giá
      </ConfirmButton>
    </section>
  );
}
