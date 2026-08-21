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

function getSemester(id) {
  return db.query('SELECT * FROM semesters WHERE id = $1', [id]).then(function (r) { return r.rows[0] ? semesterRow(Object.assign({ entry_count: 0 }, r.rows[0])) : null; });
}

function deleteSemester(id) {
  return db.query('DELETE FROM semesters WHERE id = $1', [id]).then(function (r) { return r.rowCount > 0; });
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

// Resolves a Wellness entry's free-text studentIdExternal against the
// canonical Student Records roster, so the entry can carry a real FK
// (entries.student_id) instead of relying purely on name-matching. A single
// indexed lookup is fine here — createEntry/updateEntry are per-request,
// single-record calls, not the bulk-import path (see bulkCreateEntries,
// which batches this instead).
function resolveStudentId(externalId) {
  const trimmed = String(externalId || '').trim();
  if (!trimmed) return Promise.resolve(null);
  return db.query('SELECT student_id FROM students WHERE student_id = $1', [trimmed])
    .then(function (r) { return r.rows[0] ? r.rows[0].student_id : null; });
}

function createEntry(fields, userId, opts) {
  opts = opts || {};
  return resolveStudentId(fields.studentIdExternal).then(function (studentId) {
    const id = uuid();
    const built = buildEntryColumns(fields);
    const cols = ['id', 'student_key', 'student_id', 'semester_id', 'template_id', 'created_by_name_override'].concat(built.cols).concat(['created_by', 'updated_by']);
    const values = [id, studentKeyFor(fields.firstName, fields.lastName), studentId, opts.semesterId || null, opts.templateId || null, opts.createdByNameOverride || null]
      .concat(built.values).concat([userId, userId]);
    const placeholders = values.map(function (_, i) { return '$' + (i + 1); });
    const sql = 'INSERT INTO entries (' + cols.join(',') + ') VALUES (' + placeholders.join(',') + ') RETURNING *';
    return db.query(sql, values).then(function (r) { return rowToEntry(r.rows[0]); });
  });
}

function updateEntry(id, fields, userId, opts) {
  opts = opts || {};
  return resolveStudentId(fields.studentIdExternal).then(function (studentId) {
    const built = buildEntryColumns(fields);
    const setClauses = built.cols.map(function (col, i) { return col + ' = $' + (i + 6); });
    setClauses.push('student_key = $2');
    setClauses.push('student_id = $3');
    setClauses.push('semester_id = $4');
    setClauses.push('template_id = $5');
    setClauses.push('updated_by = $' + (built.cols.length + 6));
    setClauses.push('updated_at = now()');
    const values = [id, studentKeyFor(fields.firstName, fields.lastName), studentId, opts.semesterId || null, opts.templateId || null]
      .concat(built.values).concat([userId]);
    const sql = 'UPDATE entries SET ' + setClauses.join(', ') + ' WHERE id = $1 RETURNING *';
    return db.query(sql, values).then(function (r) { return r.rows[0] ? rowToEntry(r.rows[0]) : null; });
  });
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
// { fields: {...cfg.FIELDS keys}, semesterId, templateId, createdByNameOverride, createdBy, resolvedStudentId }
// resolvedStudentId is stamped on by bulkCreateEntries below (one batched
// lookup for the whole import, not a per-row query).
const IMPORT_BATCH_SIZE = 200;
const FIXED_COLS = ['id', 'student_key', 'student_id', 'semester_id', 'template_id', 'created_by_name_override'];
const ENTRY_COLS = FIXED_COLS.concat(ENTRY_KEYS.map(camelToSnake)).concat(['created_by', 'updated_by']);

function entryRowValues(item) {
  const built = buildEntryColumns(item.fields);
  return [uuid(), studentKeyFor(item.fields.firstName, item.fields.lastName), item.resolvedStudentId || null, item.semesterId || null, item.templateId || null, item.createdByNameOverride || null]
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
  const externalIds = Array.from(new Set(
    items.map(function (item) { return String((item.fields || {}).studentIdExternal || '').trim(); }).filter(Boolean)
  ));
  const lookup = externalIds.length
    ? db.query('SELECT student_id FROM students WHERE student_id = ANY($1)', [externalIds])
        .then(function (r) { const s = {}; r.rows.forEach(function (row) { s[row.student_id] = true; }); return s; })
    : Promise.resolve({});
  return lookup.then(function (validIds) {
    items.forEach(function (item) {
      const ext = String((item.fields || {}).studentIdExternal || '').trim();
      item.resolvedStudentId = ext && validIds[ext] ? ext : null;
    });
    return insertAllBatches(items);
  });
}

function insertAllBatches(items) {
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

function countEntriesForTemplate(templateId) {
  return db.query('SELECT COUNT(*)::int AS n FROM entries WHERE template_id = $1', [templateId]).then(function (r) { return r.rows[0].n; });
}

// Templates aren't deletable while any entry still references them — the
// caller (server.js) checks countEntriesForTemplate first and returns a
// clear error rather than letting this hit the FK constraint.
function deleteTemplate(id) {
  return db.query('DELETE FROM template_options WHERE template_id = $1', [id])
    .then(function () { return db.query('DELETE FROM templates WHERE id = $1', [id]); })
    .then(function (r) { return r.rowCount > 0; });
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
// Wellness case entries link into this roster via entries.student_id (see
// STUDENT_PROFILE_DOMAINS/getStudentRecordProfile below), so a student's
// cross-domain profile includes Wellness activity alongside these sources.

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

// Search over student_id / name / email / phone, plus optional exact-match
// filters (academic year, advisor). An empty query is "browse mode" — the
// caller still gets a bounded, alphabetically sorted page rather than the
// whole ~10k table, so the list view can render something scrollable
// immediately without ever shipping an unbounded dump.
function studentSearchWhere(params, needleCols) {
  const clauses = [];
  const values = [];
  const trimmed = String(params.q || '').trim();
  if (trimmed) {
    values.push('%' + trimmed + '%');
    const i = values.length;
    clauses.push('(' + needleCols.map(function (c) { return c + ' ILIKE $' + i; }).join(' OR ') + ')');
  }
  if (params.academicYear) { values.push(params.academicYear); clauses.push('academic_year = $' + values.length); }
  if (params.advisor) { values.push(params.advisor); clauses.push('advisor = $' + values.length); }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values: values };
}

function searchStudentRecords(params) {
  params = params || {};
  const limit = params.limit || 200;
  const built = studentSearchWhere(params, ["student_id", "first_name", "last_name", "(first_name || ' ' || last_name)", "email", "phone"]);
  const values = built.values.concat([limit]);
  return db.query(
    'SELECT student_id, first_name, last_name, major, academic_year, enrollment_status FROM students ' + built.where +
    ' ORDER BY last_name, first_name LIMIT $' + values.length,
    values
  ).then(function (r) { return r.rows.map(studentRecordRow); });
}

// Distinct academic years / advisors on file, for populating filter controls
// without the frontend hardcoding an assumed value list.
function getStudentRecordFacets() {
  return Promise.all([
    db.query('SELECT DISTINCT academic_year FROM students WHERE academic_year IS NOT NULL AND academic_year != \'\' ORDER BY academic_year'),
    db.query('SELECT DISTINCT advisor FROM students WHERE advisor IS NOT NULL AND advisor != \'\' ORDER BY advisor'),
  ]).then(function (r) {
    return {
      academicYears: r[0].rows.map(function (row) { return row.academic_year; }),
      advisors: r[1].rows.map(function (row) { return row.advisor; }),
    };
  });
}

// ---- Per-source-system browse lists (Housing / Campus Safety / Academic
// Integrity / Web Reports) — same browse-or-search shape as students above,
// each joined to students for a display name. Used by the dedicated per-
// source nav tabs, distinct from the cross-source Student Records search.

function sourceHousingRow(row) {
  return {
    housingId: row.housing_id, studentId: row.student_id, studentName: row.first_name + ' ' + row.last_name,
    residenceHall: row.residence_hall, roomNumber: row.room_number,
    moveInDate: row.move_in_date, moveOutDate: row.move_out_date, housingStatus: row.housing_status,
  };
}
function searchHousingRecords(q, limit) {
  const trimmed = String(q || '').trim();
  const needle = '%' + trimmed + '%';
  const where = trimmed ? "WHERE h.student_id ILIKE $1 OR s.first_name ILIKE $1 OR s.last_name ILIKE $1 OR h.residence_hall ILIKE $1" : '';
  const params = trimmed ? [needle, limit] : [limit];
  return db.query(
    'SELECT h.*, s.first_name, s.last_name FROM housing h JOIN students s ON s.student_id = h.student_id ' + where +
    ' ORDER BY h.move_in_date DESC NULLS LAST LIMIT $' + (trimmed ? 2 : 1),
    params
  ).then(function (r) { return r.rows.map(sourceHousingRow); });
}

function sourceCampusSafetyRow(row) {
  return {
    reportId: row.report_id, studentId: row.student_id, studentName: row.first_name + ' ' + row.last_name,
    incidentDate: row.incident_date, location: row.location, incidentType: row.incident_type,
    severity: row.severity, status: row.status,
  };
}
function searchCampusSafetyRecords(q, limit) {
  const trimmed = String(q || '').trim();
  const needle = '%' + trimmed + '%';
  const where = trimmed ? "WHERE c.student_id ILIKE $1 OR s.first_name ILIKE $1 OR s.last_name ILIKE $1 OR c.incident_type ILIKE $1" : '';
  const params = trimmed ? [needle, limit] : [limit];
  return db.query(
    'SELECT c.*, s.first_name, s.last_name FROM campus_safety c JOIN students s ON s.student_id = c.student_id ' + where +
    ' ORDER BY c.incident_date DESC NULLS LAST LIMIT $' + (trimmed ? 2 : 1),
    params
  ).then(function (r) { return r.rows.map(sourceCampusSafetyRow); });
}

function sourceAcademicIntegrityRow(row) {
  return {
    caseId: row.case_id, studentId: row.student_id, studentName: row.first_name + ' ' + row.last_name,
    incidentDate: row.incident_date, courseCode: row.course_code, violationType: row.violation_type,
    severity: row.severity, status: row.status,
  };
}
function searchAcademicIntegrityRecords(q, limit) {
  const trimmed = String(q || '').trim();
  const needle = '%' + trimmed + '%';
  const where = trimmed ? "WHERE a.student_id ILIKE $1 OR s.first_name ILIKE $1 OR s.last_name ILIKE $1 OR a.violation_type ILIKE $1" : '';
  const params = trimmed ? [needle, limit] : [limit];
  return db.query(
    'SELECT a.*, s.first_name, s.last_name FROM academic_integrity a JOIN students s ON s.student_id = a.student_id ' + where +
    ' ORDER BY a.incident_date DESC NULLS LAST LIMIT $' + (trimmed ? 2 : 1),
    params
  ).then(function (r) { return r.rows.map(sourceAcademicIntegrityRow); });
}

function sourceWebReportRow(row) {
  return {
    reportId: row.report_id, studentId: row.reported_student_id,
    studentName: row.first_name ? (row.first_name + ' ' + row.last_name) : null,
    submittedDate: row.submitted_date, category: row.category, priority: row.priority, anonymous: row.anonymous,
  };
}
function searchWebReportRecords(q, limit) {
  const trimmed = String(q || '').trim();
  const needle = '%' + trimmed + '%';
  const where = trimmed ? "WHERE w.reported_student_id ILIKE $1 OR s.first_name ILIKE $1 OR s.last_name ILIKE $1 OR w.category ILIKE $1" : '';
  const params = trimmed ? [needle, limit] : [limit];
  return db.query(
    'SELECT w.*, s.first_name, s.last_name FROM student_reports w LEFT JOIN students s ON s.student_id = w.reported_student_id ' + where +
    ' ORDER BY w.submitted_date DESC NULLS LAST LIMIT $' + (trimmed ? 2 : 1),
    params
  ).then(function (r) { return r.rows.map(sourceWebReportRow); });
}

function sourceSisRow(row) {
  return {
    studentId: row.student_id, firstName: row.first_name, lastName: row.last_name, email: row.email,
    major: row.major, academicYear: row.academic_year, enrollmentStatus: row.enrollment_status,
  };
}
function searchSisRecords(params) {
  params = params || {};
  const limit = params.limit || 200;
  const built = studentSearchWhere(params, ["student_id", "first_name", "last_name", "(first_name || ' ' || last_name)", "email", "phone"]);
  const values = built.values.concat([limit]);
  return db.query(
    'SELECT student_id, first_name, last_name, email, major, academic_year, enrollment_status FROM students ' + built.where +
    ' ORDER BY last_name, first_name LIMIT $' + values.length,
    values
  ).then(function (r) { return r.rows.map(sourceSisRow); });
}

function searchSourceRecords(source, params) {
  params = params || {};
  const q = params.q, limit = params.limit || 200;
  if (source === 'sis') return searchSisRecords(params);
  if (source === 'housing') return searchHousingRecords(q, limit);
  if (source === 'campusSafety') return searchCampusSafetyRecords(q, limit);
  if (source === 'academicIntegrity') return searchAcademicIntegrityRecords(q, limit);
  if (source === 'webReports') return searchWebReportRecords(q, limit);
  const e = new Error('Unknown source "' + source + '".');
  e.status = 400;
  throw e;
}

// Enumerates every record type pulled into a student's cross-domain profile
// (getStudentRecordProfile below). Adding a future domain (Student Conduct,
// Title IX, Behavioral Incidents) means appending one entry here — no new
// Promise.all branch, no new repo function, no route change. Table/column
// names are fixed, developer-authored config, never derived from user
// input, so interpolating them into SQL is safe — the same trust boundary
// already used by searchSourceRecords above and by SOURCE_META in
// public/records.js.
const STUDENT_PROFILE_DOMAINS = [
  { key: 'housing', table: 'housing', studentCol: 'student_id', orderBy: 'move_in_date DESC NULLS LAST', mapRow: housingRecordRow },
  { key: 'campusSafety', table: 'campus_safety', studentCol: 'student_id', orderBy: 'incident_date DESC NULLS LAST', mapRow: campusSafetyRow },
  { key: 'academicIntegrity', table: 'academic_integrity', studentCol: 'student_id', orderBy: 'incident_date DESC NULLS LAST', mapRow: academicIntegrityRow },
  { key: 'reports', table: 'student_reports', studentCol: 'reported_student_id', orderBy: 'submitted_date DESC NULLS LAST', mapRow: studentReportRow },
  { key: 'wellness', table: 'entries', studentCol: 'student_id', orderBy: 'created_at DESC', mapRow: rowToEntry },
];

function getStudentRecordProfile(studentId) {
  return db.query('SELECT * FROM students WHERE student_id = $1', [studentId]).then(function (r) {
    if (!r.rows[0]) return null;
    const student = studentRecordRow(r.rows[0]);
    const queries = STUDENT_PROFILE_DOMAINS.map(function (d) {
      return db.query('SELECT * FROM ' + d.table + ' WHERE ' + d.studentCol + ' = $1 ORDER BY ' + d.orderBy, [studentId]);
    });
    return Promise.all(queries).then(function (results) {
      const profile = { student: student };
      STUDENT_PROFILE_DOMAINS.forEach(function (d, i) { profile[d.key] = results[i].rows.map(d.mapRow); });
      return profile;
    });
  });
}

module.exports = {
  countUsers, createUser, getUserByEmail, getUserById, listUsers, setUserActive, setUserRole, touchLogin, publicUser,
  createSession, getSession, deleteSession, touchSessionActivity,
  createInvite, listInvites, getInviteByToken, markInviteUsed, deleteInvite,
  listSemesters, createSemester, findOrCreateSemester, getSemester, deleteSemester,
  listEntries, getEntry, createEntry, updateEntry, deleteEntry, bulkCreateEntries, studentKeyFor,
  countEntriesForScope, purgeEntries,
  listTemplates, getTemplate, getDefaultTemplate, createTemplate, deleteTemplate, countEntriesForTemplate,
  listTemplateOptions, addTemplateOption, setTemplateOptionActive,
  createAuditLog, listAuditLog,
  searchStudentRecords, getStudentRecordProfile, searchSourceRecords, getStudentRecordFacets,
};
