import { Router } from 'express';
import { z } from 'zod';
import { h, parse, id, requireRole } from '../http.js';
import { listGames, searchCompanions, companionPublic, myProfile, updateProfile, verifyRank, mySlots, addSlots, removeSlot } from '../services/companions.js';
import { clock } from '../clock.js';

const r = Router();

r.get('/games', h((_req, res) => res.json({ games: listGames() })));

const searchSchema = z.object({
  gameId: z.coerce.number().int().positive().optional(),
  rank: z.string().max(40).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().positive().optional(),
  minTrust: z.coerce.number().int().min(0).max(100).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(50).optional(),
  sort: z.enum(['match', 'trust', 'price_asc', 'price_desc', 'rating']).optional(),
  availableOnly: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

r.get(
  '/companions',
  h((req, res) => {
    const f = parse(searchSchema, Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== '')));
    const t0 = performance.now();
    const companions = searchCompanions(f, req.user);
    res.json({ companions, tookMs: Math.round(performance.now() - t0) });
  }),
);

r.get('/companions/:id', h((req, res) => res.json({ companion: companionPublic(parse(id, req.params.id), req.user) })));

// ---- Companion tự quản lý hồ sơ & lịch ----
const me = Router();
me.use(requireRole('COMPANION'));
me.get('/profile', h((req, res) => res.json({ profile: myProfile(req.user.id) })));
me.put(
  '/profile',
  h((req, res) => {
    const body = parse(
      z.object({
        headline: z.string().trim().max(80).optional(),
        bio: z.string().trim().max(1000).optional(),
        hourlyRate: z.number().int().optional(),
        accepting: z.boolean().optional(),
        games: z
          .array(z.object({ gameId: z.number().int().positive(), rank: z.string().min(1).max(40), inGameName: z.string().trim().max(40).optional() }))
          .max(10)
          .optional(),
      }),
      req.body,
    );
    res.json({ profile: updateProfile(req.user, body) });
  }),
);
me.post('/games/:gameId/verify-rank', h((req, res) => res.json(verifyRank(req.user, parse(id, req.params.gameId)))));
me.get(
  '/slots',
  h((req, res) => {
    const now = clock.now();
    const from = Number(req.query.from) || now - 24 * 3600 * 1000;
    const to = Number(req.query.to) || now + 14 * 24 * 3600 * 1000;
    res.json({ slots: mySlots(req.user.id, from, to), serverNow: now });
  }),
);
me.post(
  '/slots',
  h((req, res) => {
    const body = parse(z.object({ date: z.string(), hours: z.array(z.number().int()).min(1).max(24) }), req.body);
    res.status(201).json(addSlots(req.user, body));
  }),
);
me.delete('/slots/:id', h((req, res) => res.json(removeSlot(req.user, parse(id, req.params.id)))));

r.use('/me/companion', me);
export default r;
