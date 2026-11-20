// Dữ liệu demo idempotent. Mọi số dư được tạo bằng đúng luồng nghiệp vụ (nạp tiền qua callback có chữ ký,
// đặt lịch, ký quỹ, giải ngân...) để sổ cái luôn nhất quán – không ghi số dư trực tiếp.
// Mật khẩu demo: Demo@123 (CHỈ dùng cho môi trường demo; đổi/xóa trước khi triển khai thật).
import { q, getDb, allTables } from './db.js';
import { clock } from './clock.js';
import { POLICY } from './policy.js';
import { encryptText, vnDayKey, vnDayStart } from './util.js';
import { ensureSystemAccounts } from './services/ledger.js';
import { createUser } from './services/users.js';
import { addSlots, updateProfile } from './services/companions.js';
import { createTopup, handleGatewayCallback, signCallback } from './services/payments.js';
import { createBooking, escrowBooking, respondToBooking, confirmCompletion } from './services/bookings.js';
import { createReview } from './services/reviews.js';
import { sendMessage } from './services/sessions.js';
import { openDispute } from './services/disputes.js';
import { runSchedulerOnce } from './scheduler.js';
import { setSetting } from './services/common.js';

export const DEMO_PASSWORD = 'Demo@123';
const HOUR = 3600 * 1000;

