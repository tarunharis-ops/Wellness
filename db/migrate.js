// Idempotent migration/bootstrap script. Safe to run on every deploy boot:
// creates tables if missing, seeds default dropdown options if a group is
// empty, and (once, if the legacy data/db.json file exists) imports old
// local entries into Postgres.
//
// Usage: node db/migrate.js

'use strict';

const fs = require('fs');
const path = require('path');
require('../lib/env');
const db = require('./pool');
const cfg = require('../lib/config');
const { uuid } = require('../lib/id');
const { parseCSV } = require('../lib/csv');

// Upgrade path: `entries` used to have one fixed column per Wellness field
// (case_status, nabita_risk, concern_primary, ...) instead of the dynamic
// `fields` JSONB blob. Backfills any pre-existing rows' `fields` from those
// columns, then drops them. Guarded by an information_schema check so this
// is a no-op on a fresh database (schema.sql never creates those columns)
// or once already migrated.
async function migrateLegacyEntryColumns() {
  const camelToSnake = function (s) { return s.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); }); };
  const legacyColumns = cfg.FIELDS
    .filter(function (f) { return f.key !== 'firstName' && f.key !== 'lastName'; })
    .map(function (f) { return { column: camelToSnake(f.key), key: f.key }; });

  const existing = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'entries'");
  const existingNames = new Set(existing.rows.map(function (r) { return r.column_name; }));
  const toMigrate = legacyColumns.filter(function (c) { return existingNames.has(c.column); });
  if (!toMigrate.length) return;

  const pairs = toMigrate.map(function (c) { return "'" + c.key + "', " + c.column; }).join(', ');
  await db.query("UPDATE entries SET fields = fields || jsonb_strip_nulls(jsonb_build_object(" + pairs + ")) WHERE fields = '{}'::jsonb");
  for (const c of toMigrate) {
    await db.query('ALTER TABLE entries DROP COLUMN IF EXISTS ' + c.column);
  }
  console.log('Backfilled and dropped ' + toMigrate.length + ' legacy fixed columns from entries.');
}

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('Schema OK.');

  await migrateLegacyEntryColumns();

  // Ensure exactly one Default template exists — every new template clones
  // its active options from this one.
  let defaultTemplate = (await db.query('SELECT * FROM templates WHERE is_default = true LIMIT 1')).rows[0];
  if (!defaultTemplate) {
    const id = uuid();
    await db.query('INSERT INTO templates (id, name, is_default) VALUES ($1,$2,true)', [id, 'Default']);
    defaultTemplate = { id: id };
    console.log('Created Default template.');
  }
  const defaultTemplateId = defaultTemplate.id;

  // Upgrade path: template_options predates the templates table — backfill
  // any rows still missing template_id, then swap its unique constraint from
  // (group_key, value) to (template_id, group_key, value) now that more than
  // one template's options can share a group_key/value pair.
  await db.query('UPDATE template_options SET template_id = $1 WHERE template_id IS NULL', [defaultTemplateId]);
  await db.query('UPDATE entries SET template_id = $1 WHERE template_id IS NULL', [defaultTemplateId]);

  const staleConstraints = await db.query(
    "SELECT tc.constraint_name FROM information_schema.table_constraints tc " +
    "WHERE tc.table_name = 'template_options' AND tc.constraint_type = 'UNIQUE' " +
    "AND tc.constraint_name != 'template_options_template_group_value_key'"
  );
  for (const row of staleConstraints.rows) {
    const name = row.constraint_name.replace(/[^a-zA-Z0-9_]/g, '');
    await db.query('ALTER TABLE template_options DROP CONSTRAINT "' + name + '"');
    console.log('Dropped stale constraint ' + name + ' on template_options.');
  }
  await db.query(
    'ALTER TABLE template_options ADD CONSTRAINT template_options_template_group_value_key UNIQUE (template_id, group_key, value)'
  ).catch(function (err) { if (!/already exists/.test(err.message)) throw err; });
  await db.query('ALTER TABLE template_options ALTER COLUMN template_id SET NOT NULL');

  // Seed the Default template's field schema + option lists, one time, from
  // the pre-dynamic-schema Wellness field list (lib/config.js) — this
  // preserves the exact current form/dropdowns as day-one seed data so nothing
  // changes for existing users; from here on, template_fields/template_options
  // are the only source of truth (lib/config.js's FIELDS/OPTION_GROUPS are not
  // read anywhere else). First/Last Name are real `entries` columns (see
  // migrateLegacyEntryColumns above), not part of the dynamic field list.
  const existingFieldCount = await db.query('SELECT COUNT(*)::int AS n FROM template_fields WHERE template_id = $1', [defaultTemplateId]);
  if (existingFieldCount.rows[0].n === 0) {
    // template_fields.section is a free-text display label (not a lookup
    // key) — the dynamic system has no fixed section list going forward, so
    // this seed maps the old short section keys to their original labels once.
    const sectionLabels = {};
    cfg.SECTIONS.forEach(function (s) { sectionLabels[s.key] = s.label; });
    const dynamicFields = cfg.FIELDS.filter(function (f) { return f.key !== 'firstName' && f.key !== 'lastName'; });
    for (let i = 0; i < dynamicFields.length; i++) {
      const f = dynamicFields[i];
      await db.query(
        'INSERT INTO template_fields (id, template_id, field_key, label, field_type, section, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
        [uuid(), defaultTemplateId, f.key, f.label, f.type, sectionLabels[f.section] || f.section || null, i]
      );
      if (f.type === 'select') {
        const group = cfg.OPTION_GROUPS.find(function (g) { return g.key === f.optionGroup; });
        const defaults = group ? group.defaults : [];
        for (let j = 0; j < defaults.length; j++) {
          await db.query(
            'INSERT INTO template_options (id, template_id, group_key, value, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
            [uuid(), defaultTemplateId, f.key, defaults[j], j]
          );
        }
      }
    }
    console.log('Seeded ' + dynamicFields.length + ' fields on the Default template.');
  }

  await importStudentRecords();

  const legacyPath = path.join(__dirname, '..', 'data', 'db.json');
  if (fs.existsSync(legacyPath)) {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    const entries = legacy.entries || [];
    if (entries.length) {
      const already = await db.query('SELECT COUNT(*)::int AS n FROM entries');
      if (already.rows[0].n === 0) {
        const repo = require('./repo');
        const users = await repo.listUsers();
        const attributeTo = (users.find(function (u) { return u.role === 'admin'; }) || users[0] || {}).id || null;
        for (const e of entries) {
          const fields = {};
          cfg.FIELDS.forEach(function (f) { fields[f.key] = e[f.key] || ''; });
          await repo.createEntry(fields, attributeTo);
        }
        console.log('Imported ' + entries.length + ' legacy entries from data/db.json.');
      } else {
        console.log('Entries table already has data — skipped legacy import.');
      }
    }
  }

  console.log('Migration complete.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Student Records seed import — one-time, idempotent (skipped if the
// students table already has rows). Loads the five CSVs in
// data/student_records/ into their matching tables, batching inserts since
// students.csv alone is ~10,000 rows. Order matters: students first (every
// other table has a foreign key into it).
// ---------------------------------------------------------------------------

function emptyToNull(v) { return v === undefined || v === '' ? null : v; }

function loadCSV(filename) {
  const filePath = path.join(__dirname, '..', 'data', 'student_records', filename);
  if (!fs.existsSync(filePath)) return null;
  return parseCSV(fs.readFileSync(filePath, 'utf8'));
}

const IMPORT_BATCH_SIZE = 500;

async function bulkInsert(table, columns, rows, mapRow) {
  for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
    const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
    const values = [];
    const placeholders = batch.map(function (row, rowIdx) {
      const mapped = mapRow(row);
      values.push.apply(values, mapped);
      const base = rowIdx * columns.length;
      return '(' + mapped.map(function (_, ci) { return '$' + (base + ci + 1); }).join(',') + ')';
    });
    await db.query('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES ' + placeholders.join(',') + ' ON CONFLICT DO NOTHING', values);
  }
}

