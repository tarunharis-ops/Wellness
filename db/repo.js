// Postgres-backed repository: users, sessions, invites, entries, template
// options. Replaces the old JSON-file store now that data must persist
// centrally for multiple concurrent users.

'use strict';

const db = require('./pool');
const { uuid } = require('../lib/id');
const cfg = require('../lib/config');

function camelToSnake(s) {
  return s.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); });
}
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); });
}

const ENTRY_KEYS = cfg.FIELDS.map(function (f) { return f.key; });
const DATE_KEYS = { referralDate: true, outreachDate: true };

function rowToEntry(row) {
  if (!row) return null;
  const out = {};
  Object.keys(row).forEach(function (col) {
    var key = snakeToCamel(col);
    var val = row[col];
    if (val instanceof Date) {
      val = val.toISOString();
    }
    out[key] = val === null ? '' : val;
  });
  return out;
}

// ---------------- Users ----------------

function countUsers() {
  return db.query('SELECT COUNT(*)::int AS n FROM users').then(function (r) { return r.rows[0].n; });
}

function createUser(fields) {
  const id = uuid();
  return db.query(
    'INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1,$2,$3,$4,$5,true) RETURNING *',
    [id, fields.email.toLowerCase().trim(), fields.name.trim(), fields.passwordHash, fields.role || 'counselor']
  ).then(function (r) { return userRow(r.rows[0]); });
}

function getUserByEmail(email) {
  return db.query('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase().trim()])
    .then(function (r) { return r.rows[0] ? userRow(r.rows[0]) : null; });
}

function getUserById(id) {
  return db.query('SELECT * FROM users WHERE id = $1', [id]).then(function (r) { return r.rows[0] ? userRow(r.rows[0]) : null; });
}

function listUsers() {
  return db.query('SELECT * FROM users ORDER BY created_at ASC').then(function (r) { return r.rows.map(userRow); });
}

function setUserActive(id, isActive) {
  return db.query('UPDATE users SET is_active = $2 WHERE id = $1 RETURNING *', [id, isActive])
    .then(function (r) { return r.rows[0] ? userRow(r.rows[0]) : null; });
}

function setUserRole(id, role) {
  return db.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING *', [id, role])
    .then(function (r) { return r.rows[0] ? userRow(r.rows[0]) : null; });
}

function touchLogin(id) {
  return db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

function userRow(row) {
  return {
    id: row.id, email: row.email, name: row.name, role: row.role,
    isActive: row.is_active, passwordHash: row.password_hash,
    createdAt: row.created_at, lastLoginAt: row.last_login_at,
  };
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, isActive: u.isActive, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt };
}

// ---------------- Sessions ----------------
// expires_at is a fixed absolute ceiling set once at login (an account can be
// "come back any time" persistent without the session itself living forever).
// last_seen_at is the sliding NIST-style idle tracker — server.js compares it
// against now() on every request and kills the session past the idle limit,
// independent of expires_at.

function createSession(userId, token, expiresAt) {
  return db.query('INSERT INTO sessions (id, user_id, expires_at, last_seen_at) VALUES ($1,$2,$3,now())', [token, userId, expiresAt]);
}

function getSession(token) {
  return db.query(
    'SELECT s.*, u.id AS u_id, u.email AS u_email, u.name AS u_name, u.role AS u_role, u.is_active AS u_is_active ' +
    'FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()',
    [token]
  ).then(function (r) {
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      token: row.id,
      lastSeenAt: row.last_seen_at,
      user: { id: row.u_id, email: row.u_email, name: row.u_name, role: row.u_role, isActive: row.u_is_active },
    };
  });
}

function deleteSession(token) {
  return db.query('DELETE FROM sessions WHERE id = $1', [token]);
}

function touchSessionActivity(token) {
  return db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [token]);
}

// ---------------- Invites ----------------

function createInvite(fields) {
  const id = uuid();
  const token = fields.token;
  return db.query(
    'INSERT INTO invites (id, token, email, role, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [id, token, fields.email || null, fields.role || 'counselor', fields.createdBy, fields.expiresAt]
  ).then(function (r) { return inviteRow(r.rows[0]); });
}

function listInvites() {
  return db.query(
    'SELECT i.*, cu.name AS created_by_name, uu.name AS used_by_name FROM invites i ' +
    'LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users uu ON uu.id = i.used_by ' +
    'ORDER BY i.created_at DESC'
  ).then(function (r) { return r.rows.map(function (row) { return inviteRow(row, true); }); });
}

function getInviteByToken(token) {
  return db.query('SELECT * FROM invites WHERE token = $1', [token]).then(function (r) { return r.rows[0] ? inviteRow(r.rows[0]) : null; });
}

