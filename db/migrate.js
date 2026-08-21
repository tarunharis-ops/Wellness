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

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('Schema OK.');

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

  for (const group of cfg.OPTION_GROUPS) {
    const existing = await db.query(
      'SELECT COUNT(*)::int AS n FROM template_options WHERE template_id = $1 AND group_key = $2',
      [defaultTemplateId, group.key]
    );
    if (existing.rows[0].n > 0) continue;
    for (let i = 0; i < group.defaults.length; i++) {
      await db.query(
        'INSERT INTO template_options (id, template_id, group_key, value, sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [uuid(), defaultTemplateId, group.key, group.defaults[i], i]
      );
    }
    console.log('Seeded ' + group.defaults.length + ' default options for "' + group.key + '".');
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