const GAMES = [
  ['LOL', 'Liên Minh Huyền Thoại', ['Sắt', 'Đồng', 'Bạc', 'Vàng', 'Bạch Kim', 'Lục Bảo', 'Kim Cương', 'Cao Thủ', 'Đại Cao Thủ', 'Thách Đấu']],
  ['VAL', 'Valorant', ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant']],
  ['LQM', 'Liên Quân Mobile', ['Đồng', 'Bạc', 'Vàng', 'Bạch Kim', 'Kim Cương', 'Tinh Anh', 'Cao Thủ', 'Chiến Tướng', 'Chiến Thần']],
  ['PUBGM', 'PUBG Mobile', ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Crown', 'Ace', 'Conqueror']],
  ['TFT', 'Đấu Trường Chân Lý', ['Sắt', 'Đồng', 'Bạc', 'Vàng', 'Bạch Kim', 'Lục Bảo', 'Kim Cương', 'Cao Thủ']],
];

const COMPANIONS = [
  { email: 'mai.companion@instasquad.local', name: 'Mai Leo Rank', headline: 'Support dễ thương, gánh team leo rank', rate: 60000, games: [['LOL', 'Kim Cương', 'MaiSupport'], ['TFT', 'Cao Thủ', 'MaiTFT']], hours: [9, 10, 11, 14, 15, 16, 19, 20, 21, 22] },
  { email: 'khoa.companion@instasquad.local', name: 'Khoa Valorant', headline: 'Duelist Immortal, coach aim & tactic', rate: 90000, games: [['VAL', 'Immortal', 'KhoaVAL']], hours: [13, 14, 15, 16, 20, 21, 22, 23] },
  { email: 'linh.companion@instasquad.local', name: 'Linh Liên Quân', headline: 'Chiến Tướng mid lane, nói chuyện vui vẻ', rate: 45000, games: [['LQM', 'Chiến Tướng', 'LinhLQ'], ['PUBGM', 'Ace', 'LinhPUBG']], hours: [8, 9, 10, 18, 19, 20, 21] },
  { email: 'tuan.companion@instasquad.local', name: 'Tuấn PUBG', headline: 'Conqueror, chơi chill buổi tối', rate: 70000, games: [['PUBGM', 'Conqueror', 'TuanPUBG']], hours: [19, 20, 21, 22, 23] },
  { email: 'ha.companion@instasquad.local', name: 'Hà Chill', headline: 'Chơi vui là chính, LoL & TFT', rate: 35000, games: [['LOL', 'Vàng', 'HaChill'], ['TFT', 'Kim Cương', 'HaTFT']], hours: [10, 11, 12, 13, 14, 15, 16, 17, 18] },
  { email: 'duc.companion@instasquad.local', name: 'Đức Coach', headline: 'Thách Đấu, phân tích replay chuyên sâu', rate: 150000, games: [['LOL', 'Thách Đấu', 'DucCoach'], ['VAL', 'Diamond', 'DucVAL']], hours: [7, 8, 9, 10, 20, 21, 22] },
];

function gameId(code) {
  return q.get('SELECT id FROM games WHERE code=?', code).id;
}

function topup(user, amount, key) {
  const { payment } = createTopup(user, { amount, method: 'VNPAY_MOCK', idempotencyKey: key });
  const payload = { gatewayTxnId: payment.gateway_txn_id, status: 'SUCCESS', amount };
  handleGatewayCallback({ ...payload, signature: signCallback(payload) });
}

function verifyKyc(userId, name) {
  const now = clock.now();
  q.run(
    `INSERT OR REPLACE INTO kyc_records(user_id, full_name_enc, id_number_enc, dob_enc, id_last4, status, provider_ref, message, attempts, updated_at)
     VALUES (?,?,?,?,?, 'VERIFIED', ?, 'Xác thực thành công (dữ liệu demo)', 1, ?)`,
    userId,
    encryptText(name),
    encryptText(`0792000${String(userId).padStart(5, '0')}`),
    encryptText('2000-01-01'),
    String(userId).padStart(4, '0'),
    `EKYC-SEED-${userId}`,
    now,
  );
  q.run("UPDATE users SET kyc_status='VERIFIED' WHERE id=?", userId);
}

const user = (email) => q.get('SELECT * FROM users WHERE email=?', email);

// Tạo một đơn hoàn tất trong quá khứ bằng cách "dịch" đồng hồ, chạy đúng các bước nghiệp vụ.
function pastCompletedBooking(renter, companion, gameCode, daysAgo, hour, rating, comment, companionRating) {
  const realNow = Date.now();
  const day = vnDayKey(realNow - daysAgo * 24 * HOUR);
  const start = vnDayStart(day) + hour * HOUR;
  clock.setOffset(start - 2 * HOUR - realNow);
  addSlots(companion, { date: day, hours: [hour] });
  const { booking } = createBooking(user(renter.email), { companionId: companion.id, gameId: gameId(gameCode), startAt: start, hours: 1, note: '', requestKey: `seed-${companion.id}-${daysAgo}-${hour}` });
  escrowBooking(booking.id, renter.id);
  respondToBooking(companion, booking.id, 'ACCEPT');
  clock.setOffset(start + HOUR + 60000 - realNow);
  runSchedulerOnce(); // bắt đầu + kết thúc phiên
  confirmCompletion(user(renter.email), booking.id);
  if (rating) createReview(user(renter.email), booking.id, { rating, comment });
  if (companionRating) createReview(user(companion.email), booking.id, { rating: companionRating, comment: 'Renter lịch sự, đúng giờ' });
  return booking;
}

export function seedIfEmpty() {
  if (q.get('SELECT COUNT(*) n FROM users').n > 0) return false;
  seed();
  return true;
}

export function seed() {
  const realNow = Date.now();
  ensureSystemAccounts();
  for (const [code, name, ranks] of GAMES) q.run('INSERT OR IGNORE INTO games(code, name, ranks) VALUES (?,?,?)', code, name, JSON.stringify(ranks));

  createUser({ email: 'admin@instasquad.local', password: DEMO_PASSWORD, displayName: 'Quản trị viên', role: 'ADMIN' });
  createUser({ email: 'cs@instasquad.local', password: DEMO_PASSWORD, displayName: 'CS Ngọc', role: 'CS' });
  const renters = [
    ['an.renter@instasquad.local', 'An Nguyễn', 1_000_000],
    ['binh.renter@instasquad.local', 'Bình Trần', 300_000],
    ['chi.renter@instasquad.local', 'Chi Lê (ví ít tiền)', 40_000],
  ].map(([email, name, money], i) => {
    const u = createUser({ email, password: DEMO_PASSWORD, displayName: name, role: 'RENTER' });
    if (money) topup(u, money, `seed-topup-${i}`);
    return u;
  });

  const comps = COMPANIONS.map((c) => {
    const u = createUser({ email: c.email, password: DEMO_PASSWORD, displayName: c.name, role: 'COMPANION' });
    verifyKyc(u.id, c.name);
    const fresh = user(c.email);
    updateProfile(fresh, {
      headline: c.headline,
      bio: `${c.headline}. Mình online đúng giờ, giao tiếp lịch sự, không toxic. Đặt lịch qua INSTASQUAD để được bảo vệ bằng ký quỹ.`,
      hourlyRate: c.rate,
      accepting: true,
      games: c.games.map(([code, rank, ign]) => ({ gameId: gameId(code), rank, inGameName: ign })),
    });
    q.run('UPDATE companion_games SET rank_verified=1 WHERE companion_id=?', u.id);
    return { ...fresh, cfg: c };
  });
  // Companion chưa eKYC (không xuất hiện trong tìm kiếm)
  const newbie = createUser({ email: 'newbie.companion@instasquad.local', password: DEMO_PASSWORD, displayName: 'Companion Mới (chưa eKYC)', role: 'COMPANION' });
  updateProfile(user(newbie.email), { headline: 'Mới tham gia', hourlyRate: 40000, games: [{ gameId: gameId('LOL'), rank: 'Bạc', inGameName: 'Newbie' }] });

  // Lịch sử đơn hoàn tất + đánh giá (tạo bằng luồng thật)
  const [an, binh] = renters;
  pastCompletedBooking(an, comps[0], 'LOL', 6, 20, 5, 'Support cực kỳ có tâm, leo được 2 bậc!', 5);
  pastCompletedBooking(binh, comps[0], 'TFT', 5, 15, 5, 'Hướng dẫn đội hình rất dễ hiểu', 4);
  pastCompletedBooking(an, comps[1], 'VAL', 4, 21, 4, 'Aim khủng, hơi ít nói', 5);
  pastCompletedBooking(binh, comps[2], 'LQM', 3, 19, 5, 'Vui tính, chơi mid rất hay', null);
  pastCompletedBooking(an, comps[4], 'LOL', 2, 14, 3, 'Ổn, nhưng vào trễ vài phút', 4);
  pastCompletedBooking(an, comps[5], 'LOL', 1, 21, 5, 'Phân tích replay chuyên nghiệp', 5);

  // Một khiếu nại đang mở để demo luồng CS (phiên vừa kết thúc ~1 giờ trước)
  {
    const startH = Math.floor((realNow - 2 * HOUR) / HOUR) * HOUR;
    const comp = comps[3];
    clock.setOffset(startH - 30 * 60000 - realNow);
    q.run("INSERT OR IGNORE INTO slots(companion_id, start_at, end_at, status) VALUES (?,?,?, 'AVAILABLE')", comp.id, startH, startH + HOUR);
    const { booking } = createBooking(user(binh.email), { companionId: comp.id, gameId: gameId('PUBGM'), startAt: startH, hours: 1, note: 'Leo rank đêm', requestKey: 'seed-dispute-1' });
    escrowBooking(booking.id, binh.id);
    respondToBooking(comp, booking.id, 'ACCEPT');
    clock.setOffset(startH + 5 * 60000 - realNow);
    runSchedulerOnce();
    sendMessage(user(binh.email), booking.id, 'Chào bạn, mình vào phòng rồi nhé');
    clock.setOffset(startH + 25 * 60000 - realNow);
    sendMessage(user(binh.email), booking.id, 'Bạn ơi sao chưa thấy vào game? Đã 20 phút rồi');
    sendMessage(user(comp.email), booking.id, 'Xin lỗi mạng mình lag, gọi mình qua 0912 345 678 nhé');
    clock.setOffset(startH + HOUR + 2 * 60000 - realNow);
    runSchedulerOnce();
    openDispute(user(binh.email), booking.id, { reason: 'Companion vào trễ hơn 30 phút', detail: 'Companion chỉ chơi khoảng 25 phút, phần còn lại không online.' });
  }
  clock.setOffset(0);
  setSetting('demo.clock_offset', 0);

  // Lịch rảnh 7 ngày tới cho các Companion
  const today = vnDayKey(realNow);
  for (const c of comps) {
    for (let d = 0; d < 7; d++) {
      const day = vnDayKey(vnDayStart(today) + d * 24 * HOUR + 12 * HOUR);
      addSlots(c, { date: day, hours: c.cfg.hours });
    }
    // Đảm bảo luôn có vài khung giờ sắp tới (để demo hủy 30/10 phút và bắt đầu phiên)
    const nextH = Math.ceil((realNow + 60000) / HOUR) * HOUR;
    for (let k = 0; k < 4; k++) q.run("INSERT OR IGNORE INTO slots(companion_id, start_at, end_at, status) VALUES (?,?,?, 'AVAILABLE')", c.id, nextH + k * HOUR, nextH + (k + 1) * HOUR);
  }
  q.run('DELETE FROM notifications'); // bỏ thông báo sinh ra khi seed
  console.log(`[seed] Đã tạo dữ liệu demo. Mật khẩu chung: ${DEMO_PASSWORD}`);
  return true;
}

export function resetAndSeed() {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const t of allTables()) db.exec(`DELETE FROM "${t}"`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  clock.setOffset(0);
  seed();
}

export { POLICY };
