// Hồ sơ Companion, Slot Calendar, tìm kiếm & matchmaking (FR-002, FR-003, UC02).
import { q, tx } from '../db.js';
import { clock } from '../clock.js';
import { POLICY } from '../policy.js';
import { E } from '../errors.js';
import { parseJson, vnDayStart } from '../util.js';
import { audit } from './common.js';

export function listGames() {
  return q.all('SELECT * FROM games ORDER BY name').map((g) => ({ ...g, ranks: parseJson(g.ranks, []) }));
}

function rankIndex(gameId, rank) {
  const g = q.get('SELECT ranks FROM games WHERE id=?', gameId);
  return g ? parseJson(g.ranks, []).indexOf(rank) : -1;
}

function companionGames(userId) {
  return q.all(
    `SELECT cg.game_id, g.name AS game_name, g.code AS game_code, cg.rank, cg.rank_verified, cg.in_game_name
       FROM companion_games cg JOIN games g ON g.id=cg.game_id WHERE cg.companion_id=? ORDER BY g.name`,
    userId,
  );
}

function ratingStats(userId) {
  const r = q.get('SELECT AVG(rating) avg, COUNT(*) n FROM reviews WHERE reviewee_id=?', userId);
  return { rating_avg: r.n ? Math.round(r.avg * 10) / 10 : null, rating_count: r.n };
}

export function searchCompanions(filters, viewer) {
  const now = clock.now();
  const where = ["u.role='COMPANION'", "u.status='ACTIVE'", "u.kyc_status='VERIFIED'", "p.status='ACTIVE'", 'p.accepting=1',
    'EXISTS (SELECT 1 FROM companion_games cg0 WHERE cg0.companion_id=u.id)'];
  const params = [];
  if (filters.gameId) {
    where.push('EXISTS (SELECT 1 FROM companion_games cg WHERE cg.companion_id=u.id AND cg.game_id=?)');
    params.push(filters.gameId);
  }
  if (filters.minPrice) {
    where.push('p.hourly_rate >= ?');
    params.push(filters.minPrice);
  }
  if (filters.maxPrice) {
    where.push('p.hourly_rate <= ?');
    params.push(filters.maxPrice);
  }
  if (filters.minTrust) {
    where.push('u.trust_score >= ?');
    params.push(filters.minTrust);
  }
  if (filters.q) {
    where.push('(u.display_name LIKE ? OR p.headline LIKE ?)');
    params.push(`%${filters.q}%`, `%${filters.q}%`);
  }
  let slotCond = 'start_at > ?';
  const slotParams = [now];
  if (filters.date) {
    const s = vnDayStart(filters.date);
    slotCond = 'start_at > ? AND start_at >= ? AND start_at < ?';
    slotParams.push(s, s + 24 * 3600 * 1000);
  }
  const rows = q.all(
    `SELECT u.id, u.display_name, u.trust_score, p.headline, p.hourly_rate, p.avatar_hue,
            (SELECT MIN(start_at) FROM slots WHERE companion_id=u.id AND status='AVAILABLE' AND ${slotCond}) AS next_slot,
            (SELECT COUNT(*) FROM slots WHERE companion_id=u.id AND status='AVAILABLE' AND ${slotCond}) AS free_slots
       FROM users u JOIN companion_profiles p ON p.user_id=u.id
      WHERE ${where.join(' AND ')}`,
    ...slotParams,
    ...slotParams,
    ...params,
  );
  let result = rows.map((r) => ({ ...r, games: companionGames(r.id), ...ratingStats(r.id) }));
  if (filters.gameId && filters.rank) {
    const min = rankIndex(filters.gameId, filters.rank);
    result = result.filter((r) => r.games.some((g) => g.game_id === filters.gameId && rankIndex(g.game_id, g.rank) >= min));
  }
  if (filters.date || filters.availableOnly) result = result.filter((r) => r.free_slots > 0);
  // Matchmaking score: ưu tiên TrustScore, đánh giá, còn slot sớm, giá hợp lý (minh bạch, không dùng AI)
  for (const r of result) {
    const soon = r.next_slot ? Math.max(0, 1 - (r.next_slot - now) / (7 * 24 * 3600 * 1000)) : 0;
    const rating = r.rating_avg ? r.rating_avg / 5 : 0.8;
    r.match_score = Math.round(r.trust_score * 0.5 + rating * 30 + soon * 20);
  }
  const sort = filters.sort || 'match';
  const cmp = {
    match: (a, b) => b.match_score - a.match_score,
    trust: (a, b) => b.trust_score - a.trust_score,
    price_asc: (a, b) => a.hourly_rate - b.hourly_rate,
    price_desc: (a, b) => b.hourly_rate - a.hourly_rate,
    rating: (a, b) => (b.rating_avg || 0) - (a.rating_avg || 0),
  }[sort];
  if (cmp) result.sort(cmp);
  return result;
}