function markInviteUsed(id, userId) {
  return db.query('UPDATE invites SET used_at = now(), used_by = $2 WHERE id = $1', [id, userId]);
}

function deleteInvite(id) {
  return db.query('DELETE FROM invites WHERE id = $1', [id]);
}

function inviteRow(row, withNames) {
  const out = {
    id: row.id, token: row.token, email: row.email, role: row.role,
    createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at,
    usedAt: row.used_at, usedBy: row.used_by,
  };
  if (withNames) { out.createdByName = row.created_by_name; out.usedByName = row.used_by_name; }
  return out;
}

// ---------------- Semesters ----------------

function listSemesters() {
  return db.query(
    'SELECT s.*, COUNT(e.id)::int AS entry_count FROM semesters s ' +
    'LEFT JOIN entries e ON e.semester_id = s.id ' +
    'GROUP BY s.id ORDER BY s.starts_on ASC NULLS LAST, s.label ASC'
  ).then(function (r) { return r.rows.map(semesterRow); });
}

function createSemester(fields, userId) {
  const id = uuid();
  return db.query(
    'INSERT INTO semesters (id, label, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4,$5) ' +
    'ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label RETURNING *',
    [id, fields.label.trim(), fields.startsOn || null, fields.endsOn || null, userId]
  ).then(function (r) { return semesterRow(Object.assign({ entry_count: 0 }, r.rows[0])); });
}

function findOrCreateSemester(fields, userId) {
  return createSemester(fields, userId);
}

function semesterRow(row) {
  return {
    id: row.id, label: row.label, startsOn: row.starts_on, endsOn: row.ends_on,
    createdBy: row.created_by, createdAt: row.created_at, entryCount: row.entry_count || 0,
  };
}

// ---------------- Entries ----------------

function studentKeyFor(firstName, lastName) {
  return (String(firstName || '').trim() + '|' + String(lastName || '').trim()).toLowerCase();
}

function listEntries() {
  return db.query(
    'SELECT e.*, COALESCE(cu.name, e.created_by_name_override) AS created_by_name, uu.name AS updated_by_name, ' +
    'sem.label AS semester_label ' +
    'FROM entries e ' +
    'LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users uu ON uu.id = e.updated_by ' +
    'LEFT JOIN semesters sem ON sem.id = e.semester_id ' +
    'ORDER BY e.created_at DESC'
  ).then(function (r) {
    return r.rows.map(function (row) {
      const entry = rowToEntry(row);
      entry.createdByName = row.created_by_name || '';
      entry.updatedByName = row.updated_by_name || '';
      entry.semesterLabel = row.semester_label || '';
      return entry;
    });
  });
}

function getEntry(id) {
  return db.query('SELECT * FROM entries WHERE id = $1', [id]).then(function (r) { return r.rows[0] ? rowToEntry(r.rows[0]) : null; });
}

function buildEntryColumns(fields) {
  const cols = [], values = [];
  ENTRY_KEYS.forEach(function (key) {
    const col = camelToSnake(key);
    var val = fields[key];
    if (val === '' && DATE_KEYS[key]) val = null;
    if (val === '' && key === 'durationMinutes') val = null;
    cols.push(col);
    values.push(val === undefined ? null : val);
  });
  return { cols: cols, values: values };
}

function createEntry(fields, userId, opts) {
  opts = opts || {};
  const id = uuid();
  const built = buildEntryColumns(fields);
  const cols = ['id', 'student_key', 'semester_id', 'template_id', 'created_by_name_override'].concat(built.cols).concat(['created_by', 'updated_by']);
  const values = [id, studentKeyFor(fields.firstName, fields.lastName), opts.semesterId || null, opts.templateId || null, opts.createdByNameOverride || null]
    .concat(built.values).concat([userId, userId]);
  const placeholders = values.map(function (_, i) { return '$' + (i + 1); });
  const sql = 'INSERT INTO entries (' + cols.join(',') + ') VALUES (' + placeholders.join(',') + ') RETURNING *';
  return db.query(sql, values).then(function (r) { return rowToEntry(r.rows[0]); });
}

function updateEntry(id, fields, userId, opts) {
  opts = opts || {};
  const built = buildEntryColumns(fields);
  const setClauses = built.cols.map(function (col, i) { return col + ' = $' + (i + 5); });
  setClauses.push('student_key = $2');
  setClauses.push('semester_id = $3');
  setClauses.push('template_id = $4');
  setClauses.push('updated_by = $' + (built.cols.length + 5));
  setClauses.push('updated_at = now()');
  const values = [id, studentKeyFor(fields.firstName, fields.lastName), opts.semesterId || null, opts.templateId || null]
    .concat(built.values).concat([userId]);
  const sql = 'UPDATE entries SET ' + setClauses.join(', ') + ' WHERE id = $1 RETURNING *';
  return db.query(sql, values).then(function (r) { return r.rows[0] ? rowToEntry(r.rows[0]) : null; });
}

