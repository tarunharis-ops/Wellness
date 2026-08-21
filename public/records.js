// Student Records: a read-only lookup over the synthetic "Alderbrook
// University" reference dataset (SIS roster joined against Housing, Campus
// Safety, Academic Integrity, and the Web/Anonymous Reporting Portal). This
// is a separate module from the Wellness case tracker above it — same app
// shell and design tokens, own state, own API calls, own DOM subtree.

(function () {
  'use strict';

  function esc(s) { return window.WCT_APP.escapeHtml(s); }
  function fmtDate(v) { return window.WCT_APP.fmtDate(v); }
  function api(path, opts) { return window.WCT_APP.api(path, opts); }

  var RSTATE = { query: '', results: [], searching: false, searched: false, profile: null, activeTab: 'demographics', incidentFilter: 'all' };

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(null, args); }, ms);
    };
  }

  function emptyState(big, small) {
    return '<div class="empty-state"><div class="big">' + esc(big) + '</div><div>' + esc(small) + '</div></div>';
  }

  function initials(first, last) {
    var a = (first || '').trim()[0] || '', b = (last || '').trim()[0] || '';
    return (a + b).toUpperCase() || '?';
  }

  // ---------------- Search / directory ----------------

  function renderSearch(root) {
    root.innerHTML = '' +
      '<div class="page-head"><div><div class="page-title">Student Records</div>' +
      '<div class="page-sub">Synthetic demo roster (Alderbrook University) unifying SIS, Housing, Campus Safety, Academic Integrity, and Web/Anonymous Reports.</div></div></div>' +
      '<div class="records-search-wrap"><input id="recordsSearchInput" type="text" placeholder="Search by student name or ID…" autocomplete="off" value="' + esc(RSTATE.query) + '" /></div>' +
      '<div id="recordsResultsWrap">' + renderResults() + '</div>';

    var input = document.getElementById('recordsSearchInput');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener('input', debounce(function (e) {
      RSTATE.query = e.target.value;
      doSearch();
    }, 200));
    bindResultRows();
  }

  function renderResults() {
    if (!RSTATE.query || RSTATE.query.trim().length < 2) {
      return emptyState('Search 10,000 students', 'Type at least 2 characters of a name or student ID to begin.');
    }
    if (RSTATE.searching) return emptyState('Searching…', '');
    if (!RSTATE.results.length) return emptyState('No matches', 'Try a different name or student ID.');
    var rows = RSTATE.results.map(function (s) {
      return '<tr data-student-id="' + esc(s.studentId) + '">' +
        '<td class="cell-muted">' + esc(s.studentId) + '</td>' +
        '<td class="cell-name">' + esc(s.firstName) + ' ' + esc(s.lastName) + '</td>' +
        '<td class="cell-muted">' + esc(s.major || '—') + '</td>' +
        '<td class="cell-muted">' + esc(s.academicYear || '—') + '</td>' +
        '<td class="cell-muted">' + esc(s.enrollmentStatus || '—') + '</td>' +
      '</tr>';
    }).join('');
    return '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>Student ID</th><th>Name</th><th>Major</th><th>Class</th><th>Enrollment Status</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="audit-meta" style="margin-top:8px">Showing ' + RSTATE.results.length + ' result(s)' + (RSTATE.results.length === 50 ? ' (limited to first 50 — refine your search)' : '') + '.</div>';
  }

  function doSearch() {
    var q = RSTATE.query.trim();
    if (q.length < 2) { RSTATE.results = []; RSTATE.searched = false; refreshResults(); return; }
    RSTATE.searching = true;
    refreshResults();
    api('/api/student-records?q=' + encodeURIComponent(q)).then(function (d) {
      RSTATE.results = d.students;
      RSTATE.searching = false;
      RSTATE.searched = true;
      refreshResults();
    }).catch(function (err) {
      RSTATE.searching = false;
      window.WCT_APP.toast(err.message, 'err');
      refreshResults();
    });
  }

  function refreshResults() {
    var wrap = document.getElementById('recordsResultsWrap');
    if (!wrap) return;
    wrap.innerHTML = renderResults();
    bindResultRows();
  }

  function bindResultRows() {
    document.querySelectorAll('[data-student-id]').forEach(function (tr) {
      tr.addEventListener('click', function () { openProfile(tr.getAttribute('data-student-id')); });
    });
  }

  function openProfile(studentId) {
    RSTATE.profile = null;
    RSTATE.activeTab = 'demographics';
    RSTATE.incidentFilter = 'all';
    window.WCT_APP.setView('recordsProfile');
    api('/api/student-records/' + encodeURIComponent(studentId)).then(function (d) {
      RSTATE.profile = d.profile;
      refreshProfile();
    }).catch(function (err) {
      window.WCT_APP.toast(err.message, 'err');
      window.WCT_APP.setView('recordsSearch');
    });
  }

  // ---------------- Profile ----------------

  function renderProfile(root) {
    root.innerHTML = '<div id="recordsProfileWrap">' + profileBody() + '</div>';
    bindProfileEvents();
  }

  function refreshProfile() {
    var wrap = document.getElementById('recordsProfileWrap');
    if (!wrap) return;
    wrap.innerHTML = profileBody();
    bindProfileEvents();
  }

  var TABS = [
    { key: 'demographics', label: 'Demographics' },
    { key: 'contact', label: 'Contact & Housing' },
    { key: 'incidents', label: 'Incidents & Case Reports' },
    { key: 'resolution', label: 'Resolution & Status' },
    { key: 'priors', label: 'Priors & Case History' },
  ];

  function profileBody() {
    var back = '<div style="margin-bottom:18px"><button class="btn small ghost" id="recordsBackBtn">&larr; Back to Search</button></div>';
    if (!RSTATE.profile) return back + emptyState('Loading…', '');
    var s = RSTATE.profile.student;

    var header = '<div class="card card-pad records-header">' +
      '<div class="records-header-top">' +
        '<div class="records-avatar">' + esc(initials(s.firstName, s.lastName)) + '</div>' +
        '<div>' +
          '<div class="records-name">' + esc(s.firstName) + ' ' + esc(s.lastName) + '</div>' +
          '<div class="records-meta">' + esc(s.studentId) + ' &middot; ' + esc(s.major || 'No major on file') + ' &middot; ' + esc(s.academicYear || '—') +
            ' &middot; <span class="badge ' + enrollmentBadgeClass(s.enrollmentStatus) + '">' + esc(s.enrollmentStatus || '—') + '</span></div>' +
        '</div>' +
      '</div>' +
    '</div>';

    var tabBar = '<div class="filter-bar" style="margin-top:20px">' + TABS.map(function (t) {
      return '<button class="filter-chip' + (RSTATE.activeTab === t.key ? ' active' : '') + '" data-records-tab="' + t.key + '">' + esc(t.label) + '</button>';
    }).join('') + '</div>';

    var body = '<div id="recordsTabBody">' + renderTab(RSTATE.activeTab) + '</div>';

    return back + header + tabBar + body;
  }

  function renderTab(key) {
    if (key === 'demographics') return renderDemographics();
    if (key === 'contact') return renderContactHousing();
    if (key === 'incidents') return renderIncidents();
    if (key === 'resolution') return renderResolution();
    if (key === 'priors') return renderPriors();
    return '';
  }

  function kv(label, value) {
    return '<div class="kv"><div class="kv-label">' + esc(label) + '</div><div class="kv-value">' + (value || '<span class="cell-muted">—</span>') + '</div></div>';
  }

  function renderDemographics() {
    var s = RSTATE.profile.student;
    return '<div class="card card-pad"><div class="kv-grid">' +
      kv('Student ID', esc(s.studentId)) +
      kv('Full Name', esc(s.firstName) + ' ' + esc(s.lastName)) +
      kv('Enrollment Status', esc(s.enrollmentStatus)) +
      kv('Major', esc(s.major)) +
      kv('Academic Year', esc(s.academicYear)) +
      kv('Advisor', esc(s.advisor)) +
      kv('Enrollment Date', fmtDate(s.enrollmentDate)) +
      kv('Date of Birth', fmtDate(s.dob)) +
    '</div></div>';
  }

  function renderContactHousing() {
    var s = RSTATE.profile.student;
    var housing = RSTATE.profile.housing;
    var current = housing.find(function (h) { return h.housingStatus === 'Active' || h.housingStatus === 'Pending Assignment'; });

    var currentBox = current ?
      '<div class="kv-grid">' +
        kv('Residence Hall', esc(current.residenceHall)) +
        kv('Room Number', esc(current.roomNumber)) +
        kv('Housing Status', '<span class="badge ' + housingBadgeClass(current.housingStatus) + '">' + esc(current.housingStatus || '—') + '</span>') +
      '</div>' :
      '<div class="small-muted">Not currently housed.</div>';

    var histRows = housing.map(function (h) {
      return '<tr>' +
        '<td class="cell-name">' + esc(h.residenceHall) + '</td>' +
        '<td class="cell-muted">' + esc(h.roomNumber) + '</td>' +
        '<td class="cell-muted">' + fmtDate(h.moveInDate) + '</td>' +
        '<td class="cell-muted">' + (h.moveOutDate ? fmtDate(h.moveOutDate) : '—') + '</td>' +
        '<td><span class="badge ' + housingBadgeClass(h.housingStatus) + '">' + esc(h.housingStatus || '—') + '</span></td>' +
      '</tr>';
    }).join('');

    return '' +
      '<div class="card card-pad" style="margin-bottom:18px"><div class="dash-section-title">Direct Contact</div><div class="kv-grid">' +
        kv('Email', esc(s.email)) + kv('Phone', esc(s.phone)) + kv('Address', esc(s.address)) +
      '</div></div>' +
      '<div class="card card-pad" style="margin-bottom:18px"><div class="dash-section-title">Current Housing</div>' + currentBox + '</div>' +
      '<div class="dash-section-title">Housing History</div>' +
      '<div class="table-wrap">' + (housing.length ?
        '<table class="data-table"><thead><tr><th>Hall</th><th>Room</th><th>Move In</th><th>Move Out</th><th>Status</th></tr></thead><tbody>' + histRows + '</tbody></table>' :
        emptyState('No housing records', 'This student has no housing history on file.')) + '</div>';
  }

  function renderIncidents() {
    var p = RSTATE.profile;
    var filters = [
      { key: 'all', label: 'All' },
      { key: 'reports', label: 'General Reports (' + p.reports.length + ')' },
      { key: 'campusSafety', label: 'Campus Safety (' + p.campusSafety.length + ')' },
      { key: 'academicIntegrity', label: 'Academic Integrity (' + p.academicIntegrity.length + ')' },
    ];
    var chips = filters.map(function (f) {
      return '<button class="filter-chip' + (RSTATE.incidentFilter === f.key ? ' active' : '') + '" data-incident-filter="' + f.key + '">' + esc(f.label) + '</button>';
    }).join('');

    var cards = [];
    if (RSTATE.incidentFilter === 'all' || RSTATE.incidentFilter === 'reports') {
      p.reports.forEach(function (r) {
        cards.push(incidentCard('General Report', r.reportId, fmtDate(r.submittedDate), [
          ['Category', r.category], ['Priority', '<span class="badge ' + priorityBadgeClass(r.priority) + '">' + esc(r.priority || '—') + '</span>'],
          ['Location', r.location], ['Reporter Type', r.reporterType], ['Anonymous', r.anonymous ? 'Yes' : 'No'],
        ], r.description));
      });
    }
    if (RSTATE.incidentFilter === 'all' || RSTATE.incidentFilter === 'campusSafety') {
      p.campusSafety.forEach(function (r) {
        cards.push(incidentCard('Campus Safety', r.reportId, fmtDate(r.incidentDate), [
          ['Incident Type', r.incidentType], ['Severity', '<span class="badge ' + severityBadgeClass(r.severity) + '">' + esc(r.severity || '—') + '</span>'],
          ['Location', r.location], ['Status', '<span class="badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || '—') + '</span>'],
        ], r.narrative));
      });
    }
    if (RSTATE.incidentFilter === 'all' || RSTATE.incidentFilter === 'academicIntegrity') {
      p.academicIntegrity.forEach(function (r) {
        cards.push(incidentCard('Academic Integrity', r.caseId, fmtDate(r.incidentDate), [
          ['Violation Type', r.violationType], ['Severity', '<span class="badge ' + severityBadgeClass(r.severity) + '">' + esc(r.severity || '—') + '</span>'],
          ['Course', (r.courseCode || '') + (r.courseName ? ' — ' + r.courseName : '')], ['Faculty', r.facultyName],
          ['Status', '<span class="badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || '—') + '</span>'],
        ], r.description));
      });
    }

    return '<div class="filter-bar">' + chips + '</div>' +
      '<div class="records-incident-list">' + (cards.length ? cards.join('') : emptyState('No incidents', 'Nothing on file for this category.')) + '</div>';
  }

  function incidentCard(sourceLabel, id, date, fields, narrative) {
    var fieldsHtml = fields.map(function (f) {
      return '<div class="incident-field"><span class="incident-field-label">' + esc(f[0]) + '</span><span>' + (f[1] || '<span class="cell-muted">—</span>') + '</span></div>';
    }).join('');
    return '<div class="card card-pad" style="margin-bottom:14px">' +
      '<div class="flex-between"><div class="dash-section-title" style="margin-bottom:2px">' + esc(sourceLabel) + ' <span class="hint">' + esc(id) + '</span></div><div class="small-muted">' + date + '</div></div>' +
      '<div class="incident-field-grid">' + fieldsHtml + '</div>' +
      (narrative ? '<div class="timeline-notes" style="margin-top:10px">' + esc(narrative) + '</div>' : '') +
    '</div>';
  }

  function renderResolution() {
    var rows = [];
    RSTATE.profile.campusSafety.forEach(function (r) {
      rows.push({ source: 'Campus Safety', id: r.reportId, charge: r.incidentType, status: r.status, severity: r.severity, date: r.incidentDate });
    });
    RSTATE.profile.academicIntegrity.forEach(function (r) {
      rows.push({ source: 'Academic Integrity', id: r.caseId, charge: r.violationType, status: r.status, severity: r.severity, date: r.incidentDate });
    });
    rows.sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });

    if (!rows.length) return emptyState('No adjudicated cases', 'This student has no Campus Safety or Academic Integrity cases on file.');

    var trs = rows.map(function (r) {
      return '<tr>' +
        '<td class="cell-muted">' + esc(r.source) + '</td>' +
        '<td class="cell-muted">' + esc(r.id) + '</td>' +
        '<td class="cell-name">' + esc(r.charge || '—') + '</td>' +
        '<td><span class="badge ' + statusBadgeClass(r.status) + '">' + esc(r.status || '—') + '</span></td>' +
        '<td><span class="badge ' + severityBadgeClass(r.severity) + '">' + esc(r.severity || '—') + '</span></td>' +
        '<td class="cell-muted">' + fmtDate(r.date) + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>Source</th><th>ID</th><th>Charge / Violation</th><th>Status</th><th>Severity</th><th>Date</th>' +
      '</tr></thead><tbody>' + trs + '</tbody></table></div>';
  }

  function renderPriors() {
    var p = RSTATE.profile;
    var stats = '<div class="stat-grid">' +
      statCard('General Reports', p.reports.length) +
      statCard('Campus Safety Flags', p.campusSafety.length) +
      statCard('Academic Integrity Violations', p.academicIntegrity.length) +
    '</div>';

    var events = [];
    p.housing.forEach(function (h) {
      if (h.moveInDate) events.push({ date: h.moveInDate, label: 'Moved into ' + (h.residenceHall || 'housing') + (h.roomNumber ? ' · Room ' + h.roomNumber : ''), tag: 'Housing' });
      if (h.moveOutDate) events.push({ date: h.moveOutDate, label: 'Moved out of ' + (h.residenceHall || 'housing'), tag: 'Housing' });
    });
    p.campusSafety.forEach(function (r) {
      events.push({ date: r.incidentDate, label: r.incidentType || 'Campus Safety incident', tag: 'Campus Safety', notes: r.narrative, badges: [r.severity ? { cls: severityBadgeClass(r.severity), text: r.severity } : null, r.status ? { cls: statusBadgeClass(r.status), text: r.status } : null] });
    });
    p.academicIntegrity.forEach(function (r) {
      events.push({ date: r.incidentDate, label: r.violationType || 'Academic Integrity case', tag: 'Academic Integrity', notes: r.description, badges: [r.severity ? { cls: severityBadgeClass(r.severity), text: r.severity } : null, r.status ? { cls: statusBadgeClass(r.status), text: r.status } : null] });
    });
    p.reports.forEach(function (r) {
      events.push({ date: r.submittedDate, label: r.category || 'General report', tag: 'Web Report', notes: r.description, badges: [r.priority ? { cls: priorityBadgeClass(r.priority), text: r.priority } : null] });
    });
    events = events.filter(function (e) { return e.date; });
    events.sort(function (a, b) { return a.date < b.date ? 1 : -1; });

    var items = events.map(function (e) {
      var badges = (e.badges || []).filter(Boolean).map(function (b) { return '<span class="badge ' + b.cls + '" style="margin-left:6px">' + esc(b.text) + '</span>'; }).join('');
      return '<div class="timeline-item">' +
        '<div class="timeline-date">' + fmtDate(e.date) + ' <span class="tag" style="margin-left:6px">' + esc(e.tag) + '</span></div>' +
        '<div class="timeline-body">' + esc(e.label) + badges + '</div>' +
        (e.notes ? '<div class="timeline-notes">' + esc(e.notes) + '</div>' : '') +
      '</div>';
    }).join('');

    return stats +
      '<div class="dash-section-title">Unified Chronological Timeline</div>' +
      '<div class="timeline">' + (items || emptyState('No history on file', 'This student has no incidents, violations, or housing records.')) + '</div>';
  }

  function statCard(label, value) {
    return '<div class="card stat-card"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + value + '</div></div>';
  }

  // ---------------- Badge color mapping ----------------

  function severityBadgeClass(v) {
    if (v === 'Low' || v === 'Minor') return 'badge-mild';
    if (v === 'Medium' || v === 'Moderate') return 'badge-moderate';
    if (v === 'High' || v === 'Serious') return 'badge-elevated';
    if (v === 'Critical' || v === 'Severe') return 'badge-critical';
    return 'badge-neutral';
  }
  function statusBadgeClass(v) {
    if (v === 'Open' || v === 'Under Investigation' || v === 'Pending Review') return 'badge-monitoring';
    if (v === 'Referred to Conduct Board' || v === 'Appealed') return 'badge-elevated';
    if (v === 'Closed' || v === 'Resolved - No Violation Found' || v === 'Resolved - Sanction Issued') return 'badge-closed';
    return 'badge-neutral';
  }
  function priorityBadgeClass(v) {
    if (v === 'Low') return 'badge-mild';
    if (v === 'Medium') return 'badge-moderate';
    if (v === 'High') return 'badge-elevated';
    if (v === 'Urgent') return 'badge-critical';
    return 'badge-neutral';
  }
  function housingBadgeClass(v) {
    if (v === 'Active') return 'badge-active';
    if (v === 'Pending Assignment') return 'badge-monitoring';
    if (v === 'Moved Out') return 'badge-closed';
    return 'badge-neutral';
  }
  function enrollmentBadgeClass(v) {
    if (v === 'Enrolled') return 'badge-active';
    if (v === 'Leave of Absence') return 'badge-monitoring';
    if (v === 'Graduated') return 'badge-closed';
    if (v === 'Withdrawn') return 'badge-closed';
    return 'badge-neutral';
  }

  function bindProfileEvents() {
    var backBtn = document.getElementById('recordsBackBtn');
    if (backBtn) backBtn.addEventListener('click', function () { window.WCT_APP.setView('recordsSearch'); });
    document.querySelectorAll('[data-records-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { RSTATE.activeTab = btn.getAttribute('data-records-tab'); refreshProfile(); });
    });
    document.querySelectorAll('[data-incident-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () { RSTATE.incidentFilter = btn.getAttribute('data-incident-filter'); refreshProfile(); });
    });
  }

  window.WCT_RECORDS = { renderSearch: renderSearch, renderProfile: renderProfile };
})();