export function companionPublic(id, viewer) {
  const u = q.get(
    `SELECT u.id, u.display_name, u.trust_score, u.kyc_status, u.status, u.created_at, p.headline, p.bio, p.hourly_rate, p.accepting, p.status AS profile_status, p.avatar_hue
       FROM users u JOIN companion_profiles p ON p.user_id=u.id WHERE u.id=? AND u.role='COMPANION'`,
    id,
  );
  if (!u) throw E.notFound('Không tìm thấy Companion');
  const now = clock.now();
  const slots = q.all(
    `SELECT id, start_at, end_at, CASE WHEN status='AVAILABLE' THEN 'AVAILABLE' WHEN status='UNAVAILABLE' THEN 'UNAVAILABLE' ELSE 'BUSY' END AS status
       FROM slots WHERE companion_id=? AND start_at > ? AND start_at < ? ORDER BY start_at`,
    id,
    now,
    now + 8 * 24 * 3600 * 1000,
  );
  const reviews = q.all(
    `SELECT r.rating, r.comment, r.created_at, u.display_name AS reviewer_name FROM reviews r JOIN users u ON u.id=r.reviewer_id
      WHERE r.reviewee_id=? ORDER BY r.id DESC LIMIT 20`,
    id,
  );
  const completed = q.get("SELECT COUNT(*) n FROM bookings WHERE companion_id=? AND status IN ('COMPLETED','RESOLVED_RELEASED')", id).n;
  if (viewer && viewer.id !== id) q.run('INSERT INTO profile_views(companion_id, viewer_id, created_at) VALUES (?,?,?)', id, viewer.id, now);
  return {
    ...u,
    bookable: u.status === 'ACTIVE' && u.kyc_status === 'VERIFIED' && u.profile_status === 'ACTIVE' && u.accepting === 1,
    verified: u.kyc_status === 'VERIFIED',
    games: companionGames(id),
    slots,
    reviews,
    completed_count: completed,
    ...ratingStats(id),
  };
}

export function myProfile(userId) {
  const p = q.get('SELECT * FROM companion_profiles WHERE user_id=?', userId);
  return { ...p, games: companionGames(userId) };
}

export function updateProfile(user, { headline, bio, hourlyRate, accepting, games }) {
  if (hourlyRate !== undefined && (!Number.isSafeInteger(hourlyRate) || hourlyRate < POLICY.MIN_HOURLY_RATE || hourlyRate > POLICY.MAX_HOURLY_RATE)) {
    throw E.badRequest('INVALID_RATE', `Giá/giờ phải là số nguyên từ ${POLICY.MIN_HOURLY_RATE.toLocaleString('vi-VN')} đến ${POLICY.MAX_HOURLY_RATE.toLocaleString('vi-VN')}đ`);
  }
  return tx(() => {
    const cur = q.get('SELECT * FROM companion_profiles WHERE user_id=?', user.id);
    q.run(
      'UPDATE companion_profiles SET headline=?, bio=?, hourly_rate=?, accepting=?, updated_at=? WHERE user_id=?',
      headline ?? cur.headline,
      bio ?? cur.bio,
      hourlyRate ?? cur.hourly_rate,
      accepting === undefined ? cur.accepting : accepting ? 1 : 0,
      clock.now(),
      user.id,
    );
    if (games) {
      const existing = new Map(q.all('SELECT * FROM companion_games WHERE companion_id=?', user.id).map((g) => [g.game_id, g]));
      q.run('DELETE FROM companion_games WHERE companion_id=?', user.id);
      for (const g of games) {
        if (rankIndex(g.gameId, g.rank) < 0) throw E.badRequest('INVALID_RANK', 'Rank không hợp lệ cho game đã chọn');
        const old = existing.get(g.gameId);
        const keepVerified = old && old.rank === g.rank && old.in_game_name === (g.inGameName || '') ? old.rank_verified : 0;
        q.run(
          'INSERT INTO companion_games(companion_id, game_id, rank, rank_verified, in_game_name) VALUES (?,?,?,?,?)',
          user.id,
          g.gameId,
          g.rank,
          keepVerified,
          g.inGameName || '',
        );
      }
    }
    audit(user.id, 'PROFILE_UPDATE', 'companion_profile', user.id, { hourlyRate, accepting });
    return myProfile(user.id);
  });
}

