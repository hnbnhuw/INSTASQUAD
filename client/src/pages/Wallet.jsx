import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, vnd, fmtTime, newKey, ACCOUNT_LABEL } from '../api.js';
import { useAsync, Loading, ErrorBox, Empty, Badge, ConfirmButton, Field, useToast } from '../ui.jsx';
import { useAuth, onRealtime } from '../auth.jsx';

const PAY_TONE = { PENDING: 'warn', SUCCESS: 'ok', FAILED: 'danger', EXPIRED: 'muted' };
const W_TONE = { PENDING: 'warn', PROCESSING: 'info', COMPLETED: 'ok', REJECTED: 'danger' };

export default function Wallet() {
  const { user, refresh } = useAuth();
  const { data, loading, error, reload } = useAsync(() => get('/wallet'), []);
  const [amount, setAmount] = useState(200000);
  const [method, setMethod] = useState('VNPAY_MOCK');
  const [err, setErr] = useState(null);
  const nav = useNavigate();
  useEffect(() => onRealtime('notification', () => reload(true)), [reload]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const w = data.wallet;
  return (
    <>
      <h1>Ví của tôi</h1>
      <div className="stat-grid">
        <div className="stat primary">
          <span>Số dư khả dụng</span>
          <b>{vnd(w.available)}</b>
        </div>
        <div className="stat">
          <span>Đang ký quỹ</span>
          <b>{vnd(w.escrow)}</b>
        </div>
        <div className="stat">
          <span>Đóng băng (khiếu nại)</span>
          <b>{vnd(w.frozen)}</b>
        </div>
        {user.role === 'COMPANION' && (
          <div className="stat">
            <span>Chờ rút</span>
            <b>{vnd(w.withdrawHold)}</b>
          </div>
        )}
        {w.receivable < 0 && (
          <div className="stat danger">
            <span>Nợ phạt</span>
            <b>{vnd(-w.receivable)}</b>
          </div>
        )}
      </div>
      <p className="muted small">Số dư chỉ thay đổi qua các bút toán sổ cái ghi kép bên dưới – không có thao tác sửa số dư trực tiếp.</p>

      <div className="two-col">
        <section className="card">
          <h2>Nạp tiền</h2>
          <div className="alert alert-info small">Cổng VNPay/MoMo là <b>mô phỏng</b>: không dùng thẻ/tài khoản thật.</div>
          <Field label="Số tiền (VND)">
            <input type="number" min={10000} step={10000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </Field>
          <div className="row gap wrap">
            {[100000, 200000, 500000, 1000000].map((v) => (
              <button key={v} className="chip" onClick={() => setAmount(v)}>
                {vnd(v)}
              </button>
            ))}
          </div>
          <div className="seg">
            <button className={method === 'VNPAY_MOCK' ? 'on' : ''} onClick={() => setMethod('VNPAY_MOCK')}>
              VNPay (mock)
            </button>
            <button className={method === 'MOMO_MOCK' ? 'on' : ''} onClick={() => setMethod('MOMO_MOCK')}>
              MoMo (mock)
            </button>
          </div>
          <ErrorBox error={err} />
          <ConfirmButton
            className="btn btn-block"
            onClick={async () => {
              setErr(null);
              try {
                const r = await post('/payments/topup', { amount, method, idempotencyKey: newKey('tp') });
                nav(r.payUrl);
              } catch (e) {
                setErr(e);
              }
            }}
          >
            Tiếp tục tới cổng thanh toán
          </ConfirmButton>
        </section>
        {user.role === 'COMPANION' && <WithdrawForm wallet={w} onDone={() => (reload(true), refresh())} />}
      </div>

      {user.role === 'COMPANION' && (
        <section className="card">
          <h2>Yêu cầu rút tiền</h2>
          {data.withdrawals.length === 0 ? (
            <Empty>Chưa có yêu cầu rút tiền.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Thời gian</th>
                    <th>Mã nhận tiền</th>
                    <th className="num">Số tiền</th>
                    <th>Trạng thái</th>
                  </tr>
                </thead>
                <tbody>
                  {data.withdrawals.map((x) => (
                    <tr key={x.id}>
                      <td>{x.id}</td>
                      <td>{fmtTime(x.created_at)}</td>
                      <td>{x.payout_code}</td>
                      <td className="num">{vnd(x.amount)}</td>
                      <td>
                        <Badge tone={W_TONE[x.status]}>{x.status_label}</Badge>
                        {x.reject_reason && <div className="small muted">{x.reject_reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2>Giao dịch nạp tiền</h2>
        {data.payments.length === 0 ? (
          <Empty>Chưa có giao dịch nạp.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Mã cổng</th>
                  <th>Thời gian</th>
                  <th>Phương thức</th>
                  <th className="num">Số tiền</th>
                  <th>Trạng thái</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <code>{p.gateway_txn_id}</code>
                    </td>
                    <td>{fmtTime(p.created_at)}</td>
                    <td>{p.method === 'VNPAY_MOCK' ? 'VNPay (mock)' : 'MoMo (mock)'}</td>
                    <td className="num">{vnd(p.amount)}</td>
                    <td>
                      <Badge tone={PAY_TONE[p.status]}>{p.status}</Badge>
                      {p.callback_count > 1 && <div className="small muted">{p.callback_count} callback (đã chống trùng)</div>}
                    </td>
                    <td>{p.status === 'PENDING' && <Link to={`/pay/${p.gateway_txn_id}`}>Tiếp tục</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Sổ giao dịch (ledger)</h2>
        {data.entries.length === 0 ? (
          <Empty>Chưa có bút toán.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Nội dung</th>
                  <th>Tài khoản</th>
                  <th className="num">Phát sinh</th>
                  <th className="num">Số dư sau</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{fmtTime(e.created_at)}</td>
                    <td>
                      {e.description}
                      {e.booking_id && (
                        <>
                          {' '}
                          · <Link to={`/bookings/${e.booking_id}`}>xem đơn</Link>
                        </>
                      )}
                      <div className="muted small">
                        <code>{e.reference}</code>
                      </div>
                    </td>
                    <td>{ACCOUNT_LABEL[e.account_type]}</td>
                    <td className={`num ${e.direction === 'DEBIT' ? 'neg' : 'pos'}`}>
                      {e.direction === 'DEBIT' ? '−' : '+'}
                      {vnd(e.amount)}
                    </td>
                    <td className="num">{vnd(e.balance_after)}</td>
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

function WithdrawForm({ wallet, onDone }) {
  const { user } = useAuth();
  const [amount, setAmount] = useState(50000);
  const [code, setCode] = useState('PAYOUT-DEMO01');
  const [key, setKey] = useState(() => newKey('wd'));
  const [err, setErr] = useState(null);
  const toast = useToast();
  return (
    <section className="card">
      <h2>Rút tiền (mô phỏng)</h2>
      {user.kyc_status !== 'VERIFIED' && (
        <div className="alert alert-warn small">
          Cần hoàn tất <Link to="/account">eKYC</Link> trước khi rút tiền.
        </div>
      )}
      <Field label="Số tiền (tối thiểu 50.000đ)" hint={`Khả dụng: ${vnd(wallet.available)}`}>
        <input type="number" min={50000} step={10000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
      </Field>
      <Field label="Mã nhận tiền giả lập" hint="Dạng PAYOUT-XXXX. Không nhập số tài khoản ngân hàng thật.">
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      </Field>
      <ErrorBox error={err} />
      <ConfirmButton
        className="btn btn-block"
        confirm={`Tạo yêu cầu rút ${vnd(amount)}? Số tiền sẽ được giữ cho tới khi Admin xử lý.`}
        onClick={async () => {
          setErr(null);
          try {
            await post('/withdrawals', { amount, payoutCode: code, idempotencyKey: key });
            toast('Đã tạo yêu cầu rút tiền', 'success');
            setKey(newKey('wd'));
            onDone();
          } catch (e) {
            setErr(e);
          }
        }}
      >
        Gửi yêu cầu rút tiền
      </ConfirmButton>
    </section>
  );
}
