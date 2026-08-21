// Dashboard aggregation. Fully dynamic — takes whatever field schema the
// caller passes in (see server.js's buildFieldSchemaForDashboard, which
// merges every template's active fields) and builds one breakdown section
// per field: select -> value-count breakdown, number -> sum + average,
// date -> month-by-month counts. Nothing here assumes any specific field
// (Case Status, NABITA Risk, ...) exists — a template with none of those
// simply produces no sections for them.

'use strict';

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function entryDate(entry) {
  return parseDate(entry.outreachDate) || parseDate(entry.referralDate) || parseDate(entry.createdAt);
}

function inRange(date, from, to) {
  if (!date) return !from && !to;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function filterByRange(entries, from, to) {
  if (!from && !to) return entries.slice();
  return entries.filter(function (e) { return inRange(entryDate(e), from, to); });
}

function sortByDateDesc(entries) {
  return entries.slice().sort(function (a, b) {
    const da = entryDate(a), db = entryDate(b);
    const ta = da ? da.getTime() : 0, tb = db ? db.getTime() : 0;
    return tb - ta;
  });
}

// Only student_key/first/last/studentIdExternal are guaranteed to exist —
// everything else about a student lives in their individual entries (see
// entry.fields), rendered per-entry in the drawer rather than summarized
// here with an assumed set of properties.
function groupStudents(entries) {
  const map = new Map();
  entries.forEach(function (e) {
    const key = e.studentKey || '';
    if (!key || key === '|') return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  });
  const students = [];
  map.forEach(function (list, key) {
    const sorted = sortByDateDesc(list);
    const latest = sorted[0];
    const dates = sorted.map(entryDate).filter(Boolean);
    students.push({
      studentKey: key,
      firstName: latest.firstName,
      lastName: latest.lastName,
      studentIdExternal: latest.studentIdExternal,
      entryCount: list.length,
      lastContact: dates.length ? dates[0].toISOString() : null,
      firstContact: dates.length ? dates[dates.length - 1].toISOString() : null,
      entries: sorted,
    });
  });
  students.sort(function (a, b) {
    const ta = a.lastContact ? new Date(a.lastContact).getTime() : 0;
    const tb = b.lastContact ? new Date(b.lastContact).getTime() : 0;
    return tb - ta;
  });
  return students;
}

function fieldValue(entry, key) {
  if (entry.fields && entry.fields[key] !== undefined) return entry.fields[key];
  return entry[key];
}

// seedOptions (a field's live dropdown list) pre-populates zero-count bars
// so an option nobody's picked yet still shows; any value actually found in
// the data is counted even if it's since been removed from the dropdown, so
// historical entries are never dropped from the report.
function valueCounts(entries, fieldKey, seedOptions) {
  const counts = {};
  (seedOptions || []).forEach(function (o) { counts[o] = 0; });
  entries.forEach(function (e) {
    const v = fieldValue(e, fieldKey);
    if (v === undefined || v === null || v === '') return;
    counts[v] = (counts[v] || 0) + 1;
  });
  return counts;
}

function numberStats(entries, fieldKey) {
  let sum = 0, count = 0;
  entries.forEach(function (e) {
    const v = fieldValue(e, fieldKey);
    if (v === undefined || v === null || v === '') return;
    const n = Number(v);
    if (!isNaN(n)) { sum += n; count++; }
  });
  return { sum: round2(sum), average: count ? round2(sum / count) : 0, count: count };
}

function monthCountsForField(entries, fieldKey) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const counts = {};
  months.forEach(function (m) { counts[m] = 0; });
  entries.forEach(function (e) {
    const d = parseDate(fieldValue(e, fieldKey));
    if (d) counts[months[d.getUTCMonth()]]++;
  });
  return counts;
}

// fieldSchema: [{ key, label, type: 'select'|'number'|'date'|'text'|'textarea', options? }]
// — the merged set of active fields across every template currently in
// play (server.js resolves this; aggregate.js itself has no DB access and
// stays a pure function of its inputs, same as before).
function computeDashboard(allEntries, from, to, fieldSchema) {
  fieldSchema = fieldSchema || [];
  const periodEntries = filterByRange(allEntries, from, to);
  const periodStudents = groupStudents(periodEntries);

  const sections = fieldSchema.map(function (f) {
    if (f.type === 'select') return { key: f.key, label: f.label, type: 'select', counts: valueCounts(periodEntries, f.key, f.options) };
    if (f.type === 'number') return Object.assign({ key: f.key, label: f.label, type: 'number' }, numberStats(periodEntries, f.key));
    if (f.type === 'date') return { key: f.key, label: f.label, type: 'date', monthCounts: monthCountsForField(periodEntries, f.key) };
    return null; // text/textarea aren't meaningful to bucket/aggregate
  }).filter(Boolean);

  return {
    range: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
    totals: { uniqueStudents: periodStudents.length, totalEntries: periodEntries.length },
    sections: sections,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { groupStudents, computeDashboard, filterByRange, entryDate, parseDate };
