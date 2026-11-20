import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { attachUser, errorHandler, requireAuth, h } from './http.js';
import { E } from './errors.js';
import { q } from './db.js';
import { clock } from './clock.js';
import { addClient } from './services/realtime.js';
import { logConnection } from './services/sessions.js';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import bookingRoutes from './routes/bookings.js';
import walletRoutes from './routes/wallet.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Header bảo mật cơ bản
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Chống CSRF: request ghi dữ liệu vào /api phải là JSON (form cross-site không gửi được application/json) + cookie SameSite=Lax.
  app.use('/api', (req, _res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json') && req.headers['content-length'] !== '0') {
      return next(E.badRequest('JSON_REQUIRED', 'Yêu cầu phải có Content-Type: application/json'));
    }
    next();
  });
  app.use('/api', express.json({ limit: '4mb' }));
  app.use('/api', attachUser);

  if (!config.isTest) {
    app.use('/api', (req, res, next) => {
      const t = Date.now();
      res.on('finish', () => {
        if (req.path !== '/events') console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t}ms`);
      });
      next();
    });
  }

  app.get('/api/health', (_req, res) => {
    const db = q.get('SELECT 1 AS ok');
    res.json({ status: 'ok', db: db.ok === 1, time: clock.now(), env: config.NODE_ENV, demoTools: config.DEMO_TOOLS });
  });

  // Kênh realtime SSE cho người dùng đã đăng nhập (thông báo, cập nhật booking, chat, tín hiệu WebRTC)
  app.get(
    '/api/events',
    requireAuth,
    h((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ userId: req.user.id, serverNow: clock.now() })}\n\n`);
      const remove = addClient(req.user.id, res);
      const roomId = Number(req.query.room) || null;
      if (roomId) logConnection(req.user, roomId, 'CONNECTED');
      const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
      req.on('close', () => {
        clearInterval(ping);
        remove();
        if (roomId) {
          try {
            logConnection(req.user, roomId, 'DISCONNECTED');
          } catch {
            /* DB có thể đã đóng khi tắt server */
          }
        }
      });
    }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api', walletRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', (_req, _res, next) => next(E.notFound('API không tồn tại')));

  // Phục vụ frontend đã build (một cổng duy nhất khi chạy npm start)
  if (fs.existsSync(path.join(config.CLIENT_DIST, 'index.html'))) {
    app.use(express.static(config.CLIENT_DIST, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(config.CLIENT_DIST, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
