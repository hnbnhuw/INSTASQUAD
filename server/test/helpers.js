// Môi trường test: DB SQLite in-memory, đồng hồ cố định (fake clock), server HTTP thật trên cổng ngẫu nhiên.
process.env.NODE_ENV = 'test';
process.env.DEMO_TOOLS = 'true';
process.env.UPLOAD_DIR = (await import('node:os')).tmpdir() + '/instasquad-test-uploads';

const { initDb, q } = await import('../src/db.js');
const { clock } = await import('../src/clock.js');
const { createApp } = await import('../src/app.js');
const { ensureSystemAccounts } = await import('../src/services/ledger.js');
const { createUser } = await import('../src/services/users.js');
const { updateProfile, addSlots } = await import('../src/services/companions.js');
const { createTopup, handleGatewayCallback, signCallback } = await import('../src/services/payments.js');
const { runSchedulerOnce } = await import('../src/scheduler.js');
const { reconcile } = await import('../src/services/ledger.js');

export { q, clock, runSchedulerOnce, reconcile, signCallback };

export const HOUR = 3600 * 1000;
export const MIN = 60 * 1000;
// 2026-03-10 08:00 giờ VN (01:00 UTC)
export const T0 = Date.UTC(2026, 2, 10, 1, 0, 0);
export const PASSWORD = 'Test@1234';

export function topup(userId, amount, key = `k-${Math.random()}`) {
  const u = q.get('SELECT * FROM users WHERE id=?', userId);
  const { payment } = createTopup(u, { amount, method: 'VNPAY_MOCK', idempotencyKey: key });
  const p = { gatewayTxnId: payment.gateway_txn_id, status: 'SUCCESS', amount };
  return handleGatewayCallback({ ...p, signature: signCallback(p) });
}

export async function setup({ renterBalance = 1_000_000, rate = 100_000 } = {}) {
  initDb(':memory:');
  clock.freeze(T0);
  ensureSystemAccounts();
  q.run("INSERT INTO games(code,name,ranks) VALUES ('LOL','Liên Minh','[\"Bạc\",\"Vàng\",\"Kim Cương\"]'), ('VAL','Valorant','[\"Gold\",\"Diamond\"]')");
  const mk = (email, role, name) => createUser({ email, password: PASSWORD, displayName: name, role });
  const renter = mk('renter@test.vn', 'RENTER', 'Renter A');
  const renter2 = mk('renter2@test.vn', 'RENTER', 'Renter B');
  const companion = mk('comp@test.vn', 'COMPANION', 'Companion C');
  const companion2 = mk('comp2@test.vn', 'COMPANION', 'Companion D');
  const cs = mk('cs@test.vn', 'CS', 'CS');
  const admin = mk('admin@test.vn', 'ADMIN', 'Admin');
  for (const c of [companion, companion2]) {
    q.run("UPDATE users SET kyc_status='VERIFIED' WHERE id=?", c.id);
    updateProfile(q.get('SELECT * FROM users WHERE id=?', c.id), { hourlyRate: rate, games: [{ gameId: 1, rank: 'Vàng', inGameName: 'ign' }] });
  }
  // Slot 08:00–23:00 giờ VN ngày 10/03 và 11/03
  for (const c of [companion, companion2]) {
    addSlots(c, { date: '2026-03-10', hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] });
    addSlots(c, { date: '2026-03-11', hours: [8, 9, 10] });
  }
  if (renterBalance) topup(renter.id, renterBalance);
  topup(renter2.id, 500_000);

  const app = createApp();
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { renter, renter2, companion, companion2, cs, admin, base, close: () => new Promise((r) => server.close(r)) };
}

// Client HTTP có cookie
export async function login(base, email) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, data };
  };
  return { get: (p) => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

export const wallet = (userId) => {
  const rows = q.all('SELECT type, balance FROM ledger_accounts WHERE user_id=?', userId);
  return Object.fromEntries(rows.map((r) => [r.type, r.balance]));
};
export const platform = () => q.get("SELECT balance FROM ledger_accounts WHERE code='SYS:PLATFORM_REVENUE'").balance;

// Slot giờ VN h ngày 10/03/2026
export const at = (h, day = 10) => Date.UTC(2026, 2, day, h - 7, 0, 0);

let keyN = 0;
export const key = () => `test-key-${++keyN}-${Math.random().toString(36).slice(2, 8)}`;

export async function book(client, companionId, startAt, hours = 1, extra = {}) {
  return client.post('/bookings', { companionId, gameId: 1, startAt, hours, requestKey: key(), ...extra });
}
