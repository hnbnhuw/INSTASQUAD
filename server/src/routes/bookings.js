import { Router } from 'express';
import { z } from 'zod';
import { h, parse, id, idemKey, requireAuth, requireRole } from '../http.js';
import { E } from '../errors.js';
import { q } from '../db.js';
import { clock } from '../clock.js';
import {
  createBooking,
  escrowBooking,
  respondToBooking,
  cancelByRenter,
  confirmCompletion,
  getBooking,
  bookingDetail,
  canViewBooking,
  BOOKING_STATUS,
} from '../services/bookings.js';
import { getWallet } from '../services/ledger.js';
import { openDispute } from '../services/disputes.js';
import { createReview } from '../services/reviews.js';
import { roomInfo, sendMessage, relaySignal } from '../services/sessions.js';

const r = Router();
r.use(requireAuth);

r.get(
  '/',
  h((req, res) => {
    const u = req.user;
    const col = u.role === 'COMPANION' ? 'companion_id' : 'renter_id';
    const rows = q.all(
      `SELECT b.id, b.code, b.status, b.start_at, b.end_at, b.hours, b.total_fee_snapshot, b.respond_deadline, b.confirm_deadline, b.held_until, b.cancel_reason, b.created_at,
              g.name AS game_name, r.display_name AS renter_name, c.display_name AS companion_name, c.id AS companion_id, r.id AS renter_id
         FROM bookings b JOIN games g ON g.id=b.game_id JOIN users r ON r.id=b.renter_id JOIN users c ON c.id=b.companion_id
        WHERE b.${col}=? ORDER BY b.id DESC LIMIT 200`,
      u.id,
    );
    res.json({ bookings: rows.map((b) => ({ ...b, status_label: BOOKING_STATUS[b.status] })), serverNow: clock.now() });
  }),
);

const createSchema = z.object({
  companionId: z.number().int().positive(),
  gameId: z.number().int().positive(),
  startAt: z.number().int().positive(),
  hours: z.number().int(),
  note: z.string().trim().max(300).optional(),
  requestKey: idemKey,
});

// Tạo yêu cầu đặt lịch: kiểm tra trùng/slot/10h → giữ chỗ → nếu đủ số dư thì ký quỹ ngay (Hình 1A)
r.post(
  '/',
  requireRole('RENTER'),
  h((req, res) => {
    const body = parse(createSchema, { ...req.body, requestKey: req.get('Idempotency-Key') || req.body?.requestKey });
    const { booking, duplicate } = createBooking(req.user, body);
    let escrow = { escrowed: booking.status !== 'AWAITING_ESCROW' };
    if (!duplicate && booking.status === 'AWAITING_ESCROW') {
      try {
        escrowBooking(booking.id, req.user.id);
        escrow = { escrowed: true };
      } catch (e) {
        escrow = { escrowed: false, reason: e.code, message: e.message, details: e.details };
      }
    }
    const b = getBooking(booking.id);
    res.status(duplicate ? 200 : 201).json({ booking: bookingDetail(b, req.user), duplicate, escrow, wallet: getWallet(req.user.id) });
  }),
);

function load(req) {
  const b = getBooking(parse(id, req.params.id));
  if (!b) throw E.notFound('Không tìm thấy đơn');
  if (!canViewBooking(req.user, b)) throw E.forbidden('Bạn không có quyền xem đơn này');
  return b;
}

r.get('/:id', h((req, res) => res.json({ booking: bookingDetail(load(req), req.user) })));

r.post(
  '/:id/escrow',
  requireRole('RENTER'),
  h((req, res) => {
    const b = load(req);
    const out = escrowBooking(b.id, req.user.id);
    res.json({ booking: bookingDetail(out.booking, req.user), duplicate: out.duplicate, wallet: getWallet(req.user.id) });
  }),
);

r.post(
  '/:id/respond',
  requireRole('COMPANION'),
  h((req, res) => {
    const { decision } = parse(z.object({ decision: z.enum(['ACCEPT', 'REJECT']) }), req.body);
    const b = load(req);
    const out = respondToBooking(req.user, b.id, decision);
    res.json({ booking: bookingDetail(out.booking, req.user), duplicate: out.duplicate });
  }),
);

r.post(
  '/:id/cancel',
  requireRole('RENTER'),
  h((req, res) => {
    const b = load(req);
    const out = cancelByRenter(req.user, b.id);
    res.json({ booking: bookingDetail(out.booking, req.user), duplicate: out.duplicate, wallet: getWallet(req.user.id) });
  }),
);

r.post(
  '/:id/confirm',
  requireRole('RENTER'),
  h((req, res) => {
    const b = load(req);
    const out = confirmCompletion(req.user, b.id);
    res.json({ booking: bookingDetail(out.booking, req.user), duplicate: out.duplicate });
  }),
);

r.post(
  '/:id/dispute',
  requireRole('RENTER'),
  h((req, res) => {
    const body = parse(z.object({ reason: z.string().trim().min(5, 'Lý do tối thiểu 5 ký tự').max(200), detail: z.string().trim().max(2000).optional() }), req.body);
    const b = load(req);
    const out = openDispute(req.user, b.id, body);
    res.status(out.duplicate ? 200 : 201).json({ dispute: out.dispute, duplicate: out.duplicate, booking: bookingDetail(getBooking(b.id), req.user) });
  }),
);

r.post(
  '/:id/review',
  h((req, res) => {
    const body = parse(z.object({ rating: z.number().int(), comment: z.string().trim().max(1000).optional() }), req.body);
    const b = load(req);
    res.status(201).json({ review: createReview(req.user, b.id, body) });
  }),
);

// ---- Phòng phiên chơi ----
r.get('/:id/room', h((req, res) => res.json(roomInfo(req.user, parse(id, req.params.id)))));
r.post(
  '/:id/messages',
  h((req, res) => {
    const { body } = parse(z.object({ body: z.string().max(1000) }), req.body);
    res.status(201).json({ message: sendMessage(req.user, parse(id, req.params.id), body) });
  }),
);
r.post(
  '/:id/rtc',
  h((req, res) => {
    const body = parse(z.object({ type: z.string(), data: z.any().optional() }), req.body);
    res.json(relaySignal(req.user, parse(id, req.params.id), body));
  }),
);

export default r;
