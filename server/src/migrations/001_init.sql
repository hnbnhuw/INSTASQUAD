-- INSTASQUAD schema v1. Mọi số tiền là INTEGER VND. Mọi thời điểm là epoch milliseconds (INTEGER, UTC).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                 -- NULL nếu chỉ đăng nhập OAuth2
  oauth_provider TEXT,
  oauth_subject TEXT,
  display_name  TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL CHECK (role IN ('RENTER','COMPANION','CS','ADMIN')),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED')),
  kyc_status    TEXT NOT NULL DEFAULT 'NONE' CHECK (kyc_status IN ('NONE','PENDING','VERIFIED','REJECTED','NEEDS_MORE_INFO')),
  trust_score   INTEGER NOT NULL DEFAULT 80 CHECK (trust_score BETWEEN 0 AND 100),
  created_at    INTEGER NOT NULL,
  UNIQUE (oauth_provider, oauth_subject)
);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- eKYC: dữ liệu nhạy cảm mã hóa AES-256-GCM (NFR-002)
CREATE TABLE kyc_records (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  full_name_enc  TEXT NOT NULL,
  id_number_enc  TEXT NOT NULL,
  dob_enc        TEXT NOT NULL,
  id_last4       TEXT NOT NULL,
  status         TEXT NOT NULL,
  provider_ref   TEXT,
  message        TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE games (
  id    INTEGER PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  ranks TEXT NOT NULL -- JSON array, thứ tự từ thấp đến cao
);

CREATE TABLE companion_profiles (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id),
  headline     TEXT NOT NULL DEFAULT '',
  bio          TEXT NOT NULL DEFAULT '',
  hourly_rate  INTEGER NOT NULL CHECK (hourly_rate > 0),
  accepting    INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  avatar_hue   INTEGER NOT NULL DEFAULT 200,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE companion_games (
  companion_id  INTEGER NOT NULL REFERENCES users(id),
  game_id       INTEGER NOT NULL REFERENCES games(id),
  rank          TEXT NOT NULL,
  rank_verified INTEGER NOT NULL DEFAULT 0,
  in_game_name  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (companion_id, game_id)
);

-- SLOT_CALENDAR: slot rời rạc 1 giờ. Chống đặt trùng: UNIQUE(companion_id,start_at) + cập nhật có điều kiện trong transaction.
CREATE TABLE slots (
  id           INTEGER PRIMARY KEY,
  companion_id INTEGER NOT NULL REFERENCES users(id),
  start_at     INTEGER NOT NULL,
  end_at       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','HELD','BOOKED','UNAVAILABLE')),
  booking_id   INTEGER,
  held_until   INTEGER,
  UNIQUE (companion_id, start_at)
);
CREATE INDEX idx_slots_status ON slots(status, held_until);

CREATE TABLE bookings (
  id                 INTEGER PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  renter_id          INTEGER NOT NULL REFERENCES users(id),
  companion_id       INTEGER NOT NULL REFERENCES users(id),
  game_id            INTEGER NOT NULL REFERENCES games(id),
  request_key        TEXT NOT NULL,
  request_hash       TEXT NOT NULL,
  start_at           INTEGER NOT NULL,
  end_at             INTEGER NOT NULL,
  hours              INTEGER NOT NULL CHECK (hours > 0),
  hourly_rate_snapshot INTEGER NOT NULL,
  total_fee_snapshot INTEGER NOT NULL CHECK (total_fee_snapshot > 0),
  note               TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,
  cancel_reason      TEXT,
  held_until         INTEGER,
  respond_deadline   INTEGER,
  confirm_deadline   INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (renter_id, request_key)
);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_companion ON bookings(companion_id, start_at);

CREATE TABLE booking_status_history (
  id            INTEGER PRIMARY KEY,
  booking_id    INTEGER NOT NULL REFERENCES bookings(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  actor_id      INTEGER,          -- NULL = SYSTEM
  reason        TEXT,
  ledger_txn_id INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_bsh_booking ON booking_status_history(booking_id);

-- LEDGER: tài khoản sổ cái. balance là cache, luôn được cập nhật cùng transaction với ledger_entries.
-- Quy ước: số dư = tổng CREDIT − tổng DEBIT. Tài khoản người dùng (trừ RECEIVABLE) không được âm.
CREATE TABLE ledger_accounts (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  user_id    INTEGER REFERENCES users(id),
  type       TEXT NOT NULL CHECK (type IN ('AVAILABLE','ESCROW','FROZEN','WITHDRAW_HOLD','RECEIVABLE',
                                           'PLATFORM_REVENUE','PLATFORM_PENALTY','GATEWAY_CLEARING','PAYOUT_CLEARING')),
  balance    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, type)
);

CREATE TABLE ledger_transactions (
  id          INTEGER PRIMARY KEY,
  reference   TEXT NOT NULL UNIQUE,  -- business reference / idempotency key: chống ghi trùng
  type        TEXT NOT NULL,
  booking_id  INTEGER,
  payment_id  INTEGER,
  withdrawal_id INTEGER,
  dispute_id  INTEGER,
  description TEXT NOT NULL,
  created_by  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_ltx_booking ON ledger_transactions(booking_id);

CREATE TABLE ledger_entries (
  id            INTEGER PRIMARY KEY,
  txn_id        INTEGER NOT NULL REFERENCES ledger_transactions(id),
  account_id    INTEGER NOT NULL REFERENCES ledger_accounts(id),
  direction     TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_le_account ON ledger_entries(account_id);
CREATE INDEX idx_le_txn ON ledger_entries(txn_id);

CREATE TABLE payments (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  booking_id      INTEGER,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL CHECK (method IN ('VNPAY_MOCK','MOMO_MOCK')),
  status          TEXT NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED','EXPIRED')),
  idempotency_key TEXT NOT NULL,
  gateway_txn_id  TEXT NOT NULL UNIQUE,
  ledger_txn_id   INTEGER,
  failure_reason  TEXT,
  callback_count  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE payment_callbacks (
  id              INTEGER PRIMARY KEY,
  payment_id      INTEGER,
  gateway_txn_id  TEXT,
  reported_status TEXT,
  signature_valid INTEGER NOT NULL,
  outcome         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE escrows (
  id            INTEGER PRIMARY KEY,
  booking_id    INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  renter_id     INTEGER NOT NULL,
  companion_id  INTEGER NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL CHECK (status IN ('HELD','FROZEN','RELEASED','REFUNDED','SPLIT','FORFEITED')),
  hold_txn_id   INTEGER NOT NULL,
  final_txn_id  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE platform_revenue (
  id            INTEGER PRIMARY KEY,
  booking_id    INTEGER,
  ledger_txn_id INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('COMMISSION','LATE_CANCEL_FEE','DISPUTE_PENALTY')),
  amount        INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE play_sessions (
  id               INTEGER PRIMARY KEY,
  booking_id       INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  status           TEXT NOT NULL CHECK (status IN ('ACTIVE','ENDED','INTERRUPTED')),
  started_at       INTEGER NOT NULL,
  scheduled_end_at INTEGER NOT NULL,
  ended_at         INTEGER
);

CREATE TABLE session_events (
  id         INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  user_id    INTEGER,
  type       TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  flagged    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_booking ON messages(booking_id, id);

CREATE TABLE disputes (
  id                INTEGER PRIMARY KEY,
  booking_id        INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  opened_by         INTEGER NOT NULL,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('OPEN','NEEDS_EVIDENCE','RESOLVED_REFUND','RESOLVED_RELEASE')),
  evidence_deadline INTEGER,
  fault_percent     INTEGER,
  decision_reason   TEXT,
  decided_by        INTEGER,
  decided_at        INTEGER,
  ledger_txn_id     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE evidence (
  id          INTEGER PRIMARY KEY,
  dispute_id  INTEGER NOT NULL REFERENCES disputes(id),
  uploader_id INTEGER,
  kind        TEXT NOT NULL CHECK (kind IN ('TEXT','FILE','CHAT_LOG','SYSTEM')),
  text        TEXT,
  file_name   TEXT,
  mime        TEXT,
  size        INTEGER,
  storage_key TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE reviews (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id),
  reviewer_id INTEGER NOT NULL,
  reviewee_id INTEGER NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  UNIQUE (booking_id, reviewer_id)
);

CREATE TABLE trust_score_logs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  event_ref  TEXT NOT NULL,
  old_score  INTEGER NOT NULL,
  new_score  INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  inputs     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, event_ref)
);

CREATE TABLE trust_deductions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  ref        TEXT NOT NULL UNIQUE,
  points     INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE withdraw_requests (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  payout_code     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','COMPLETED','REJECTED')),
  idempotency_key TEXT NOT NULL,
  reserve_txn_id  INTEGER NOT NULL,
  final_txn_id    INTEGER,
  processed_by    INTEGER,
  reject_reason   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  link       TEXT,
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, id);

CREATE TABLE ops_alerts (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  booking_id  INTEGER,
  operation   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  error       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolved_by INTEGER,
  resolution  TEXT,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE audit_logs (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  data       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE profile_views (
  id           INTEGER PRIMARY KEY,
  companion_id INTEGER NOT NULL,
  viewer_id    INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
