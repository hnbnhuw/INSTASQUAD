import { useState } from 'react';
import { post, fmtTime, KYC_LABEL, ROLE_LABEL } from '../api.js';
import { ErrorBox, Field, Badge, TrustPill, ConfirmButton, useToast } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

export default function Account() {
  const { user, kyc, refresh } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', idNumber: '', dob: '2000-01-01' });
  const [err, setErr] = useState(null);
  const tone = { VERIFIED: 'ok', REJECTED: 'danger', NEEDS_MORE_INFO: 'warn', NONE: 'muted', PENDING: 'warn' }[user.kyc_status];
  return (
    <div className="two-col">
      <section className="card">
        <h1>Tài khoản</h1>
        <div className="info-grid">
          <div>
            <span className="muted small">Tên hiển thị</span>
            <div>{user.display_name}</div>
          </div>
          <div>
            <span className="muted small">Email</span>
            <div>{user.email}</div>
          </div>
          <div>
            <span className="muted small">Vai trò</span>
            <div>{ROLE_LABEL[user.role]}</div>
          </div>
          <div>
            <span className="muted small">Đăng nhập qua</span>
            <div>{user.oauth_provider ? 'OAuth2 (mô phỏng)' : 'Email & mật khẩu'}</div>
          </div>
          <div>
            <span className="muted small">TrustScore</span>
            <div>
              <TrustPill score={user.trust_score} />
            </div>
          </div>
          <div>
            <span className="muted small">eKYC</span>
            <div>
              <Badge tone={tone}>{KYC_LABEL[user.kyc_status]}</Badge>
            </div>
          </div>
        </div>
        <p className="muted small">
          TrustScore = 0,40 × điểm đánh giá (thang 100) + 0,40 × tỷ lệ hoàn thành − 1,20 × tỷ lệ bị khiếu nại − điểm trừ trực tiếp (giới hạn 0–100). Dưới 40 điểm hồ sơ bị tạm khóa.
        </p>
      </section>
      {user.role !== 'CS' && user.role !== 'ADMIN' && (
        <section className="card">
          <h2>Xác thực danh tính (eKYC)</h2>
          {kyc && (
            <div className={`alert ${user.kyc_status === 'VERIFIED' ? 'alert-ok' : 'alert-warn'} small`}>
              {kyc.message} · CCCD {kyc.id_masked} · lần thử {kyc.attempts} · {fmtTime(kyc.updated_at)}
            </div>
          )}
          {user.kyc_status === 'VERIFIED' ? (
            <p>Tài khoản đã được xác thực. {user.role === 'COMPANION' ? 'Hồ sơ của bạn có huy hiệu "Đã eKYC" và có thể rút tiền.' : ''}</p>
          ) : (
            <>
              <div className="alert alert-info small">
                Dịch vụ eKYC là <b>mô phỏng</b>. Dữ liệu được mã hóa AES-256-GCM khi lưu và chỉ hiển thị 4 số cuối. Không nhập giấy tờ thật.
                <br />
                Quy tắc thử: CCCD 12 số; đuôi <code>000</code> → từ chối, <code>111</code> → cần bổ sung, <code>999</code> → dịch vụ tạm lỗi, còn lại → thành công.
              </div>
              <Field label="Họ và tên">
                <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
              </Field>
              <Field label="Số CCCD (12 số)">
                <input value={f.idNumber} inputMode="numeric" maxLength={12} onChange={(e) => setF({ ...f, idNumber: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="Ngày sinh">
                <input type="date" value={f.dob} onChange={(e) => setF({ ...f, dob: e.target.value })} />
              </Field>
              <ErrorBox error={err} />
              <ConfirmButton
                className="btn btn-block"
                onClick={async () => {
                  setErr(null);
                  try {
                    const r = await post('/auth/kyc', f);
                    toast(r.message, r.status === 'VERIFIED' ? 'success' : 'warn');
                    refresh();
                  } catch (e) {
                    setErr(e);
                  }
                }}
              >
                Gửi xác thực
              </ConfirmButton>
            </>
          )}
        </section>
      )}
    </div>
  );
}