function deleteEntry(id) {
  return db.query('DELETE FROM entries WHERE id = $1', [id]).then(function (r) { return r.rowCount > 0; });
}

// ---- Bulk purge (Danger Zone) ----
// scope: { type: 'all' } | { type: 'semester', semesterId } | { type: 'counselor', counselorName }
// Matches counselor the same way filterEntries() does elsewhere: by the
// linked user account id/name, or by the free-text created_by_name_override
// for imported/unlinked entries.
function purgeWhereClause(scope) {
  if (scope.type === 'semester') return { clause: 'semester_id = $1', values: [scope.semesterId] };
  if (scope.type === 'counselor') {
    return {
      clause: '(created_by IN (SELECT id FROM users WHERE lower(name) = lower($1)) OR lower(created_by_name_override) = lower($1))',
      values: [scope.counselorName],
    };
  }
  return { clause: 'true', values: [] };
}

function countEntriesForScope(scope) {
  const w = purgeWhereClause(scope);
  return db.query('SELECT COUNT(*)::int AS n FROM entries WHERE ' + w.clause, w.values).then(function (r) { return r.rows[0].n; });
}

function purgeEntries(scope) {
  const w = purgeWhereClause(scope);
  return db.query('DELETE FROM entries WHERE ' + w.clause, w.values).then(function (r) { return r.rowCount; });
}

// Bulk-inserts pre-parsed import rows inside one transaction, batching many
// rows per INSERT (imports can be thousands of rows — one round trip per row
// would be far too slow). Each item:
// { fields: {...cfg.FIELDS keys}, semesterId, templateId, createdByNameOverride, createdBy }
const IMPORT_BATCH_SIZE = 200;
const FIXED_COLS = ['id', 'student_key', 'semester_id', 'template_id', 'created_by_name_override'];
const ENTRY_COLS = FIXED_COLS.concat(ENTRY_KEYS.map(camelToSnake)).concat(['created_by', 'updated_by']);

function entryRowValues(item) {
  const built = buildEntryColumns(item.fields);
  return [uuid(), studentKeyFor(item.fields.firstName, item.fields.lastName), item.semesterId || null, item.templateId || null, item.createdByNameOverride || null]
    .concat(built.values).concat([item.createdBy || null, item.createdBy || null]);
}

function insertBatch(client, batch) {
  const perRow = ENTRY_COLS.length;
  const values = [];
  const rowPlaceholders = batch.map(function (item, rowIdx) {
    const rowValues = entryRowValues(item);
    values.push.apply(values, rowValues);
    const base = rowIdx * perRow;
    const placeholders = rowValues.map(function (_, i) { return '$' + (base + i + 1); });
    return '(' + placeholders.join(',') + ')';
  });
  const sql = 'INSERT INTO entries (' + ENTRY_COLS.join(',') + ') VALUES ' + rowPlaceholders.join(',');
  return client.query(sql, values);
}

function bulkCreateEntries(items) {
  if (!items.length) return Promise.resolve({ inserted: 0 });
  const pool = db.getPool();
  return pool.connect().then(function (client) {
    return client.query('BEGIN')
      .then(function () {
        var chain = Promise.resolve();
        for (var i = 0; i < items.length; i += IMPORT_BATCH_SIZE) {
          const batch = items.slice(i, i + IMPORT_BATCH_SIZE);
          chain = chain.then(function () { return insertBatch(client, batch); });
        }
        return chain;
      })
      .then(function () { return client.query('COMMIT'); })
      .then(function () { client.release(); return { inserted: items.length }; })
      .catch(function (err) {
        return client.query('ROLLBACK').then(function () { client.release(); throw err; }, function () { client.release(); throw err; });
      });
  });
}

// ---------------- Templates ----------------

function templateRow(row) {
  return { id: row.id, name: row.name, isDefault: row.is_default, createdBy: row.created_by, createdAt: row.created_at };
}

function listTemplates() {
  return db.query('SELECT * FROM templates ORDER BY is_default DESC, name ASC').then(function (r) { return r.rows.map(templateRow); });
}

function getTemplate(id) {
  return db.query('SELECT * FROM templates WHERE id = $1', [id]).then(function (r) { return r.rows[0] ? templateRow(r.rows[0]) : null; });
}