// Game API MÔ PHỎNG: đối chiếu rank theo tên in-game. Tên chứa "fake" → không khớp; "offline" → API lỗi.
export function verifyRank(user, gameId) {
  const g = q.get('SELECT * FROM companion_games WHERE companion_id=? AND game_id=?', user.id, gameId);
  if (!g) throw E.notFound('Bạn chưa thêm game này');
  if (!g.in_game_name) throw E.badRequest('IGN_REQUIRED', 'Cần nhập tên in-game để đối chiếu');
  if (/offline/i.test(g.in_game_name)) throw E.unprocessable('GAME_API_UNAVAILABLE', 'Game API không phản hồi (mô phỏng), thử lại sau');
  const ok = !/fake/i.test(g.in_game_name);
  q.run('UPDATE companion_games SET rank_verified=? WHERE companion_id=? AND game_id=?', ok ? 1 : 0, user.id, gameId);
  return { verified: ok, message: ok ? 'Rank khớp dữ liệu Game API (mô phỏng)' : 'Rank không khớp dữ liệu Game API (mô phỏng)' };
}

export function mySlots(userId, from, to) {
  return q.all(
    `SELECT s.*, b.code AS booking_code, b.status AS booking_status FROM slots s LEFT JOIN bookings b ON b.id=s.booking_id
      WHERE s.companion_id=? AND s.start_at>=? AND s.start_at<? ORDER BY s.start_at`,
    userId,
    from,
    to,
  );
}

export function addSlots(user, { date, hours }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw E.badRequest('INVALID_DATE', 'Ngày không hợp lệ');
  if (!Array.isArray(hours) || !hours.length || hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
    throw E.badRequest('INVALID_HOURS', 'Danh sách giờ không hợp lệ (0–23)');
  }
  const dayStart = vnDayStart(date);
  const now = clock.now();
  return tx(() => {
    let created = 0;
    for (const h of [...new Set(hours)]) {
      const start = dayStart + h * POLICY.SLOT_MS;
      if (start <= now) continue;
      const existing = q.get('SELECT * FROM slots WHERE companion_id=? AND start_at=?', user.id, start);
      if (existing) {
        if (existing.status === 'UNAVAILABLE' && !existing.booking_id) {
          q.run("UPDATE slots SET status='AVAILABLE' WHERE id=?", existing.id);
          created++;
        }
        continue;
      }
      q.run("INSERT INTO slots(companion_id, start_at, end_at, status) VALUES (?,?,?, 'AVAILABLE')", user.id, start, start + POLICY.SLOT_MS);
      created++;
    }
    return { created };
  });
}

export function removeSlot(user, slotId) {
  return tx(() => {
    const s = q.get('SELECT * FROM slots WHERE id=?', slotId);
    if (!s || s.companion_id !== user.id) throw E.notFound('Không tìm thấy khung giờ');
    if (s.status !== 'AVAILABLE') throw E.conflict('SLOT_IN_USE', 'Khung giờ đang được giữ/đặt, không thể xóa');
    q.run("DELETE FROM slots WHERE id=? AND status='AVAILABLE'", slotId);
    return { removed: 1 };
  });
}
