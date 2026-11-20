import { config } from './config.js';
import { initDb, closeDb, q } from './db.js';
import { createApp } from './app.js';
import { startScheduler, stopScheduler, runSchedulerOnce } from './scheduler.js';
import { seedIfEmpty } from './seed.js';
import { clock } from './clock.js';
import { getSetting } from './services/common.js';

initDb(config.DB_FILE);
if (!config.isProd) seedIfEmpty();
// Khôi phục độ lệch đồng hồ demo (nếu có) để dữ liệu nhất quán sau khi khởi động lại
const savedOffset = Number(getSetting('demo.clock_offset', '0'));
if (config.DEMO_TOOLS && savedOffset) clock.setOffset(savedOffset);
// Xử lý bù các hạn chót đã qua trong lúc server tắt
runSchedulerOnce();
startScheduler();

const app = createApp();
const server = app.listen(config.PORT, () => {
  const users = q.get('SELECT COUNT(*) n FROM users').n;
  console.log(`INSTASQUAD API chạy tại http://localhost:${config.PORT} (env=${config.NODE_ENV}, users=${users}, demoTools=${config.DEMO_TOOLS})`);
});

function shutdown() {
  stopScheduler();
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
