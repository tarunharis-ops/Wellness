-- Wellness Case Tracker — Postgres schema.
-- Applied idempotently by db/migrate.js on every boot.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'counselor',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'counselor',
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  student_key TEXT NOT NULL,
  case_status TEXT,
  first_name TEXT,
  last_name TEXT,
  pronouns TEXT,
  international TEXT,
  program TEXT,
  modality TEXT,
  enrollment_status TEXT,
  columbia_officer TEXT,
  nabita_risk TEXT,
  referral_source TEXT,
  referral_date DATE,
  outreach_type TEXT,
  outreach_method TEXT,
  outreach_date DATE,
  outreach_conducted TEXT,
  duration_minutes NUMERIC,
  outreach_outcome TEXT,
  concern_primary TEXT,
  concern_secondary TEXT,
  concern_tertiary TEXT,
  referrals_made TEXT,
  referral_primary TEXT,
  referral_secondary TEXT,
  referral_tertiary TEXT,
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entries_student ON entries(student_key);
CREATE INDEX IF NOT EXISTS idx_entries_outreach_date ON entries(outreach_date);

CREATE TABLE IF NOT EXISTS template_options (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  value TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_key, value)
);
CREATE INDEX IF NOT EXISTS idx_template_group ON template_options(group_key);
