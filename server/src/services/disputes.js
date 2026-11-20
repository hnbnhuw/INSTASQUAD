// RMA / Khiếu nại (BPMN Hình 2C): đóng băng Escrow, bằng chứng, CS phán quyết, hoàn tiền + phạt 20% hoặc giải phóng 88/12.
import fs from 'node:fs';
import path from 'node:path';
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { config } from '../config.js';
import { POLICY } from '../policy.js';
import { E } from '../errors.js';
import { encrypt, decrypt, randomToken, split88_12, splitPct } from '../util.js';
import { audit, notify, notifyRole } from './common.js';
import { postTransaction, userAccount, systemAccount, runFinancial, D, C } from './ledger.js';
import { getBooking, transition, creditCompanionLines, BOOKING_STATUS } from './bookings.js';
import { recalcTrust } from './trust.js';

export const DISPUTE_STATUS = {
  OPEN: 'Đang xem xét',
  NEEDS_EVIDENCE: 'Chờ bổ sung bằng chứng',
  RESOLVED_REFUND: 'Đã đóng – hoàn tiền Renter',
  RESOLVED_RELEASE: 'Đã đóng – giải phóng tiền Companion',
};

const vnTime = (ms) => `${new Date(ms + 7 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)}`;

function chatLogText(bookingId) {
  const rows = q.all(
    'SELECT m.created_at, u.display_name, m.body FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.booking_id=? ORDER BY m.id',
    bookingId,
  );
  if (!rows.length) return '(Không có tin nhắn trong phiên)';
  return rows.map((r) => `[${vnTime(r.created_at)}] ${r.display_name}: ${r.body}`).join('\n');
}

