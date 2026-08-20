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
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Upgrade path: sessions predates the idle-timeout tracking column.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

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

CREATE TABLE IF NOT EXISTS semesters (
  id TEXT PRIMARY KEY,
  label TEXT UNIQUE NOT NULL,
  starts_on DATE,
  ends_on DATE,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A template is a named set of dropdown option lists. Exactly one row has
-- is_default = true — the baseline every new template is cloned from.
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  student_key TEXT NOT NULL,
  semester_id TEXT REFERENCES semesters(id),
  template_id TEXT REFERENCES templates(id),
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
  created_by_name_override TEXT,
  updated_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_entries_student ON entries(student_key);
CREATE INDEX IF NOT EXISTS idx_entries_outreach_date ON entries(outreach_date);

-- Upgrade path for databases created before these columns existed. Must run
-- before any index/constraint below references them.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS semester_id TEXT REFERENCES semesters(id);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS created_by_name_override TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES templates(id);

CREATE INDEX IF NOT EXISTS idx_entries_semester ON entries(semester_id);
CREATE INDEX IF NOT EXISTS idx_entries_template ON entries(template_id);

CREATE TABLE IF NOT EXISTS template_options (
  id TEXT PRIMARY KEY,
  template_id TEXT REFERENCES templates(id),
  group_key TEXT NOT NULL,
  value TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade path: this table originally had no template_id column (one global
-- option set, uniqueness on group_key+value alone). db/migrate.js backfills
-- template_id onto pre-existing rows and swaps the unique constraint to be
-- scoped per-template (handled there, not here, since it needs to look up
-- the actual constraint name to drop it safely). Must run before the index
-- below, which references this column.
ALTER TABLE template_options ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES templates(id);

CREATE INDEX IF NOT EXISTS idx_template_group ON template_options(template_id, group_key);

-- Audit trail: every sensitive access or mutation writes one row here.
-- actor_id/actor_name are both stored (rather than joining users at read
-- time) so the log stays intact and attributable even if the acting user is
-- later deactivated or deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  action_type TEXT NOT NULL,
  target_record_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action_type);