async function importStudentRecords() {
  const already = await db.query('SELECT COUNT(*)::int AS n FROM students');
  if (already.rows[0].n > 0) { console.log('Student Records already seeded — skipped.'); return; }

  const students = loadCSV('students.csv');
  if (!students) { console.log('No data/student_records/students.csv found — skipping Student Records seed.'); return; }

  await bulkInsert(
    'students',
    ['student_id', 'first_name', 'last_name', 'email', 'dob', 'major', 'academic_year', 'enrollment_status', 'advisor', 'phone', 'address', 'enrollment_date'],
    students,
    function (r) { return [r.student_id, r.first_name, r.last_name, r.email, emptyToNull(r.dob), r.major, r.academic_year, r.enrollment_status, r.advisor, r.phone, r.address, emptyToNull(r.enrollment_date)]; }
  );
  console.log('Imported ' + students.length + ' students.');

  const housing = loadCSV('housing.csv') || [];
  await bulkInsert(
    'housing',
    ['housing_id', 'student_id', 'residence_hall', 'room_number', 'move_in_date', 'move_out_date', 'housing_status'],
    housing,
    function (r) { return [r.housing_id, r.student_id, r.residence_hall, r.room_number, emptyToNull(r.move_in_date), emptyToNull(r.move_out_date), r.housing_status]; }
  );
  console.log('Imported ' + housing.length + ' housing records.');

  const campusSafety = loadCSV('campus_safety.csv') || [];
  await bulkInsert(
    'campus_safety',
    ['report_id', 'student_id', 'incident_date', 'location', 'incident_type', 'severity', 'status', 'narrative'],
    campusSafety,
    function (r) { return [r.report_id, r.student_id, emptyToNull(r.incident_date), r.location, r.incident_type, r.severity, r.status, r.narrative]; }
  );
  console.log('Imported ' + campusSafety.length + ' campus safety reports.');

  const academicIntegrity = loadCSV('academic_integrity.csv') || [];
  await bulkInsert(
    'academic_integrity',
    ['case_id', 'student_id', 'course_code', 'course_name', 'faculty_name', 'incident_date', 'violation_type', 'severity', 'status', 'description'],
    academicIntegrity,
    function (r) { return [r.case_id, r.student_id, r.course_code, r.course_name, r.faculty_name, emptyToNull(r.incident_date), r.violation_type, r.severity, r.status, r.description]; }
  );
  console.log('Imported ' + academicIntegrity.length + ' academic integrity cases.');

  const reports = loadCSV('reports.csv') || [];
  await bulkInsert(
    'student_reports',
    ['report_id', 'reported_student_id', 'reporter_type', 'submitted_date', 'category', 'location', 'priority', 'description', 'anonymous'],
    reports,
    function (r) { return [r.report_id, emptyToNull(r.reported_student_id), r.reporter_type, emptyToNull(r.submitted_date), r.category, r.location, r.priority, r.description, r.anonymous === 'True']; }
  );
  console.log('Imported ' + reports.length + ' web/anonymous reports.');
}

run().catch(function (err) {
  console.error('Migration failed:', err);
  process.exit(1);
});