// Renter báo sự cố → mở khiếu nại, đóng băng toàn bộ tiền ký quỹ NGAY (trước khi lập hồ sơ)
export function openDispute(renter, bookingId, { reason, detail = '' }) {
  const b = getBooking(bookingId);
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (b.renter_id !== renter.id) throw E.forbidden('Chỉ Renter của đơn mới được báo sự cố');
  const existing = q.get('SELECT * FROM disputes WHERE booking_id=?', bookingId);
  if (existing) return { dispute: existing, duplicate: true }; // Hình 2C bước 2a: không tạo trùng, không đóng băng lần hai
  if (!['IN_SESSION', 'AWAITING_CONFIRMATION'].includes(b.status)) {
    throw E.conflict('INVALID_STATE', `Không thể báo sự cố khi đơn ở trạng thái "${BOOKING_STATUS[b.status]}"`);
  }
  if (b.status === 'AWAITING_CONFIRMATION' && clock.now() > b.confirm_deadline) {
    throw E.conflict('CONFIRM_WINDOW_CLOSED', 'Đã quá 15 phút nghiệm thu');
  }
  const dispute = runFinancial(
    'DISPUTE_FREEZE',
    { bookingId, renterId: renter.id, reason, detail },
    () => {
      const cur = getBooking(bookingId);
      if (q.get('SELECT 1 FROM disputes WHERE booking_id=?', bookingId)) throw E.conflict('DISPUTE_EXISTS', 'Đơn đã có khiếu nại');
      const esc = q.get('SELECT * FROM escrows WHERE booking_id=?', cur.id);
      if (!esc || esc.status !== 'HELD') throw E.conflict('ESCROW_NOT_HELD', 'Khoản ký quỹ không ở trạng thái Đang giữ');
      const now = clock.now();
      const { txn } = postTransaction({
        reference: `FREEZE:${cur.id}`,
        type: 'ESCROW_FREEZE',
        description: `Đóng băng ký quỹ ${cur.code} do khiếu nại`,
        bookingId: cur.id,
        createdBy: renter.id,
        lines: [D(userAccount(cur.renter_id, 'ESCROW'), esc.amount), C(userAccount(cur.renter_id, 'FROZEN'), esc.amount)],
      });
      q.run("UPDATE escrows SET status='FROZEN', updated_at=? WHERE id=?", now, esc.id);
      const r = q.run(
        `INSERT INTO disputes(booking_id, opened_by, reason, status, evidence_deadline, created_at, updated_at) VALUES (?,?,?, 'OPEN', ?,?,?)`,
        cur.id,
        renter.id,
        reason,
        now + POLICY.EVIDENCE_WINDOW_MS,
        now,
        now,
      );
      const did = Number(r.lastInsertRowid);
      q.run('UPDATE ledger_transactions SET dispute_id=? WHERE id=?', did, txn.id);
      q.run("UPDATE play_sessions SET status='INTERRUPTED', ended_at=? WHERE booking_id=? AND status='ACTIVE'", now, cur.id);
      transition(cur, 'DISPUTED', { actorId: renter.id, reason: `Renter báo sự cố: ${reason}`, ledgerTxnId: txn.id });
      const ins = 'INSERT INTO evidence(dispute_id, uploader_id, kind, text, created_at) VALUES (?,?,?,?,?)';
      q.run(ins, did, renter.id, 'TEXT', `Lý do: ${reason}${detail ? `\n${detail}` : ''}`, now);
      q.run(ins, did, null, 'CHAT_LOG', chatLogText(cur.id), now); // hồ sơ kèm nhật ký chat (ghi âm: DEFERRED)
      const events = q.all('SELECT type, detail, created_at FROM session_events WHERE booking_id=? ORDER BY id', cur.id);
      q.run(ins, did, null, 'SYSTEM', events.map((e) => `[${vnTime(e.created_at)}] ${e.type}${e.detail ? ` ${e.detail}` : ''}`).join('\n') || '(không có sự kiện phiên)', now);
      notifyRole(['CS', 'ADMIN'], 'DISPUTE_NEW', 'Khiếu nại mới', `${cur.code}: ${reason}`, `/admin/disputes/${did}`);
      notify(cur.companion_id, 'DISPUTE_OPENED', 'Renter đã báo sự cố', `${cur.code}: tiền đang đóng băng. Bạn có thể gửi giải trình/bằng chứng.`, `/bookings/${cur.id}`);
      notify(cur.renter_id, 'DISPUTE_OPENED', 'Đã tiếp nhận khiếu nại', `${cur.code}: tiền ký quỹ đã được đóng băng chờ CS phán quyết.`, `/bookings/${cur.id}`);
      audit(renter.id, 'DISPUTE_OPEN', 'dispute', did, { bookingId: cur.id, reason });
      return q.get('SELECT * FROM disputes WHERE id=?', did);
    },
    { bookingId },
  );
  return { dispute, duplicate: false };
}

function canAccessDispute(user, d) {
  const b = getBooking(d.booking_id);
  return user.role === 'CS' || user.role === 'ADMIN' || b.renter_id === user.id || b.companion_id === user.id;
}

const SAFE_NAME = /[^a-zA-Z0-9._-]+/g;

