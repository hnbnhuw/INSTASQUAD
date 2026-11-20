import { useState } from 'react';
import { get, post, fmtTime } from '../api.js';
import { useAsync, Loading, ErrorBox, Badge, ConfirmButton, useToast } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

const TONE = { OPEN: 'warn', NEEDS_EVIDENCE: 'warn', RESOLVED_REFUND: 'ok', RESOLVED_RELEASE: 'ok' };

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function EvidenceList({ evidence }) {
  return (
    <div className="evidence">
      {evidence.map((e) => (
        <div key={e.id} className={`ev ev-${e.kind.toLowerCase()}`}>
          <div className="row between small">
            <b>
              {e.kind === 'CHAT_LOG' ? '🗨 Nhật ký chat (tự động)' : e.kind === 'SYSTEM' ? '⚙ Nhật ký phiên (tự động)' : e.uploader_name || 'Hệ thống'}
              {e.uploader_role === 'CS' || e.uploader_role === 'ADMIN' ? ' (CS)' : ''}
            </b>
            <span className="muted">{fmtTime(e.created_at)}</span>
          </div>
          {e.text && <pre className="ev-text">{e.text}</pre>}
          {e.kind === 'FILE' && (
            <a href={`/api/evidence/${e.id}/file`} target="_blank" rel="noreferrer">
              📎 {e.file_name} ({Math.round(e.size / 1024)} KB)
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

export function EvidenceForm({ disputeId, onDone }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [err, setErr] = useState(null);
  const toast = useToast();
  return (
    <div className="evidence-form">
      <textarea rows={2} placeholder="Giải trình / mô tả bằng chứng…" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      <input type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain" onChange={(e) => setFile(e.target.files[0] || null)} />
      <div className="muted small">Ảnh PNG/JPEG/WEBP, PDF hoặc TXT, tối đa 2MB. Tệp được mã hóa AES-256 khi lưu. Không tải ghi âm.</div>
      <ErrorBox error={err} />
      <ConfirmButton
        className="btn btn-sm"
        disabled={!text.trim() && !file}
        onClick={async () => {
          setErr(null);
          try {
            let f;
            if (file) {
              if (file.size > 2 * 1024 * 1024) throw Object.assign(new Error('Tệp vượt quá 2MB'), { status: 400 });
              f = { name: file.name, mime: file.type, base64: await readFileAsBase64(file) };
            }
            await post(`/disputes/${disputeId}/evidence`, { text: text.trim() || undefined, file: f });
            setText('');
            setFile(null);
            toast('Đã gửi bằng chứng', 'success');
            onDone();
          } catch (e) {
            setErr(e);
          }
        }}
      >
        Gửi bằng chứng
      </ConfirmButton>
    </div>
  );
}

export default function DisputePanel({ disputeId }) {
  const { user } = useAuth();
  const { data, loading, error, reload } = useAsync(() => get(`/disputes/${disputeId}`), [disputeId]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data.dispute;
  const open = !d.status.startsWith('RESOLVED');
  return (
    <div>
      <div className="row between wrap">
        <h3 className="mb0">Khiếu nại #{d.id}</h3>
        <Badge tone={TONE[d.status]}>{d.status_label}</Badge>
      </div>
      <p>
        <b>Lý do:</b> {d.reason}
      </p>
      {open && (
        <div className="alert alert-info small">
          Tiền ký quỹ đang <b>đóng băng</b> cho tới khi CS phán quyết. {d.status === 'NEEDS_EVIDENCE' && <>CS yêu cầu bổ sung bằng chứng trước {fmtTime(d.evidence_deadline)}.</>}
        </div>
      )}
      {!open && (
        <div className="alert alert-ok">
          <b>Phán quyết:</b> lỗi Companion {d.fault_percent}% → {d.status === 'RESOLVED_REFUND' ? 'hoàn 100% cho Renter, phạt Companion 20% giá trị đơn' : 'giải phóng tiền cho Companion (88/12)'}.
          <div>
            <b>Lý do:</b> {d.decision_reason}
          </div>
          <small className="muted">
            {d.decided_by_name} · {fmtTime(d.decided_at)}
          </small>
        </div>
      )}
      <h4>Hồ sơ bằng chứng</h4>
      <EvidenceList evidence={d.evidence} />
      {open && (user.role === 'RENTER' || user.role === 'COMPANION') && <EvidenceForm disputeId={d.id} onDone={reload} />}
    </div>
  );
}
