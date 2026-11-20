import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, q, reconcile, wallet } from './helpers.js';

const { tx } = await import('../src/db.js');
const { postTransaction, userAccount, systemAccount, armLedgerFault, runFinancial, D, C } = await import('../src/services/ledger.js');
const { splitPct, split88_12 } = await import('../src/util.js');
const { computeTrust } = await import('../src/services/trust.js');

let ctx;
before(async () => {
  ctx = await setup();
  await ctx.close();
});

test('LEDGER-01 giao dịch cân bằng được ghi, balance_after đúng, đối soát OK', () => {
  const before = wallet(ctx.renter.id).AVAILABLE;
  tx(() =>
    postTransaction({
      reference: 'T:1',
      type: 'TEST',
      description: 'test',
      lines: [D(userAccount(ctx.renter.id, 'AVAILABLE'), 1000), C(userAccount(ctx.renter.id, 'ESCROW'), 1000)],
    }),
  );
  assert.equal(wallet(ctx.renter.id).AVAILABLE, before - 1000);
  assert.equal(wallet(ctx.renter.id).ESCROW, 1000);
  const r = reconcile();
  // Escrow 1000 không gắn booking ⇒ đối soát phải phát hiện lệch (chứng minh reconcile không bỏ sót)
  assert.ok(r.issues.some((i) => i.type === 'ESCROW_HELD_MISMATCH'));
  tx(() =>
    postTransaction({
      reference: 'T:1-reverse',
      type: 'TEST',
      description: 'reverse',
      lines: [D(userAccount(ctx.renter.id, 'ESCROW'), 1000), C(userAccount(ctx.renter.id, 'AVAILABLE'), 1000)],
    }),
  );
  assert.equal(reconcile().ok, true);
});

test('LEDGER-02 reference trùng (idempotency) không ghi lần hai', () => {
  const n0 = q.get('SELECT COUNT(*) n FROM ledger_entries').n;
  const mk = () =>
    tx(() =>
      postTransaction({
        reference: 'T:dup',
        type: 'TEST',
        description: 'dup',
        lines: [D(systemAccount('GATEWAY_CLEARING'), 500), C(userAccount(ctx.renter2.id, 'AVAILABLE'), 500)],
      }),
    );
  const a = mk();
  const b = mk();
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.txn.id, b.txn.id);
  assert.equal(q.get('SELECT COUNT(*) n FROM ledger_entries').n, n0 + 2);
});

test('LEDGER-03 giao dịch lệch (debit ≠ credit) bị từ chối, không lưu gì', () => {
  const n0 = q.get('SELECT COUNT(*) n FROM ledger_transactions').n;
  assert.throws(
    () => tx(() => postTransaction({ reference: 'T:bad', type: 'TEST', description: 'x', lines: [D(userAccount(ctx.renter.id, 'AVAILABLE'), 100), C(userAccount(ctx.renter.id, 'ESCROW'), 99)] })),
    /lệch/,
  );
  assert.equal(q.get('SELECT COUNT(*) n FROM ledger_transactions').n, n0);
});

test('LEDGER-04 số tiền không nguyên / âm bị từ chối', () => {
  assert.throws(() => tx(() => postTransaction({ reference: 'T:f', type: 'TEST', description: 'x', lines: [D(userAccount(ctx.renter.id, 'AVAILABLE'), 10.5), C(userAccount(ctx.renter.id, 'ESCROW'), 10.5)] })));
  assert.throws(() => tx(() => postTransaction({ reference: 'T:n', type: 'TEST', description: 'x', lines: [D(userAccount(ctx.renter.id, 'AVAILABLE'), -5), C(userAccount(ctx.renter.id, 'ESCROW'), -5)] })));
});

test('LEDGER-05 thiếu số dư → rollback toàn bộ, số dư giữ nguyên', () => {
  const w0 = wallet(ctx.renter.id);
  assert.throws(() =>
    tx(() => postTransaction({ reference: 'T:over', type: 'TEST', description: 'x', lines: [D(userAccount(ctx.renter.id, 'AVAILABLE'), w0.AVAILABLE + 1), C(userAccount(ctx.renter.id, 'ESCROW'), w0.AVAILABLE + 1)] })),
  );
  assert.deepEqual(wallet(ctx.renter.id), w0);
  assert.equal(q.get("SELECT COUNT(*) n FROM ledger_transactions WHERE reference='T:over'").n, 0);
});

test('LEDGER-06 lỗi ghi sổ (fault injection) → rollback + cảnh báo đối soát, fault tự tắt', () => {
  const w0 = wallet(ctx.renter.id);
  armLedgerFault(true);
  assert.throws(() =>
    runFinancial('TEST_OP', {}, () => {
      q.run("INSERT INTO settings(key,value) VALUES('side-effect','1')");
      postTransaction({ reference: 'T:fault', type: 'TEST', description: 'x', lines: [D(userAccount(ctx.renter.id, 'AVAILABLE'), 1), C(userAccount(ctx.renter.id, 'ESCROW'), 1)] });
    }),
  );
  assert.deepEqual(wallet(ctx.renter.id), w0);
  assert.equal(q.get("SELECT COUNT(*) n FROM settings WHERE key='side-effect'").n, 0, 'thay đổi khác trong cùng transaction cũng bị hủy');
  assert.equal(q.get("SELECT COUNT(*) n FROM ops_alerts WHERE operation='TEST_OP'").n, 1);
  assert.equal(q.get("SELECT value FROM settings WHERE key='fault.ledger_fail_next'").value, '0');
});

test('MONEY-01 invariant: chia % luôn bảo toàn tổng, không âm, số nguyên (property test 5000 mẫu)', () => {
  for (let i = 0; i < 5000; i++) {
    const amount = 1 + Math.floor(Math.random() * 50_000_000);
    const { companion, platform } = split88_12(amount);
    assert.equal(companion + platform, amount);
    assert.ok(Number.isInteger(companion) && Number.isInteger(platform) && companion >= 0 && platform >= 0);
    assert.ok(platform <= Math.ceil(amount * 0.12));
    const [a, b] = splitPct(amount, 70);
    assert.equal(a + b, amount);
  }
  assert.deepEqual(split88_12(100_000), { companion: 88_000, platform: 12_000 });
  assert.deepEqual(split88_12(33_333), { companion: 29_334, platform: 3_999 });
});

test('TRUST-01 công thức TrustScore khớp ví dụ tính tay', () => {
  // 0.4×(4.5/5×100) + 0.4×90 − 1.2×10 − 3 = 36 + 36 − 12 − 3 = 57
  assert.equal(computeTrust({ rating100: 90, completionRate: 90, complaintRate: 10, deductions: 3 }), 57);
  assert.equal(computeTrust({ rating100: 100, completionRate: 100, complaintRate: 0, deductions: 0 }), 80);
  assert.equal(computeTrust({ rating100: 0, completionRate: 0, complaintRate: 100, deductions: 0 }), 0, 'giới hạn dưới 0');
});