export function addEvidence(user, disputeId, { text, file }) {
  const d = q.get('SELECT * FROM disputes WHERE id=?', disputeId);
  if (!d) throw E.notFound('Không tìm thấy khiếu nại');
  if (!canAccessDispute(user, d)) throw E.forbidden();
  if (d.status.startsWith('RESOLVED')) throw E.conflict('DISPUTE_CLOSED', 'Khiếu nại đã đóng');
  if (!text && !file) throw E.badRequest('EMPTY_EVIDENCE', 'Cần nhập mô tả hoặc đính kèm tệp');
  let stored = null;
  if (file) {
    if (!POLICY.EVIDENCE_MIME.includes(file.mime)) throw E.badRequest('INVALID_FILE_TYPE', 'Chỉ nhận ảnh PNG/JPEG/WEBP, PDF hoặc TXT');
    const buf = Buffer.from(file.base64 || '', 'base64');
    if (!buf.length) throw E.badRequest('EMPTY_FILE', 'Tệp rỗng');
    if (buf.length > POLICY.MAX_EVIDENCE_BYTES) throw E.badRequest('FILE_TOO_LARGE', 'Tệp vượt quá 2MB');
    const safe = String(file.name || 'evidence').replace(SAFE_NAME, '_').slice(-80) || 'evidence';
    const key = `${randomToken(18)}.bin`;
    fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(config.UPLOAD_DIR, key), encrypt(buf)); // mã hóa AES-256-GCM khi lưu (NFR-002)
    stored = { name: safe, mime: file.mime, size: buf.length, key };
  }
  return tx(() => {
    const now = clock.now();
    q.run(
      'INSERT INTO evidence(dispute_id, uploader_id, kind, text, file_name, mime, size, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      d.id,
      user.id,
      stored ? 'FILE' : 'TEXT',
      text || null,
      stored?.name ?? null,
      stored?.mime ?? null,
      stored?.size ?? null,
      stored?.key ?? null,
      now,
    );
    // Bên liên quan bổ sung → hồ sơ quay lại bước xem xét (6b → 5)
    if (d.status === 'NEEDS_EVIDENCE' && user.role !== 'CS' && user.role !== 'ADMIN') {
      q.run("UPDATE disputes SET status='OPEN', updated_at=? WHERE id=?", now, d.id);
      notifyRole(['CS', 'ADMIN'], 'DISPUTE_EVIDENCE', 'Đã bổ sung bằng chứng', `Khiếu nại #${d.id} có bằng chứng mới`, `/admin/disputes/${d.id}`);
    }
    audit(user.id, 'EVIDENCE_ADD', 'dispute', d.id, { file: stored?.name, hasText: Boolean(text) });
    return q.get('SELECT * FROM disputes WHERE id=?', d.id);
  });
}

export function readEvidenceFile(user, evidenceId) {
  const ev = q.get('SELECT * FROM evidence WHERE id=?', evidenceId);
  if (!ev || ev.kind !== 'FILE') throw E.notFound();
  const d = q.get('SELECT * FROM disputes WHERE id=?', ev.dispute_id);
  if (!canAccessDispute(user, d)) throw E.forbidden();
  const buf = decrypt(fs.readFileSync(path.join(config.UPLOAD_DIR, ev.storage_key)));
  return { buf, mime: ev.mime, name: ev.file_name };
}

export function requestMoreEvidence(cs, disputeId, note) {
  if (!note || note.trim().length < 5) throw E.badRequest('NOTE_REQUIRED', 'Cần ghi rõ nội dung yêu cầu bổ sung');
  return tx(() => {
    const d = q.get('SELECT * FROM disputes WHERE id=?', disputeId);
    if (!d) throw E.notFound();
    if (d.status !== 'OPEN') throw E.conflict('INVALID_STATE', `Khiếu nại đang ở trạng thái "${DISPUTE_STATUS[d.status]}"`);
    const now = clock.now();
    q.run("UPDATE disputes SET status='NEEDS_EVIDENCE', evidence_deadline=?, updated_at=? WHERE id=?", now + POLICY.EVIDENCE_WINDOW_MS, now, d.id);
    q.run('INSERT INTO evidence(dispute_id, uploader_id, kind, text, created_at) VALUES (?,?,?,?,?)', d.id, cs.id, 'TEXT', `[CS yêu cầu bổ sung] ${note}`, now);
    const b = getBooking(d.booking_id);
    for (const u of [b.renter_id, b.companion_id]) notify(u, 'EVIDENCE_REQUESTED', 'CS yêu cầu bổ sung bằng chứng', `${b.code}: ${note}`, `/bookings/${b.id}`);
    audit(cs.id, 'DISPUTE_REQUEST_EVIDENCE', 'dispute', d.id, { note });
    return q.get('SELECT * FROM disputes WHERE id=?', d.id);
  });
}