function getDefaultTemplate() {
  return db.query('SELECT * FROM templates WHERE is_default = true LIMIT 1').then(function (r) { return r.rows[0] ? templateRow(r.rows[0]) : null; });
}

// Creates a new named template pre-populated with a copy of the Default
// template's currently-active options — the "start from the default, then
// customize" flow.
function createTemplate(name, userId) {
  const id = uuid();
  return db.query(
    'INSERT INTO templates (id, name, created_by) VALUES ($1,$2,$3) RETURNING *',
    [id, name.trim(), userId]
  ).then(function (r) {
    return getDefaultTemplate().then(function (def) {
      if (!def) return r.rows[0];
      return db.query(
        'INSERT INTO template_options (id, template_id, group_key, value, sort_order, created_by) ' +
        'SELECT gen_random_uuid()::text, $1, group_key, value, sort_order, $2 FROM template_options ' +
        'WHERE template_id = $3 AND active = true',
        [id, userId, def.id]
      ).catch(function () {
        // gen_random_uuid() needs pgcrypto; fall back to per-row inserts with our own id generator if it's unavailable.
        return listTemplateOptions(def.id).then(function (byGroup) {
          const rowsToInsert = [];
          Object.keys(byGroup).forEach(function (g) {
            byGroup[g].forEach(function (o) { if (o.active) rowsToInsert.push({ groupKey: g, value: o.value, sortOrder: o.sortOrder }); });
          });
          var chain = Promise.resolve();
          rowsToInsert.forEach(function (o) {
            chain = chain.then(function () {
              return db.query(
                'INSERT INTO template_options (id, template_id, group_key, value, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
                [uuid(), id, o.groupKey, o.value, o.sortOrder, userId]
              );
            });
          });
          return chain;
        });
      });
    }).then(function () { return r.rows[0]; });
  }).then(function (row) { return templateRow(row); });
}

// ---------------- Template options ----------------

function listTemplateOptions(templateId) {
  return db.query('SELECT * FROM template_options WHERE template_id = $1 ORDER BY group_key, sort_order, value', [templateId]).then(function (r) {
    const byGroup = {};
    r.rows.forEach(function (row) {
      if (!byGroup[row.group_key]) byGroup[row.group_key] = [];
      byGroup[row.group_key].push({ id: row.id, value: row.value, active: row.active, sortOrder: row.sort_order });
    });
    return byGroup;
  });
}

function addTemplateOption(templateId, groupKey, value, userId) {
  const id = uuid();
  return db.query(
    'INSERT INTO template_options (id, template_id, group_key, value, created_by) VALUES ($1,$2,$3,$4,$5) ' +
    'ON CONFLICT (template_id, group_key, value) DO UPDATE SET active = true RETURNING *',
    [id, templateId, groupKey, value.trim(), userId]
  ).then(function (r) { return r.rows[0]; });
}

function setTemplateOptionActive(templateId, id, active) {
  return db.query('UPDATE template_options SET active = $3 WHERE id = $1 AND template_id = $2 RETURNING *', [id, templateId, active])
    .then(function (r) { return r.rows[0]; });
}

// ---------------- Audit log ----------------
// Fire-and-forget from server.js — callers don't await this, so a logging
// hiccup never blocks or fails the user-facing action it's recording.

function auditRow(row) {
  return {
    id: row.id, actorId: row.actor_id, actorName: row.actor_name, actionType: row.action_type,
    targetRecordId: row.target_record_id, ipAddress: row.ip_address, userAgent: row.user_agent,
    metadata: row.metadata, createdAt: row.created_at,
  };
}

function createAuditLog(entry) {
  const id = uuid();
  return db.query(
    'INSERT INTO audit_log (id, actor_id, actor_name, action_type, target_record_id, ip_address, user_agent, metadata) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, entry.actorId || null, entry.actorName || null, entry.actionType, entry.targetRecordId || null,
      entry.ipAddress || null, entry.userAgent || null, entry.metadata ? JSON.stringify(entry.metadata) : null]
  );
}

function listAuditLog(filters, limit) {
  filters = filters || {};
  const clauses = [];
  const values = [];
  if (filters.actorId) { values.push(filters.actorId); clauses.push('actor_id = $' + values.length); }
  if (filters.actionType) { values.push(filters.actionType); clauses.push('action_type = $' + values.length); }
  if (filters.targetRecordId) { values.push(filters.targetRecordId); clauses.push('target_record_id = $' + values.length); }
  values.push(limit || 200);
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  return db.query(
    'SELECT * FROM audit_log ' + where + ' ORDER BY created_at DESC LIMIT $' + values.length,
    values
  ).then(function (r) { return r.rows.map(auditRow); });
}

