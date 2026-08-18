// Recreates the "Master Doc" dashboard aggregation formulas (Z842:AA998 in
// the original workbook) in code, reconciled against the current dropdown
// lists — see lib/config.js header comment for what changed and why.
//
// Two aggregation styles are used, matching the sheet's own documented intent:
//   - "status" style fields (enrollment, program, modality, international,
//     NABITA risk, case status) are counted once per unique student, using
//     that student's most recent entry in the selected period — the sheet's
//     own COUNTIF-per-row approach double-counts repeat visits, which this
//     corrects.
//   - "activity" style fields (concerns, referral source/type, outreach
//     method/outcome, wellness hours, referral-date-by-month) are counted
//     once per logged entry, exactly as the original sheet's own inline notes
//     say they should be ("counts every entry, not one per student").

'use strict';

const cfg = require('./config');

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
    const totalMinutes = list.reduce(function (sum, e) { return sum + (Number(e.durationMinutes) || 0); }, 0);
    const dates = sorted.map(entryDate).filter(Boolean);
    students.push({
      studentKey: key,
      firstName: latest.firstName,
      lastName: latest.lastName,
      pronouns: latest.pronouns,
      program: latest.program,
      enrollmentStatus: latest.enrollmentStatus,
      international: latest.international,
      modality: latest.modality,
      columbiaOfficer: latest.columbiaOfficer,
      nabitaRisk: latest.nabitaRisk,
      caseStatus: latest.caseStatus,
      entryCount: list.length,
      totalMinutes: totalMinutes,
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

function emptyBucketCounts(buckets) {
  const out = {};
  Object.keys(buckets).forEach(function (k) { out[k] = 0; });
  return out;
}

function findBucket(buckets, value) {
  if (!value) return null;
  const norm = String(value).trim();
  const keys = Object.keys(buckets);
  for (let i = 0; i < keys.length; i++) {
    if (buckets[keys[i]].indexOf(norm) !== -1) return keys[i];
  }
  return null;
}

// "Other" catches values that don't fall into any known bucket — e.g. a
// custom dropdown option an admin added after the buckets were defined.
// Nothing selectable ever silently disappears from the dashboard.
function countByBucketSingle(items, buckets, getValue) {
  const counts = emptyBucketCounts(buckets);
  items.forEach(function (item) {
    const value = getValue(item);
    if (!value) return;
    const bucket = findBucket(buckets, value);
    if (bucket) counts[bucket]++;
    else counts['Other'] = (counts['Other'] || 0) + 1;
  });
  return { counts: counts };
}

function countByBucketMulti(items, buckets, getValues) {
  const counts = emptyBucketCounts(buckets);
  items.forEach(function (item) {
    getValues(item).forEach(function (value) {
      if (!value) return;
      const bucket = findBucket(buckets, value);
      if (bucket) counts[bucket]++;
      else counts['Other'] = (counts['Other'] || 0) + 1;
    });
  });
  return { counts: counts };
}

// options seeds the zero-count bars (current live dropdown list); any value
// actually found in the data is counted even if it's since been archived
// from the dropdown, so historical entries are never dropped from reports.
function countFlat(items, options, getValue) {
  const counts = {};
  options.forEach(function (o) { counts[o] = 0; });
  items.forEach(function (item) {
    const value = getValue(item);
    if (!value) return;
    counts[value] = (counts[value] || 0) + 1;
  });
  return counts;
}

function countFlatMulti(items, options, getValues) {
  const counts = {};
  options.forEach(function (o) { counts[o] = 0; });
  items.forEach(function (item) {
    getValues(item).forEach(function (value) {
      if (!value) return;
      counts[value] = (counts[value] || 0) + 1;
    });
  });
  return counts;
}

function sumMinutesFor(entries, values) {
  const set = new Set(values);
  let minutes = 0;
  entries.forEach(function (e) {
    if (e.outreachConducted && set.has(e.outreachConducted)) minutes += (Number(e.durationMinutes) || 0);
  });
  return minutes;
}

function monthCounts(entries) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const counts = {};
  months.forEach(function (m) { counts[m] = 0; });
  entries.forEach(function (e) {
    const d = parseDate(e.referralDate);
    if (d) counts[months[d.getUTCMonth()]]++;
  });
  return counts;
}

function computeDashboard(allEntries, from, to, optionsByGroup) {
  optionsByGroup = optionsByGroup || {};
  function opts(group, fallback) {
    const list = optionsByGroup[group];
    return (list && list.length) ? list : fallback;
  }
  const periodEntries = filterByRange(allEntries, from, to);
  const periodStudents = groupStudents(periodEntries);

  const studentStatus = {
    totalUniqueStudents: periodStudents.length,
    fullTime: periodStudents.filter(function (s) { return s.enrollmentStatus === 'Full Time'; }).length,
    partTime: periodStudents.filter(function (s) { return s.enrollmentStatus === 'Part Time'; }).length,
    notCurrentlyEnrolled: periodStudents.filter(function (s) {
      return ['Voluntary Leave', 'Medical Leave', 'Not Enrolled', 'Alumni'].indexOf(s.enrollmentStatus) !== -1;
    }).length,
    nonAffiliate: periodStudents.filter(function (s) { return s.enrollmentStatus === 'Non Affiliate'; }).length,
    international: periodStudents.filter(function (s) { return s.international === 'Yes'; }).length,
    domestic: periodStudents.filter(function (s) { return s.international === 'No'; }).length,
    inPerson: periodStudents.filter(function (s) { return s.modality === 'In Person'; }).length,
    onlineOnly: periodStudents.filter(function (s) { return s.modality === 'Online Only'; }).length,
    modalityNA: periodStudents.filter(function (s) { return s.modality === 'N/A'; }).length,
  };

  const caseStatusCounts = countFlat(periodStudents, opts('caseStatus', cfg.CASE_STATUS), function (s) { return s.caseStatus; });

  const programResult = countByBucketSingle(periodStudents, cfg.PROGRAM_BUCKETS, function (s) { return s.program; });
  const programDetail = countFlat(periodStudents, opts('program', cfg.PROGRAMS), function (s) { return s.program; });

  const referralSourceResult = countByBucketSingle(periodEntries, cfg.REFERRAL_SOURCE_BUCKETS, function (e) { return e.referralSource; });

  const concernResult = countByBucketMulti(periodEntries, cfg.CONCERN_BUCKETS, function (e) {
    return [e.concernPrimary, e.concernSecondary, e.concernTertiary];
  });

  const hours = {};
  Object.keys(cfg.HOURS_BUCKETS).forEach(function (bucket) {
    hours[bucket] = round2(sumMinutesFor(periodEntries, cfg.HOURS_BUCKETS[bucket]) / 60);
  });
  const totalHours = round2(periodEntries.reduce(function (sum, e) { return sum + (Number(e.durationMinutes) || 0); }, 0) / 60);

  const nabitaResult = countFlat(periodStudents, opts('nabitaRisk', cfg.NABITA), function (s) { return s.nabitaRisk; });

  const referralsMadeCounts = countFlat(periodEntries, opts('referralsMade', cfg.REFERRALS_MADE), function (e) { return e.referralsMade; });

  const referralTypeCounts = countFlatMulti(periodEntries, opts('referralType', cfg.REFERRAL_TYPES), function (e) {
    return [e.referralPrimary, e.referralSecondary, e.referralTertiary];
  });

  const referralDateByMonth = monthCounts(periodEntries);

  const outreachMethodCounts = countFlat(periodEntries, opts('outreachMethod', cfg.OUTREACH_METHOD), function (e) { return e.outreachMethod; });
  const outreachOutcomeCounts = countFlat(periodEntries, opts('outreachOutcome', cfg.OUTREACH_OUTCOME), function (e) { return e.outreachOutcome; });

  return {
    range: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
    totals: {
      uniqueStudents: periodStudents.length,
      totalEntries: periodEntries.length,
      totalHours: totalHours,
      activeCases: caseStatusCounts['Active'] || 0,
    },
    studentStatus: studentStatus,
    caseStatus: caseStatusCounts,
    program: { buckets: programResult.counts, detail: programDetail },
    referralSource: referralSourceResult.counts,
    concerns: concernResult.counts,
    hours: hours,
    totalHours: totalHours,
    caseType: nabitaResult,
    referralsMade: referralsMadeCounts,
    referralType: referralTypeCounts,
    referralDateByMonth: referralDateByMonth,
    outreachMethod: outreachMethodCounts,
    outreachOutcome: outreachOutcomeCounts,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { groupStudents, computeDashboard, filterByRange, entryDate, parseDate };
