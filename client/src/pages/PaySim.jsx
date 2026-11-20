// Trang cổng thanh toán MÔ PHỎNG. Mỗi nút làm "cổng" gửi callback đã ký HMAC về hệ thống
// qua đúng handler IPN thật (/api/payments/gateway/callback dùng chung logic).
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, vnd, fmtTime } from '../api.js';
import { useAsync, Loading, ErrorBox, Badge, ConfirmButton, useToast } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

export default function PaySim() {
  const { gtx } = useParams();
  const { refresh } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const { data, loading, error, reload } = useAsync(() => get(`/payments/sim/${gtx}`), [gtx]);
  const [result, setResult] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const p = data.payment;
  const send = async (outcome, times = 1) => {
    const r = await post(`/payments/sim/${gtx}/complete`, { outcome, times });
    setResult(r);
    await refresh();
    await reload(true);
    const f = r.results[0];
    if (f.outcome === 'CREDITED') toast(`Nạp thành công ${vnd(p.amount)}`, 'success');
    if (f.outcome === 'MARKED_FAILED') toast('Thanh toán thất bại – ví không thay đổi', 'error');
    if (p.booking_id && f.outcome !== 'STILL_PENDING') setTimeout(() => nav(`/bookings/${p.booking_id}`), 1500);
  };
  return (
    <div className="paysim">
      <div className={`card gateway ${p.method === 'MOMO_MOCK' ? 'momo' : 'vnpay'}`}>
        <div className="gw-head">
          <b>{p.method === 'MOMO_MOCK' ? 'MoMo' : 'VNPay'}</b> <span className="badge badge-warn">SANDBOX MÔ PHỎNG</span>
        </div>
        <div className="gw-body">
          <div className="muted small">Thanh toán cho INSTASQUAD</div>
          <div className="gw-amount">{vnd(p.amount)}</div>
          <div className="small">
            Mã giao dịch: <code>{p.gateway_txn_id}</code>
          </div>
          <div className="small">
            Trạng thái: <Badge tone={p.status === 'SUCCESS' ? 'ok' : p.status === 'PENDING' ? 'warn' : 'danger'}>{p.status}</Badge>
          </div>
          {p.booking_id && <div className="small">Gắn với đơn đặt lịch #{p.booking_id}: thành công sẽ tự động ký quỹ nếu đủ số dư.</div>}
          {p.status === 'PENDING' ? (
            <div className="stack mt">
              <ConfirmButton className="btn btn-block" onClick={() => send('SUCCESS')}>
                ✔ Thanh toán thành công
              </ConfirmButton>
              <ConfirmButton className="btn btn-block btn-ghost" onClick={() => send('SUCCESS', 3)}>
                ✔ Thành công + gửi callback lặp 3 lần (test chống cộng trùng)
              </ConfirmButton>
              <ConfirmButton className="btn btn-block btn-danger" onClick={() => send('FAILED')}>
                ✖ Thanh toán thất bại
              </ConfirmButton>
              <ConfirmButton className="btn btn-block btn-ghost" onClick={() => send('PENDING')}>
                … Cổng đang xử lý (PENDING – quá 15 phút sẽ hết hạn)
              </ConfirmButton>
            </div>
          ) : (
            <div className="stack mt">
              <ConfirmButton className="btn btn-ghost btn-block" onClick={() => send(p.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED')}>
                Gửi lại callback (sẽ bị bỏ qua vì đã xử lý)
              </ConfirmButton>
              <Link className="btn btn-block" to={p.booking_id ? `/bookings/${p.booking_id}` : '/wallet'}>
                Quay về {p.booking_id ? 'đơn đặt lịch' : 'ví'}
              </Link>
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <h3>Nhật ký callback (IPN)</h3>
        {result && (
          <div className="alert alert-info small">
            Kết quả lần gửi gần nhất: {result.results.map((r) => r.outcome).join(', ')}
            {result.results[0].followUp && <div>Xử lý tiếp: {JSON.stringify(result.results[0].followUp)}</div>}
          </div>
        )}
        {data.callbacks.length === 0 ? (
          <div className="muted small">Chưa nhận callback nào.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Trạng thái báo</th>
                <th>Chữ ký</th>
                <th>Kết quả xử lý</th>
              </tr>
            </thead>
            <tbody>
              {data.callbacks.map((c, i) => (
                <tr key={i}>
                  <td>{fmtTime(c.created_at)}</td>
                  <td>{c.reported_status}</td>
                  <td>{c.signature_valid ? '✔ hợp lệ' : '✖ sai'}</td>
                  <td>
                    <code>{c.outcome}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