// Phán quyết (Hình 2C bước 7–10). Bắt buộc lý do; ghi người xử lý, thời điểm, bằng chứng tham chiếu.
export function decideDispute(cs, disputeId, { faultPercent, reason }) {
  if (!Number.isInteger(faultPercent) || faultPercent < 0 || faultPercent > 100) throw E.badRequest('INVALID_FAULT', 'Tỷ lệ lỗi phải là số nguyên 0–100');
  if (!reason || reason.trim().length < 10) throw E.badRequest('REASON_REQUIRED', 'Bắt buộc nhập lý do phán quyết (tối thiểu 10 ký tự)');
  const d0 = q.get('SELECT * FROM disputes WHERE id=?', disputeId);
  if (!d0) throw E.notFound();
  if (d0.status.startsWith('RESOLVED')) throw E.conflict('ALREADY_RESOLVED', 'Khiếu nại đã được xử lý');
  return runFinancial(
    'DISPUTE_DECIDE',
    { disputeId, faultPercent, reason, csId: cs.id },
    () => {
      const d = q.get('SELECT * FROM disputes WHERE id=?', disputeId);
      if (d.status.startsWith('RESOLVED')) throw E.conflict('ALREADY_RESOLVED', 'Khiếu nại đã được xử lý');
      const b = getBooking(d.booking_id);
      const esc = q.get('SELECT * FROM escrows WHERE booking_id=?', b.id);
      if (esc.status !== 'FROZEN') throw E.conflict('ESCROW_NOT_FROZEN', 'Khoản ký quỹ không ở trạng thái Đóng băng');
      const frozen = userAccount(b.renter_id, 'FROZEN');
      const now = clock.now();
      const evidenceIds = q.all('SELECT id FROM evidence WHERE dispute_id=?', d.id).map((r) => r.id);
      let txnId;
      let summary;
      if (faultPercent >= POLICY.DISPUTE_FAULT_THRESHOLD) {
        // 8a: hoàn 100% cho Renter + phạt Companion 20% giá trị đơn
        const { txn } = postTransaction({
          reference: `DISPUTE_REFUND:${d.id}`,
          type: 'DISPUTE_REFUND',
          description: `Khiếu nại #${d.id} (${b.code}): hoàn 100% cho Renter`,
          bookingId: b.id,
          disputeId: d.id,
          createdBy: cs.id,
          lines: [D(frozen, esc.amount), C(userAccount(b.renter_id, 'AVAILABLE'), esc.amount)],
        });
        txnId = txn.id;
        const [penalty] = splitPct(esc.amount, POLICY.DISPUTE_PENALTY_PCT);
        summary = { outcome: 'REFUND', refund: esc.amount, penalty: 0 };
        if (penalty > 0) {
          // DEMO_POLICY DP-06: trừ từ ví khả dụng; phần thiếu ghi nợ (RECEIVABLE âm) và bù trừ vào thu nhập sau.
          const avail = userAccount(b.companion_id, 'AVAILABLE');
          const fromAvail = Math.min(Math.max(avail.balance, 0), penalty);
          const lines = [C(systemAccount('PLATFORM_PENALTY'), penalty)];
          if (fromAvail > 0) lines.push(D(avail, fromAvail));
          if (penalty - fromAvail > 0) lines.push(D(userAccount(b.companion_id, 'RECEIVABLE'), penalty - fromAvail));
          const pt = postTransaction({
            reference: `DISPUTE_PENALTY:${d.id}`,
            type: 'DISPUTE_PENALTY',
            description: `Phạt Companion 20% giá trị đơn ${b.code} (khiếu nại #${d.id})`,
            bookingId: b.id,
            disputeId: d.id,
            createdBy: cs.id,
            lines,
          });
          q.run("INSERT INTO platform_revenue(booking_id, ledger_txn_id, kind, amount, created_at) VALUES (?,?, 'DISPUTE_PENALTY', ?, ?)", b.id, pt.txn.id, penalty, now);
          summary = { outcome: 'REFUND', refund: esc.amount, penalty, penaltyFromWallet: fromAvail, penaltyAsDebt: penalty - fromAvail };
        }
        q.run("UPDATE escrows SET status='REFUNDED', final_txn_id=?, updated_at=? WHERE id=?", txnId, now, esc.id);
        q.run(
          "UPDATE disputes SET status='RESOLVED_REFUND', fault_percent=?, decision_reason=?, decided_by=?, decided_at=?, ledger_txn_id=?, updated_at=? WHERE id=?",
          faultPercent,
          reason,
          cs.id,
          now,
          txnId,
          now,
          d.id,
        );
        transition(b, 'RESOLVED_REFUNDED', { actorId: cs.id, reason: `CS phán quyết lỗi Companion ${faultPercent}% ≥ 80%: hoàn 100%, phạt 20%`, ledgerTxnId: txnId });
      } else {
        // 8b: giải phóng 88/12 (nhánh lỗi < 80% theo giả định nhóm – DP-06b)
        const { companion, platform } = split88_12(esc.amount);
        const { txn } = postTransaction({
          reference: `DISPUTE_RELEASE:${d.id}`,
          type: 'DISPUTE_RELEASE',
          description: `Khiếu nại #${d.id} (${b.code}): giải phóng 88% Companion / 12% nền tảng`,
          bookingId: b.id,
          disputeId: d.id,
          createdBy: cs.id,
          lines: [D(frozen, esc.amount), ...creditCompanionLines(b.companion_id, companion), C(systemAccount('PLATFORM_REVENUE'), platform)],
        });
        txnId = txn.id;
        q.run("INSERT INTO platform_revenue(booking_id, ledger_txn_id, kind, amount, created_at) VALUES (?,?, 'COMMISSION', ?, ?)", b.id, txn.id, platform, now);
        q.run("UPDATE escrows SET status='RELEASED', final_txn_id=?, updated_at=? WHERE id=?", txnId, now, esc.id);
        q.run(
          "UPDATE disputes SET status='RESOLVED_RELEASE', fault_percent=?, decision_reason=?, decided_by=?, decided_at=?, ledger_txn_id=?, updated_at=? WHERE id=?",
          faultPercent,
          reason,
          cs.id,
          now,
          txnId,
          now,
          d.id,
        );
        transition(b, 'RESOLVED_RELEASED', { actorId: cs.id, reason: `CS phán quyết lỗi Companion ${faultPercent}% < 80%: giải phóng 88/12`, ledgerTxnId: txnId });
        summary = { outcome: 'RELEASE', companion, platform };
      }
      recalcTrust(b.companion_id, `DISPUTE:${d.id}`, `Kết quả khiếu nại #${d.id}`);
      recalcTrust(b.renter_id, `DISPUTE:${d.id}`, `Kết quả khiếu nại #${d.id}`);
      audit(cs.id, 'DISPUTE_DECIDE', 'dispute', d.id, { faultPercent, reason, evidenceIds, ...summary });
      const msg = summary.outcome === 'REFUND' ? 'Renter được hoàn 100%; Companion bị phạt 20%.' : 'Tiền được giải phóng cho Companion (88/12).';
      for (const u of [b.renter_id, b.companion_id]) notify(u, 'DISPUTE_RESOLVED', 'Khiếu nại đã có phán quyết', `${b.code}: ${msg} Lý do: ${reason}`, `/bookings/${b.id}`);
      return { dispute: q.get('SELECT * FROM disputes WHERE id=?', d.id), summary };
    },
    { bookingId: d0.booking_id },
  );
}

export function disputeDetail(user, disputeId) {
  const d = q.get('SELECT * FROM disputes WHERE id=?', disputeId);
  if (!d) throw E.notFound();
  if (!canAccessDispute(user, d)) throw E.forbidden();
  const evidence = q.all(
    `SELECT e.id, e.kind, e.text, e.file_name, e.mime, e.size, e.created_at, e.uploader_id, u.display_name AS uploader_name, u.role AS uploader_role
       FROM evidence e LEFT JOIN users u ON u.id=e.uploader_id WHERE dispute_id=? ORDER BY e.id`,
    d.id,
  );
  const decidedBy = d.decided_by ? q.get('SELECT display_name FROM users WHERE id=?', d.decided_by)?.display_name : null;
  return { ...d, status_label: DISPUTE_STATUS[d.status], evidence, decided_by_name: decidedBy };
}
