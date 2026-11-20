// Truy cập SQLite qua module có sẵn node:sqlite (không cần cài DB server).
// API đồng bộ + BEGIN IMMEDIATE ⇒ mỗi transaction được tuần tự hóa (serializable) trong toàn bộ DB.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

let db = null;
let txDepth = 0;

export function initDb(file) {
  if (db) db.close();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  txDepth = 0;
  migrate();
  return db;
}

export function getDb() {
  if (!db) throw new Error('DB chưa được khởi tạo');
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(f, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${f} thất bại: ${e.message}`);
    }
  }
}

// Chạy fn trong một transaction. Lồng nhau thì dùng chung transaction ngoài cùng.
// Nếu fn ném lỗi: ROLLBACK toàn bộ, không có trạng thái nửa vời.
let afterCommit = [];

export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  afterCommit = [];
  try {
    const result = fn();
    txDepth--;
    db.exec('COMMIT');
    const cbs = afterCommit;
    afterCommit = [];
    for (const cb of cbs) {
      try {
        cb();
      } catch (e) {
        console.error('[afterCommit]', e);
      }
    }
    return result;
  } catch (e) {
    txDepth--;
    afterCommit = [];
    db.exec('ROLLBACK');
    throw e;
  }
}

// Hiệu ứng phụ (đẩy realtime) chỉ chạy sau khi COMMIT thành công; bị hủy nếu ROLLBACK.
export function onCommit(cb) {
  if (txDepth > 0) afterCommit.push(cb);
  else cb();
}

export const q = {
  get: (sql, ...p) => getDb().prepare(sql).get(...p),
  all: (sql, ...p) => getDb().prepare(sql).all(...p),
  run: (sql, ...p) => getDb().prepare(sql).run(...p),
};

// Danh sách bảng nghiệp vụ (dùng cho demo reset).
export function allTables() {
  return q
    .all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'")
    .map((r) => r.name);
}
