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

require('./lib/env'); // loads .env in local dev if present

const cfg = require('./lib/config');
const agg = require('./lib/aggregate');
const auth = require('./lib/auth');
const repo = require('./db/repo');

const PORT = process.env.PORT || 4787;
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

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

async function currentUser(req) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.SESSION_COOKIE];
  if (!token) return null;
  const session = await repo.getSession(token);
  if (!session || !session.user.isActive) return null;
  // sliding expiration: refresh on use
  repo.touchSession(token, auth.sessionExpiry()).catch(function () {});
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

function validateEntry(fields, semesterId) {
  const errors = [];
  cfg.FIELDS.forEach(function (f) {
    if (f.required && (fields[f.key] === '' || fields[f.key] === undefined)) errors.push(f.label + ' is required.');
  });
  if (!semesterId) errors.push('Semester is required.');
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

async function activeOptionsByGroup() {
  const byGroup = await repo.listTemplateOptions();
  const out = {};
  Object.keys(byGroup).forEach(function (g) {
    out[g] = byGroup[g].filter(function (o) { return o.active; }).map(function (o) { return o.value; });
  });
  return out;
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
  const byGroup = await repo.listTemplateOptions().catch(function () { return {}; });
  const fields = cfg.FIELDS.map(function (f) {
    if (f.type !== 'select') return f;
    const live = (byGroup[f.optionGroup] || []).filter(function (o) { return o.active; }).map(function (o) { return o.value; });
    const groupDefaults = (cfg.OPTION_GROUPS.find(function (g) { return g.key === f.optionGroup; }) || {}).defaults || [];
    return Object.assign({}, f, { options: live.length ? live : groupDefaults });
  });
  const payload = { FIELDS: fields, SECTIONS: cfg.SECTIONS, CSV_COLUMNS: cfg.CSV_COLUMNS };
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
    return sendJSON(res, 201, { user: repo.publicUser(user) });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const user = await repo.getUserByEmail(body.email || '');
    if (!user || !user.isActive || !auth.verifyPassword(body.password || '', user.passwordHash)) {
      return sendJSON(res, 401, { error: 'Incorrect email or password.' });
    }
    await startSession(res, user.id);
    repo.touchLogin(user.id).catch(function () {});
    return sendJSON(res, 200, { user: repo.publicUser(user) });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookies = auth.parseCookies(req);
    const token = cookies[auth.SESSION_COOKIE];
    if (token) await repo.deleteSession(token);
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
      return sendJSON(res, 200, { entry: entry });
    }
    if (req.method === 'POST' && !id) {
      const body = await readBody(req);
      const fields = sanitizeFields(body);
      const errors = validateEntry(fields, body.semesterId);
      if (errors.length) return sendJSON(res, 400, { errors: errors });
      const entry = await repo.createEntry(fields, user.id, { semesterId: body.semesterId });
      return sendJSON(res, 201, { entry: entry });
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
      const body = await readBody(req);
      const fields = sanitizeFields(body);
      const errors = validateEntry(fields, body.semesterId);
      if (errors.length) return sendJSON(res, 400, { errors: errors });
      const entry = await repo.updateEntry(id, fields, user.id, { semesterId: body.semesterId });
      if (!entry) return sendJSON(res, 404, { error: 'Entry not found' });
      return sendJSON(res, 200, { entry: entry });
    }
    if (req.method === 'DELETE' && id) {
      const ok = await repo.deleteEntry(id);
      if (!ok) return sendJSON(res, 404, { error: 'Entry not found' });
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
    return sendJSON(res, 201, { semester: semester });
  }

  if (pathname === '/api/students' && req.method === 'GET') {
    const students = agg.groupStudents(filterEntries(await repo.listEntries(), query));
    return sendJSON(res, 200, { students: students });
  }

  if (pathname === '/api/dashboard' && req.method === 'GET') {
    const from = parseDateParam(query.from);
    const to = parseDateParam(query.to);
    const optionsByGroup = await activeOptionsByGroup();
    const entries = filterEntries(await repo.listEntries(), query);
    const dashboard = agg.computeDashboard(entries, from, to, optionsByGroup);
    return sendJSON(res, 200, dashboard);
  }

  if (pathname === '/api/import' && req.method === 'POST') {
    requireAdmin(user);
    const body = await readBody(req, 20 * 1024 * 1024);
    const result = await runImport(body, user);
    return sendJSON(res, 200, result);
  }

  if (pathname === '/api/export.csv' && req.method === 'GET') {
    const csv = entriesToCSV(filterEntries(await repo.listEntries(), query));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="wellness-case-log.csv"' });
    res.end(csv);
    return;
  }

  if (pathname === '/api/template' && req.method === 'GET') {
    const byGroup = await repo.listTemplateOptions();
    return sendJSON(res, 200, { groups: cfg.OPTION_GROUPS.map(function (g) { return { key: g.key, label: g.label, options: byGroup[g.key] || [] }; }) });
  }

  const templateAddMatch = pathname.match(/^\/api\/template\/([^/]+)$/);
  if (templateAddMatch && req.method === 'POST') {
    requireAdmin(user);
    const body = await readBody(req);
    const value = String(body.value || '').trim();
    if (!value) return sendJSON(res, 400, { error: 'Value is required.' });
    const groupKey = templateAddMatch[1];
    if (!cfg.OPTION_GROUPS.find(function (g) { return g.key === groupKey; })) return sendJSON(res, 404, { error: 'Unknown option group.' });
    const row = await repo.addTemplateOption(groupKey, value, user.id);
    return sendJSON(res, 201, { option: { id: row.id, value: row.value, active: row.active } });
  }

  const templateArchiveMatch = pathname.match(/^\/api\/template\/([^/]+)\/([^/]+)$/);
  if (templateArchiveMatch && (req.method === 'DELETE' || req.method === 'PATCH')) {
    requireAdmin(user);
    const active = req.method === 'PATCH' ? true : false;
    const row = await repo.setTemplateOptionActive(templateArchiveMatch[2], active);
    if (!row) return sendJSON(res, 404, { error: 'Option not found' });
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
    if (typeof body.isActive === 'boolean') updated = await repo.setUserActive(userPatchMatch[1], body.isActive);
    if (body.role) updated = await repo.setUserRole(userPatchMatch[1], body.role);
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
    return sendJSON(res, 201, { invite: invite });
  }
  const inviteDeleteMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteDeleteMatch && req.method === 'DELETE') {
    requireAdmin(user);
    await repo.deleteInvite(inviteDeleteMatch[1]);
    return sendJSON(res, 200, { ok: true });
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
    const errors = validateEntry(fields, semesterId);
    if (errors.length) { skipped.push({ row: idx + 1, reason: errors.join(' ') }); return; }
    const counselorName = String(row.counselorName || '').trim();
    const matchedUserId = counselorName ? nameToUserId[counselorName.toLowerCase()] : null;
    valid.push({
      fields: fields,
      semesterId: semesterId,
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