// ---------------- Student Records (read-only reference dataset) ----------------
// Backs the "Student Records" tab: a synthetic SIS roster joined against
// Housing, Campus Safety, Academic Integrity, and the Web/Anonymous
// Reporting Portal. Seeded once by db/migrate.js from data/student_records/.
// This dataset is intentionally separate from — and unrelated to — the
// Wellness case entries above.

function studentRecordRow(row) {
  return {
    studentId: row.student_id, firstName: row.first_name, lastName: row.last_name, email: row.email,
    dob: row.dob, major: row.major, academicYear: row.academic_year, enrollmentStatus: row.enrollment_status,
    advisor: row.advisor, phone: row.phone, address: row.address, enrollmentDate: row.enrollment_date,
  };
}
function housingRecordRow(row) {
  return {
    housingId: row.housing_id, studentId: row.student_id, residenceHall: row.residence_hall, roomNumber: row.room_number,
    moveInDate: row.move_in_date, moveOutDate: row.move_out_date, housingStatus: row.housing_status,
  };
}
function campusSafetyRow(row) {
  return {
    reportId: row.report_id, studentId: row.student_id, incidentDate: row.incident_date, location: row.location,
    incidentType: row.incident_type, severity: row.severity, status: row.status, narrative: row.narrative,
  };
}
function academicIntegrityRow(row) {
  return {
    caseId: row.case_id, studentId: row.student_id, courseCode: row.course_code, courseName: row.course_name,
    facultyName: row.faculty_name, incidentDate: row.incident_date, violationType: row.violation_type,
    severity: row.severity, status: row.status, description: row.description,
  };
}
function studentReportRow(row) {
  return {
    reportId: row.report_id, reportedStudentId: row.reported_student_id, reporterType: row.reporter_type,
    submittedDate: row.submitted_date, category: row.category, location: row.location, priority: row.priority,
    description: row.description, anonymous: row.anonymous,
  };
}

// Simple substring search over student_id / first / last / "first last" —
// fine at this table's size (~10k rows); caller enforces a minimum query
// length so this never runs as an unbounded full-table scan from an empty box.
function searchStudentRecords(q, limit) {
  const needle = '%' + String(q || '').trim() + '%';
  return db.query(
    'SELECT student_id, first_name, last_name, major, academic_year, enrollment_status FROM students ' +
    "WHERE student_id ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1 OR (first_name || ' ' || last_name) ILIKE $1 " +
    'ORDER BY last_name, first_name LIMIT $2',
    [needle, limit || 50]
  ).then(function (r) { return r.rows.map(studentRecordRow); });
}

function getStudentRecordProfile(studentId) {
  return db.query('SELECT * FROM students WHERE student_id = $1', [studentId]).then(function (r) {
    if (!r.rows[0]) return null;
    const student = studentRecordRow(r.rows[0]);
    return Promise.all([
      db.query('SELECT * FROM housing WHERE student_id = $1 ORDER BY move_in_date DESC NULLS LAST', [studentId]),
      db.query('SELECT * FROM campus_safety WHERE student_id = $1 ORDER BY incident_date DESC NULLS LAST', [studentId]),
      db.query('SELECT * FROM academic_integrity WHERE student_id = $1 ORDER BY incident_date DESC NULLS LAST', [studentId]),
      db.query('SELECT * FROM student_reports WHERE reported_student_id = $1 ORDER BY submitted_date DESC NULLS LAST', [studentId]),
    ]).then(function (r2) {
      return {
        student: student,
        housing: r2[0].rows.map(housingRecordRow),
        campusSafety: r2[1].rows.map(campusSafetyRow),
        academicIntegrity: r2[2].rows.map(academicIntegrityRow),
        reports: r2[3].rows.map(studentReportRow),
      };
    });
  });
}

module.exports = {
  countUsers, createUser, getUserByEmail, getUserById, listUsers, setUserActive, setUserRole, touchLogin, publicUser,
  createSession, getSession, deleteSession, touchSessionActivity,
  createInvite, listInvites, getInviteByToken, markInviteUsed, deleteInvite,
  listSemesters, createSemester, findOrCreateSemester,
  listEntries, getEntry, createEntry, updateEntry, deleteEntry, bulkCreateEntries, studentKeyFor,
  countEntriesForScope, purgeEntries,
  listTemplates, getTemplate, getDefaultTemplate, createTemplate,
  listTemplateOptions, addTemplateOption, setTemplateOptionActive,
  createAuditLog, listAuditLog,
  searchStudentRecords, getStudentRecordProfile,
};
