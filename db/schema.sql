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
  student_id_external TEXT,
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
ALTER TABLE entries ADD COLUMN IF NOT EXISTS student_id_external TEXT;

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

-- ---------------------------------------------------------------------------
-- Student Records — a reference dataset (synthetic demo data: "Alderbrook
-- University") joined from four source systems: the SIS roster plus
-- Housing, Campus Safety, and Academic Integrity records, and the general
-- Web/Anonymous Reporting Portal. Seeded once from the CSVs in
-- data/student_records/ by db/migrate.js — see that folder's README.md for
-- full column definitions and provenance. Wellness case entries link into
-- this roster via entries.student_id (see below) so a student's profile can
-- pull records from every domain, including Wellness.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS students (
  student_id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  dob DATE,
  major TEXT,
  academic_year TEXT,
  enrollment_status TEXT,
  advisor TEXT,
  phone TEXT,
  address TEXT,
  enrollment_date DATE
);
CREATE INDEX IF NOT EXISTS idx_students_last_name ON students(lower(last_name));
CREATE INDEX IF NOT EXISTS idx_students_first_name ON students(lower(first_name));

-- Real FK linkage from Wellness case entries to the canonical Student
-- Records roster, distinct from entries.student_id_external (free-text,
-- user-typed, often unmatched). Nullable — most entries may never resolve
-- to a known student_id; a non-null value must reference a real row.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS student_id TEXT REFERENCES students(student_id);
CREATE INDEX IF NOT EXISTS idx_entries_student_id ON entries(student_id);

CREATE TABLE IF NOT EXISTS housing (
  housing_id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(student_id),
  residence_hall TEXT,
  room_number TEXT,
  move_in_date DATE,
  move_out_date DATE,
  housing_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_housing_student ON housing(student_id);

CREATE TABLE IF NOT EXISTS campus_safety (
  report_id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(student_id),
  incident_date DATE,
  location TEXT,
  incident_type TEXT,
  severity TEXT,
  status TEXT,
  narrative TEXT
);
CREATE INDEX IF NOT EXISTS idx_campus_safety_student ON campus_safety(student_id);

CREATE TABLE IF NOT EXISTS academic_integrity (
  case_id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(student_id),
  course_code TEXT,
  course_name TEXT,
  faculty_name TEXT,
  incident_date DATE,
  violation_type TEXT,
  severity TEXT,
  status TEXT,
  description TEXT
);
CREATE INDEX IF NOT EXISTS idx_academic_integrity_student ON academic_integrity(student_id);

CREATE TABLE IF NOT EXISTS student_reports (
  report_id TEXT PRIMARY KEY,
  reported_student_id TEXT REFERENCES students(student_id),
  reporter_type TEXT,
  submitted_date DATE,
  category TEXT,
  location TEXT,
  priority TEXT,
  description TEXT,
  anonymous BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_student_reports_student ON student_reports(reported_student_id);
