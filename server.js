// Wellness Case Tracker — server.
// Node http + a thin router (no framework) talking to Postgres. Auth is
// cookie + DB-backed sessions (see lib/auth.js, db/repo.js).

'use strict';

// Force UTC regardless of host timezone: dates are stored as DATE columns
// (no time component) and treated as UTC-midnight everywhere in this app —
// running the process in any other zone can shift imported/entered dates by
// a day when read back with local Date getters.
process.env.TZ = 'UTC';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

require('./lib/env'); // loads .env in local dev if present

const cfg = require('./lib/config');
const agg = require('./lib/aggregate');
const auth = require('./lib/auth');
const repo = require('./db/repo');

const PORT = process.env.PORT || 4787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

// NIST-style idle timeout: a session with no authenticated request in this
// window is treated as expired server-side, independent of its absolute
// expiry. The client mirrors this with its own timer (see public/app.js) so
// an idle user is warned and redirected proactively rather than just failing
// on their next click — but this check is the actual enforcement point.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, status, text, contentType) {
  const body = String(text);
  res.writeHead(status, { 'Content-Type': contentType || 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, maxBytes) {
  maxBytes = maxBytes || 5 * 1024 * 1024;
  return new Promise(function (resolve, reject) {
    let chunks = [], size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('Payload too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function requestIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

// Fire-and-forget audit write — never awaited by callers, so a logging
// failure can't block or fail the action it's recording. Every access to or
// mutation of a specific record should call this with that record's id.
function logAudit(req, user, actionType, targetRecordId, metadata) {
  repo.createAuditLog({
    actorId: user ? user.id : null,
    actorName: user ? user.name : null,
    actionType: actionType,
    targetRecordId: targetRecordId || null,
    ipAddress: requestIp(req),
    userAgent: req.headers['user-agent'] || '',
    metadata: metadata || null,
  }).catch(function (err) { console.error('audit log failed:', actionType, err.message); });
}

async function currentUser(req) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.SESSION_COOKIE];
  if (!token) return null;
  const session = await repo.getSession(token);
  if (!session || !session.user.isActive) return null;
  const idleMs = Date.now() - new Date(session.lastSeenAt).getTime();
  if (idleMs > IDLE_TIMEOUT_MS) {
    await repo.deleteSession(token);
    logAudit(req, session.user, 'auth.idle_timeout', session.user.id);
    return null;
  }
  repo.touchSessionActivity(token).catch(function () {});
  return session.user;
}

function sanitizeFields(input) {
  const out = {};
  cfg.FIELDS.forEach(function (f) {
    let v = input[f.key];
    if (v === undefined || v === null) v = '';
    if (typeof v === 'string') v = v.trim();
    if (f.type === 'number') { v = v === '' ? '' : Number(v); if (isNaN(v)) v = ''; }
    out[f.key] = v;
  });
  return out;
}

function validateEntry(fields, semesterId, templateId) {
  const errors = [];
  cfg.FIELDS.forEach(function (f) {
    if (f.required && (fields[f.key] === '' || fields[f.key] === undefined)) errors.push(f.label + ' is required.');
  });
  if (!semesterId) errors.push('Semester is required.');
  if (!templateId) errors.push('Template is required.');
  return errors;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function entriesToCSV(entries) {
  const header = cfg.CSV_COLUMNS.map(function (c) { return csvEscape(c.header); }).join(',');
  const rows = entries.map(function (e) { return cfg.CSV_COLUMNS.map(function (c) { return csvEscape(e[c.key]); }).join(','); });
  return [header].concat(rows).join('\r\n');
}

function filterEntries(entries, query) {
  var out = entries;
  if (query.semesterId && query.semesterId !== 'all') {
    out = out.filter(function (e) { return e.semesterId === query.semesterId; });
  }
  if (query.counselor && query.counselor !== 'all') {
    var needle = String(query.counselor).toLowerCase();
    out = out.filter(function (e) {
      return (e.createdBy && e.createdBy === query.counselor) ||
        (e.createdByName && e.createdByName.toLowerCase() === needle);
    });
  }
  return out;
}

async function activeOptionsByGroup(templateId) {
  const byGroup = await repo.listTemplateOptions(templateId);
  const out = {};
  Object.keys(byGroup).forEach(function (g) {
    out[g] = byGroup[g].filter(function (o) { return o.active; }).map(function (o) { return o.value; });
  });
  return out;
}

// Shared by GET /api/dashboard (on-screen) and GET /api/dashboard/export
// (downloadable file) so the two can never drift apart.
async function buildDashboard(query) {
  const from = parseDateParam(query.from);
  const to = parseDateParam(query.to);
  const defaultTemplate = await repo.getDefaultTemplate();
  const optionsByGroup = defaultTemplate ? await activeOptionsByGroup(defaultTemplate.id) : {};
  const entries = filterEntries(await repo.listEntries(), query);
  return agg.computeDashboard(entries, from, to, optionsByGroup);
}

// Renders the same sections shown on the Dashboard screen as a labeled CSV —
// the software equivalent of the original workbook's "General Data" /
// "Graduate Raw data" snapshot tabs, but generated live for any semester /
// counselor combination instead of copy-pasted by hand.
function dashboardToCSV(d, semesterLabel, counselorLabel) {
  const lines = [];
  const row = function () { lines.push(Array.prototype.slice.call(arguments).map(csvEscape).join(',')); };
  const section = function (title) { lines.push(''); row(title.toUpperCase()); };
  const bucket = function (title, counts) {
    section(title);
    row('Category', 'Count');
    Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (k) { row(k, counts[k]); });
  };

  row('Wellness Dashboard Export');
  row('Semester', semesterLabel);
  row('Counselor', counselorLabel);
  row('Generated', new Date().toISOString());

  section('Overview');
  row('Metric', 'Value');
  row('Unique Students', d.totals.uniqueStudents);
  row('Active Cases', d.totals.activeCases);
  row('Total Entries Logged', d.totals.totalEntries);
  row('Wellness Hours', d.totalHours);

  section('Student Status (unique students, most recent record)');
  row('Category', 'Count');
  row('Full-Time', d.studentStatus.fullTime);
  row('Part-Time', d.studentStatus.partTime);
  row('Not Currently Enrolled', d.studentStatus.notCurrentlyEnrolled);
  row('Non-Affiliate', d.studentStatus.nonAffiliate);
  row('International', d.studentStatus.international);
  row('Domestic', d.studentStatus.domestic);
  row('In Person', d.studentStatus.inPerson);
  row('Online Only', d.studentStatus.onlineOnly);
  row('Mode N/A', d.studentStatus.modalityNA);

  bucket('Case Status (unique students, current status)', d.caseStatus);
  bucket('Program Breakdown', d.program.buckets);
  bucket('Case Type — NABITA Risk Rubric', d.caseType);
  bucket('Referral Source (every logged entry)', d.referralSource);
  bucket('Referrals Made', d.referralsMade);

  section('Wellness Hours by Category (minutes ÷ 60, every logged entry)');
  row('Category', 'Hours');
  Object.keys(d.hours).forEach(function (k) { row(k, d.hours[k]); });
  row('Total', d.totalHours);

  bucket('Outreach Method (every logged entry)', d.outreachMethod);
  bucket('Wellness Concern Category (Primary + Secondary + Tertiary)', d.concerns);
  bucket('Referral Type (every logged entry)', d.referralType);

  section('Referral Date by Month');
  row('Month', 'Count');
  Object.keys(d.referralDateByMonth).forEach(function (k) { row(k, d.referralDateByMonth[k]); });

  return lines.join('\r\n');
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (filePath.indexOf(PUBLIC_DIR) !== 0) { sendText(res, 403, 'Forbidden'); return; }
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) filePath = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, function (readErr, data) {
      if (readErr) { sendText(res, 404, 'Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

function parseDateParam(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const server = http.createServer(function (req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/healthz') { sendText(res, 200, 'ok'); return; }

  if (pathname === '/config.js') {
    handleConfigJs(res).catch(function (err) { sendText(res, 500, '// error: ' + err.message, 'text/javascript'); });
    return;
  }
  if (pathname.indexOf('/api/') === 0) {
    handleApi(req, res, pathname, parsed.query).catch(function (err) {
      if (err.status) return sendJSON(res, err.status, { error: err.message });
      console.error(err);
      sendJSON(res, 500, { error: err.message || 'Server error' });
    });
    return;
  }
  if (req.method === 'GET') { serveStatic(req, res, pathname); return; }
  sendText(res, 404, 'Not found');
});

async function handleConfigJs(res) {
  const defaultTemplate = await repo.getDefaultTemplate().catch(function () { return null; });
  const byGroup = defaultTemplate ? await repo.listTemplateOptions(defaultTemplate.id).catch(function () { return {}; }) : {};
  const fields = cfg.FIELDS.map(function (f) {
    if (f.type !== 'select') return f;
    const live = (byGroup[f.optionGroup] || []).filter(function (o) { return o.active; }).map(function (o) { return o.value; });
    const groupDefaults = (cfg.OPTION_GROUPS.find(function (g) { return g.key === f.optionGroup; }) || {}).defaults || [];
    return Object.assign({}, f, { options: live.length ? live : groupDefaults });
  });
  const payload = { FIELDS: fields, SECTIONS: cfg.SECTIONS, CSV_COLUMNS: cfg.CSV_COLUMNS, DEFAULT_TEMPLATE_ID: defaultTemplate ? defaultTemplate.id : null };
  sendText(res, 200, 'window.WELLNESS_CONFIG = ' + JSON.stringify(payload) + ';\n', 'text/javascript; charset=utf-8');
}

async function handleApi(req, res, pathname, query) {
  // ---- Public auth endpoints ----
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const userCount = await repo.countUsers();
    const user = await currentUser(req);
    return sendJSON(res, 200, { setupRequired: userCount === 0, user: user ? repo.publicUser(user) : null });
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    const userCount = await repo.countUsers();
    if (userCount > 0) return sendJSON(res, 403, { error: 'Setup already completed.' });
    const body = await readBody(req);
    const err = validateSignup(body);
    if (err) return sendJSON(res, 400, { error: err });
    const user = await repo.createUser({ email: body.email, name: body.name, passwordHash: auth.hashPassword(body.password), role: 'admin' });
    await startSession(res, user.id);
    logAudit(req, user, 'auth.setup', user.id);
    return sendJSON(res, 201, { user: repo.publicUser(user) });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const user = await repo.getUserByEmail(body.email || '');
    if (!user || !user.isActive || !auth.verifyPassword(body.password || '', user.passwordHash)) {
      logAudit(req, null, 'auth.login_failed', null, { email: body.email || '' });
      return sendJSON(res, 401, { error: 'Incorrect email or password.' });
    }
    await startSession(res, user.id);
    repo.touchLogin(user.id).catch(function () {});
    logAudit(req, user, 'auth.login', user.id);
    return sendJSON(res, 200, { user: repo.publicUser(user) });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = auth.parseCookies(req);
    const token = cookies[auth.SESSION_COOKIE];
    if (token) {
      const session = await repo.getSession(token).catch(function () { return null; });
      await repo.deleteSession(token);
      if (session) logAudit(req, session.user, 'auth.logout', session.user.id);
    }
    auth.clearSessionCookie(res, COOKIE_SECURE);
    return sendJSON(res, 200, { ok: true });
  }

  const inviteCheckMatch = pathname.match(/^\/api\/invites\/([^/]+)\/check$/);
  if (inviteCheckMatch && req.method === 'GET') {
    const invite = await repo.getInviteByToken(inviteCheckMatch[1]);
    if (!invite || invite.usedAt || new Date(invite.expiresAt) < new Date()) {
      return sendJSON(res, 404, { error: 'This invite link is invalid or has expired.' });
    }
    return sendJSON(res, 200, { email: invite.email, role: invite.role });
  }

  if (pathname === '/api/auth/accept-invite' && req.method === 'POST') {
    const body = await readBody(req);
    const invite = await repo.getInviteByToken(body.token || '');
    if (!invite || invite.usedAt || new Date(invite.expiresAt) < new Date()) {
      return sendJSON(res, 400, { error: 'This invite link is invalid or has expired.' });
    }
    if (invite.email && body.email && invite.email.toLowerCase() !== String(body.email).toLowerCase()) {
      return sendJSON(res, 400, { error: 'This invite was issued for a different email address.' });
    }
    const email = invite.email || body.email;
    const err = validateSignup({ email: email, name: body.name, password: body.password });
    if (err) return sendJSON(res, 400, { error: err });
    const existing = await repo.getUserByEmail(email);
    if (existing) return sendJSON(res, 400, { error: 'An account with this email already exists — try logging in.' });
    const user = await repo.createUser({ email: email, name: body.name, passwordHash: auth.hashPassword(body.password), role: invite.role });
    await repo.markInviteUsed(invite.id, user.id);
    await startSession(res, user.id);
    logAudit(req, user, 'invite.accept', invite.id, { newUserId: user.id });
    return sendJSON(res, 201, { user: repo.publicUser(user) });
  }

  // ---- Everything past this point requires a logged-in, active user ----
  const user = await currentUser(req);
  if (!user) return sendJSON(res, 401, { error: 'Not signed in.' });

  if (pathname === '/api/auth/me' && req.method === 'GET') return sendJSON(res, 200, { user: repo.publicUser(user) });

  const entryMatch = pathname.match(/^\/api\/entries(?:\/([^/]+))?$/);
  if (entryMatch) {
    const id = entryMatch[1];
    if (req.method === 'GET' && !id) {
      const entries = filterEntries(await repo.listEntries(), query);
      return sendJSON(res, 200, { entries: entries });
    }
    if (req.method === 'GET' && id) {
      const entry = await repo.getEntry(id);
      if (!entry) return sendJSON(res, 404, { error: 'Entry not found' });
      logAudit(req, user, 'entry.view', id);
      return sendJSON(res, 200, { entry: entry });
    }
    if (req.method === 'POST' && !id) {
      const body = await readBody(req);
      const fields = sanitizeFields(body);
      const errors = validateEntry(fields, body.semesterId, body.templateId);
      if (errors.length) return sendJSON(res, 400, { errors: errors });
      const entry = await repo.createEntry(fields, user.id, { semesterId: body.semesterId, templateId: body.templateId });
      logAudit(req, user, 'entry.create', entry.id, { studentKey: entry.studentKey });
      return sendJSON(res, 201, { entry: entry });
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
      const body = await readBody(req);
      const fields = sanitizeFields(body);
      const errors = validateEntry(fields, body.semesterId, body.templateId);
      if (errors.length) return sendJSON(res, 400, { errors: errors });
      const entry = await repo.updateEntry(id, fields, user.id, { semesterId: body.semesterId, templateId: body.templateId });
      if (!entry) return sendJSON(res, 404, { error: 'Entry not found' });
      logAudit(req, user, 'entry.update', id, { studentKey: entry.studentKey });
      return sendJSON(res, 200, { entry: entry });
    }
    if (req.method === 'DELETE' && id) {
      // RBAC: only the entry's own creator or an admin may delete a case
      // record — any signed-in user could otherwise erase anyone's cases.
      const existing = await repo.getEntry(id);
      if (!existing) return sendJSON(res, 404, { error: 'Entry not found' });
      if (user.role !== 'admin' && existing.createdBy !== user.id) {
        const e = new Error('Only an admin or the counselor who logged this entry can delete it.');
        e.status = 403;
        throw e;
      }
      const ok = await repo.deleteEntry(id);
      if (!ok) return sendJSON(res, 404, { error: 'Entry not found' });
      logAudit(req, user, 'entry.delete', id, { studentKey: existing.studentKey });
      return sendJSON(res, 200, { ok: true });
    }
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }

  if (pathname === '/api/semesters' && req.method === 'GET') {
    const semesters = await repo.listSemesters();
    return sendJSON(res, 200, { semesters: semesters });
  }
  if (pathname === '/api/semesters' && req.method === 'POST') {
    const body = await readBody(req);
    const label = String(body.label || '').trim();
    if (!label) return sendJSON(res, 400, { error: 'Semester name is required.' });
    const semester = await repo.createSemester({ label: label, startsOn: body.startsOn || null, endsOn: body.endsOn || null }, user.id);
    logAudit(req, user, 'semester.create', semester.id, { label: semester.label });
    return sendJSON(res, 201, { semester: semester });
  }

  if (pathname === '/api/students' && req.method === 'GET') {
    const students = agg.groupStudents(filterEntries(await repo.listEntries(), query));
    return sendJSON(res, 200, { students: students });
  }

  if (pathname === '/api/dashboard' && req.method === 'GET') {
    const dashboard = await buildDashboard(query);
    return sendJSON(res, 200, dashboard);
  }

  if (pathname === '/api/counselors' && req.method === 'GET') {
    const entries = await repo.listEntries();
    const seen = {};
    entries.forEach(function (e) { if (e.createdByName) seen[e.createdByName] = true; });
    return sendJSON(res, 200, { counselors: Object.keys(seen).sort() });
  }

  if (pathname === '/api/dashboard/export' && req.method === 'GET') {
    const dashboard = await buildDashboard(query);
    const semesters = await repo.listSemesters();
    const semesterLabel = (!query.semesterId || query.semesterId === 'all') ? 'All Semesters'
      : ((semesters.find(function (s) { return s.id === query.semesterId; }) || {}).label || 'Unknown Semester');
    const counselorLabel = (!query.counselor || query.counselor === 'all') ? 'All Counselors' : query.counselor;
    const csv = dashboardToCSV(dashboard, semesterLabel, counselorLabel);
    logAudit(req, user, 'dashboard.export', null, { semesterId: query.semesterId || null, counselor: query.counselor || null });
    const filenameSafe = (semesterLabel + '_' + counselorLabel).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="wellness-dashboard-' + filenameSafe + '.csv"' });
    res.end(csv);
    return;
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    requireAdmin(user);
    const body = await readBody(req, 20 * 1024 * 1024);
    const result = await runImport(body, user);
    return sendJSON(res, 200, result);
  }

  if (pathname === '/api/export.csv' && req.method === 'GET') {
    const filtered = filterEntries(await repo.listEntries(), query);
    const csv = entriesToCSV(filtered);
    logAudit(req, user, 'entry.export', null, { rowCount: filtered.length, semesterId: query.semesterId || null });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="wellness-case-log.csv"' });
    res.end(csv);
    return;
  }

  if (pathname === '/api/templates' && req.method === 'GET') {
    const templates = await repo.listTemplates();
    return sendJSON(res, 200, { templates: templates });
  }
  if (pathname === '/api/templates' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendJSON(res, 400, { error: 'Template name is required.' });
    const template = await repo.createTemplate(name, user.id).catch(function (err) {
      if (/duplicate key|unique/i.test(err.message)) { const e = new Error('A template named "' + name + '" already exists.'); e.status = 400; throw e; }
      throw err;
    });
    const options = await repo.listTemplateOptions(template.id);
    logAudit(req, user, 'template.create', template.id, { name: template.name });
    return sendJSON(res, 201, { template: template, groups: cfg.OPTION_GROUPS.map(function (g) { return { key: g.key, label: g.label, options: options[g.key] || [] }; }) });
  }

  const templateOptionsMatch = pathname.match(/^\/api\/templates\/([^/]+)\/options$/);
  if (templateOptionsMatch && req.method === 'GET') {
    const options = await repo.listTemplateOptions(templateOptionsMatch[1]);
    return sendJSON(res, 200, { groups: cfg.OPTION_GROUPS.map(function (g) { return { key: g.key, label: g.label, options: options[g.key] || [] }; }) });
  }

  const templateAddMatch = pathname.match(/^\/api\/templates\/([^/]+)\/options\/([^/]+)$/);
  if (templateAddMatch && req.method === 'POST') {
    const templateId = templateAddMatch[1], groupKey = templateAddMatch[2];
    await requireTemplateEditable(templateId, user);
    const body = await readBody(req);
    const value = String(body.value || '').trim();
    if (!value) return sendJSON(res, 400, { error: 'Value is required.' });
    if (!cfg.OPTION_GROUPS.find(function (g) { return g.key === groupKey; })) return sendJSON(res, 404, { error: 'Unknown option group.' });
    const row = await repo.addTemplateOption(templateId, groupKey, value, user.id);
    logAudit(req, user, 'template.option_add', templateId, { groupKey: groupKey, value: value });
    return sendJSON(res, 201, { option: { id: row.id, value: row.value, active: row.active } });
  }

  const templateArchiveMatch = pathname.match(/^\/api\/templates\/([^/]+)\/options\/([^/]+)\/([^/]+)$/);
  if (templateArchiveMatch && (req.method === 'DELETE' || req.method === 'PATCH')) {
    const templateId = templateArchiveMatch[1], groupKeyForLog = templateArchiveMatch[2], optionId = templateArchiveMatch[3];
    await requireTemplateEditable(templateId, user);
    const active = req.method === 'PATCH' ? true : false;
    const row = await repo.setTemplateOptionActive(templateId, optionId, active);
    if (!row) return sendJSON(res, 404, { error: 'Option not found' });
    logAudit(req, user, active ? 'template.option_restore' : 'template.option_archive', templateId, { groupKey: groupKeyForLog, value: row.value });
    return sendJSON(res, 200, { option: { id: row.id, value: row.value, active: row.active } });
  }

  if (pathname === '/api/users' && req.method === 'GET') {
    requireAdmin(user);
    const users = await repo.listUsers();
    return sendJSON(res, 200, { users: users.map(repo.publicUser) });
  }

  const userPatchMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userPatchMatch && req.method === 'PATCH') {
    requireAdmin(user);
    const body = await readBody(req);
    let updated = null;
    if (typeof body.isActive === 'boolean') {
      updated = await repo.setUserActive(userPatchMatch[1], body.isActive);
      if (updated) logAudit(req, user, body.isActive ? 'user.reactivate' : 'user.deactivate', updated.id);
    }
    if (body.role) {
      updated = await repo.setUserRole(userPatchMatch[1], body.role);
      if (updated) logAudit(req, user, 'user.role_change', updated.id, { newRole: body.role });
    }
    if (!updated) return sendJSON(res, 404, { error: 'User not found' });
    return sendJSON(res, 200, { user: repo.publicUser(updated) });
  }

  if (pathname === '/api/invites' && req.method === 'GET') {
    requireAdmin(user);
    const invites = await repo.listInvites();
    return sendJSON(res, 200, { invites: invites });
  }
  if (pathname === '/api/invites' && req.method === 'POST') {
    requireAdmin(user);
    const body = await readBody(req);
    const token = auth.newToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invite = await repo.createInvite({ email: body.email ? String(body.email).trim().toLowerCase() : null, role: body.role === 'admin' ? 'admin' : 'counselor', createdBy: user.id, token: token, expiresAt: expiresAt });
    logAudit(req, user, 'invite.create', invite.id, { email: invite.email, role: invite.role });
    return sendJSON(res, 201, { invite: invite });
  }
  const inviteDeleteMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteDeleteMatch && req.method === 'DELETE') {
    requireAdmin(user);
    await repo.deleteInvite(inviteDeleteMatch[1]);
    logAudit(req, user, 'invite.revoke', inviteDeleteMatch[1]);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/audit-log' && req.method === 'GET') {
    requireAdmin(user);
    const logs = await repo.listAuditLog(
      { actorId: query.actorId || null, actionType: query.actionType || null },
      Math.min(Number(query.limit) || 200, 500)
    );
    return sendJSON(res, 200, { logs: logs });
  }

  // ---- Student Records: read-only synthetic SIS/Housing/Safety/AI/Reports dataset ----
  if (pathname === '/api/student-records' && req.method === 'GET') {
    const q = String(query.q || '').trim();
    if (q.length < 2) return sendJSON(res, 200, { students: [] });
    const students = await repo.searchStudentRecords(q, 50);
    return sendJSON(res, 200, { students: students });
  }

  const studentRecordMatch = pathname.match(/^\/api\/student-records\/([^/]+)$/);
  if (studentRecordMatch && req.method === 'GET') {
    const profile = await repo.getStudentRecordProfile(studentRecordMatch[1]);
    if (!profile) return sendJSON(res, 404, { error: 'Student not found' });
    logAudit(req, user, 'student_record.view', studentRecordMatch[1]);
    return sendJSON(res, 200, { profile: profile });
  }

  // ---- Danger Zone: bulk-delete case entries ----
  if (pathname === '/api/admin/purge/preview' && req.method === 'GET') {
    requireAdmin(user);
    const scope = purgeScopeFromQuery(query);
    const count = await repo.countEntriesForScope(scope);
    return sendJSON(res, 200, { count: count });
  }

  if (pathname === '/api/admin/purge' && req.method === 'POST') {
    requireAdmin(user);
    const body = await readBody(req);
    verifyPurgePassword(body.password);
    const scope = purgeScopeFromQuery(body);
    const deletedCount = await repo.purgeEntries(scope);
    logAudit(req, user, 'data.purge', null, { scope: scope, deletedCount: deletedCount });
    return sendJSON(res, 200, { deletedCount: deletedCount });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

async function runImport(body, user) {
  const semesterDefs = Array.isArray(body.semesters) ? body.semesters : [];
  const rows = Array.isArray(body.entries) ? body.entries : [];

  const labelToId = {};
  for (const s of semesterDefs) {
    const label = String(s.label || '').trim();
    if (!label || labelToId[label]) continue;
    const semester = await repo.createSemester({ label: label, startsOn: s.startsOn || null, endsOn: s.endsOn || null }, user.id);
    labelToId[label] = semester.id;
  }

  const defaultTemplate = await repo.getDefaultTemplate();
  const importTemplateId = (defaultTemplate || {}).id || null;

  const users = await repo.listUsers();
  const nameToUserId = {};
  users.forEach(function (u) { if (u.isActive) nameToUserId[u.name.trim().toLowerCase()] = u.id; });

  const valid = [];
  const skipped = [];
  rows.forEach(function (row, idx) {
    const fields = sanitizeFields(row.fields || {});
    const semesterLabel = String(row.semesterLabel || '').trim();
    const semesterId = labelToId[semesterLabel];
    if (!semesterId) { skipped.push({ row: idx + 1, reason: 'Unrecognized semester "' + semesterLabel + '"' }); return; }
    const errors = validateEntry(fields, semesterId, importTemplateId);
    if (errors.length) { skipped.push({ row: idx + 1, reason: errors.join(' ') }); return; }
    const counselorName = String(row.counselorName || '').trim();
    const matchedUserId = counselorName ? nameToUserId[counselorName.toLowerCase()] : null;
    valid.push({
      fields: fields,
      semesterId: semesterId,
      templateId: importTemplateId,
      createdBy: matchedUserId || null,
      createdByNameOverride: matchedUserId ? null : (counselorName || null),
    });
  });

  await repo.bulkCreateEntries(valid);

  return {
    semestersCreated: Object.keys(labelToId).length,
    entriesImported: valid.length,
    totalRows: rows.length,
    skipped: skipped,
  };
}

function requireAdmin(user) {
  if (user.role !== 'admin') { const e = new Error('Admin access required.'); e.status = 403; throw e; }
}

// Danger Zone gate: a separate shared password (not a user's login password),
// held only in the server's env — never in source, so it isn't sitting in
// git history in plaintext. Fails closed if unset, and compares in constant
// time so response timing can't leak how much of the guess was right.
function verifyPurgePassword(candidate) {
  const expected = process.env.PURGE_PASSWORD;
  if (!expected) { const e = new Error('Danger Zone is not configured on this server (PURGE_PASSWORD is unset).'); e.status = 503; throw e; }
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { const e = new Error('Incorrect Danger Zone password.'); e.status = 403; throw e; }
}

function purgeScopeFromQuery(query) {
  if (query.scope === 'semester') {
    if (!query.semesterId) { const e = new Error('semesterId is required for scope=semester.'); e.status = 400; throw e; }
    return { type: 'semester', semesterId: query.semesterId };
  }
  if (query.scope === 'counselor') {
    if (!query.counselor) { const e = new Error('counselor is required for scope=counselor.'); e.status = 400; throw e; }
    return { type: 'counselor', counselorName: query.counselor };
  }
  if (query.scope === 'all') return { type: 'all' };
  const e = new Error('scope must be "all", "semester", or "counselor".');
  e.status = 400;
  throw e;
}

// Any signed-in user can edit a custom template's options, but the shared
// Default template — the baseline every new template clones from — is
// admin-only so one counselor can't silently change everyone's starting point.
async function requireTemplateEditable(templateId, user) {
  const template = await repo.getTemplate(templateId);
  if (!template) { const e = new Error('Template not found.'); e.status = 404; throw e; }
  if (template.isDefault) requireAdmin(user);
}

async function startSession(res, userId) {
  const token = auth.newToken();
  await repo.createSession(userId, token, auth.sessionExpiry());
  auth.setSessionCookie(res, token, COOKIE_SECURE);
}

function validateSignup(body) {
  if (!body.name || !String(body.name).trim()) return 'Name is required.';
  if (!body.email || !/^\S+@\S+\.\S+$/.test(body.email)) return 'A valid email is required.';
  if (!body.password || String(body.password).length < 8) return 'Password must be at least 8 characters.';
  return null;
}

process.on('unhandledRejection', function (err) { console.error('Unhandled rejection:', err); });

server.listen(PORT, function () {
  console.log('Wellness Case Tracker running at http://localhost:' + PORT);
});
