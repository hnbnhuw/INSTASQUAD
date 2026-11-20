// CLI: node src/cli.js <migrate|seed|reset|reconcile>
import { config } from './config.js';
import { initDb, closeDb } from './db.js';
import { seedIfEmpty, resetAndSeed } from './seed.js';
import { reconcile } from './services/ledger.js';

const cmd = process.argv[2];
initDb(config.DB_FILE); // initDb luôn chạy migrations còn thiếu
switch (cmd) {
  case 'migrate':
    console.log(`Migrations OK → ${config.DB_FILE}`);
    break;
  case 'seed':
    console.log(seedIfEmpty() ? 'Seed xong.' : 'DB đã có dữ liệu, bỏ qua seed (dùng "npm run reset" để làm lại từ đầu).');
    break;
  case 'reset':
    if (config.isProd) {
      console.error('Không cho phép reset ở production');
      process.exit(1);
    }
    resetAndSeed();
    console.log('Đã reset và seed lại dữ liệu demo.');
    break;
  case 'reconcile': {
    const r = reconcile();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exitCode = 2;
    break;
  }
  default:
    console.log('Dùng: node src/cli.js <migrate|seed|reset|reconcile>');
    process.exitCode = 1;
}
closeDb();
