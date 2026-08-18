(function () {
  'use strict';

  function getFields() { return window.WELLNESS_CONFIG.FIELDS; }
  function getSections() { return window.WELLNESS_CONFIG.SECTIONS; }
  function getFieldMap() {
    var m = {};
    getFields().forEach(function (f) { m[f.key] = f; });
    return m;
  }

  function reloadConfig() {
    return new Promise(function (resolve) {
      var old = document.getElementById('wellnessConfigScript');
      if (old) old.parentNode.removeChild(old);
      var s = document.createElement('script');
      s.id = 'wellnessConfigScript';
      s.src = '/config.js?t=' + Date.now();
      s.onload = resolve;
      document.head.appendChild(s);
    });
  }

  var STATE = {
    currentUser: null,
    view: 'log',
    entries: [],
    students: [],
    search: '',
    filters: { caseStatus: '', nabitaRisk: '' },
    sort: { key: 'outreachDate', dir: 'desc' },
    dashboard: null,
    dashRangeMode: 'all',
    dashFrom: '',
    dashTo: '',
    drawerMode: null,
    editingId: null,
    linkedStudentPrefill: null,
    team: { users: [], invites: [] },
    template: { groups: [] },
  };

  // ---------------- API ----------------
  function api(pathname, opts) {
    opts = opts || {};
    return fetch(pathname, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (res.status === 401) { window.location.reload(); throw new Error('Session expired'); }
      return res.json().then(function (data) {
        if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data: data });
        return data;
      });
    });
  }

  function loadAll() {
    return Promise.all([
      api('/api/entries').then(function (d) { STATE.entries = d.entries; }),
      api('/api/students').then(function (d) { STATE.students = d.students; }),
    ]).then(loadDashboard);
  }

  function loadDashboard() {
    var qs = '';
    var range = computeDashRange();
    if (range.from || range.to) {
      qs = '?' + [range.from ? 'from=' + encodeURIComponent(range.from) : '', range.to ? 'to=' + encodeURIComponent(range.to) : ''].filter(Boolean).join('&');
    }
    return api('/api/dashboard' + qs).then(function (d) { STATE.dashboard = d; });
  }

  // ---------------- Helpers ----------------
  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Date-only fields (referralDate/outreachDate) come back from Postgres as
  // UTC-midnight timestamps. Reading them with local getters can shift the
  // displayed day depending on the browser's timezone, so read/format in UTC.
  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function toInputDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + mm + '-' + dd;
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    if (!parts[0]) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function caseStatusBadgeClass(status) {
    if (status === 'Active') return 'badge-active';
    if (status === 'Monitoring') return 'badge-monitoring';
    if (status === 'Closed') return 'badge-closed';
    return 'badge-neutral';
  }
  function riskBadgeClass(risk) {
    if (risk === 'Mild') return 'badge-mild';
    if (risk === 'Moderate') return 'badge-moderate';
    if (risk === 'Elevated') return 'badge-elevated';
    if (risk === 'Critical') return 'badge-critical';
    return 'badge-neutral';
  }

  function toast(msg, kind) {
    var stack = document.getElementById('toastStack');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .2s ease';
      el.style.opacity = '0';
      setTimeout(function () { stack.removeChild(el); }, 200);
    }, 2600);
  }

  // ---------------- Semester / date range ----------------
  function semesterLabel(date) {
    var m = date.getMonth() + 1, y = date.getFullYear();
    if (m >= 8) return 'Fall ' + y;
    if (m <= 5) return 'Spring ' + y;
    return 'Summer ' + y;
  }
  function semesterRange(date) {
    var m = date.getMonth() + 1, y = date.getFullYear();
    if (m >= 8) return { from: y + '-08-01', to: y + '-12-31' };
    if (m <= 5) return { from: y + '-01-01', to: y + '-05-31' };
    return { from: y + '-06-01', to: y + '-07-31' };
  }
  function computeDashRange() {
    if (STATE.dashRangeMode === 'all') return { from: '', to: '' };
    if (STATE.dashRangeMode === 'semester') return semesterRange(new Date());
    if (STATE.dashRangeMode === 'year') { var y = new Date().getFullYear(); return { from: y + '-01-01', to: y + '-12-31' }; }
    if (STATE.dashRangeMode === 'custom') return { from: STATE.dashFrom, to: STATE.dashTo };
    return { from: '', to: '' };
  }

  // ---------------- Rendering shell ----------------
  function setView(view) {
    STATE.view = view;
    document.querySelectorAll('.nav-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-view') === view);
    });
    render();
  }

  function render() {
    var root = document.getElementById('view-root');
    var footer = document.getElementById('entryCountFooter');
    footer.textContent = STATE.entries.length + ' entries · ' + STATE.students.length + ' students';
    if (STATE.view === 'log') root.innerHTML = renderLogView();
    else if (STATE.view === 'students') root.innerHTML = renderStudentsView();
    else if (STATE.view === 'dashboard') root.innerHTML = renderDashboardView();
    else if (STATE.view === 'team') { root.innerHTML = renderTeamView(); loadTeamData(); }
    else if (STATE.view === 'template') { root.innerHTML = renderTemplateView(); loadTemplateData(); }
    bindViewEvents();
  }

  // ---------------- Log view ----------------
  function filteredEntries() {
    var q = STATE.search.trim().toLowerCase();
    var list = STATE.entries.filter(function (e) {
      if (STATE.filters.caseStatus && e.caseStatus !== STATE.filters.caseStatus) return false;
      if (STATE.filters.nabitaRisk && e.nabitaRisk !== STATE.filters.nabitaRisk) return false;
      if (!q) return true;
      var hay = [e.firstName, e.lastName, e.notes, e.program, e.concernPrimary, e.concernSecondary].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var key = STATE.sort.key, dir = STATE.sort.dir === 'asc' ? 1 : -1;
    list.sort(function (a, b) {
      var av = a[key] || '', bv = b[key] || '';
      if (key === 'outreachDate' || key === 'referralDate' || key === 'createdAt') {
        av = av ? new Date(av).getTime() : 0;
        bv = bv ? new Date(bv).getTime() : 0;
      } else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return list;
  }

  function renderLogView() {
    var list = filteredEntries();
    var rows = list.map(function (e) {
      return '<tr data-id="' + e.id + '">' +
        '<td><span class="badge ' + caseStatusBadgeClass(e.caseStatus) + '">' + escapeHtml(e.caseStatus || '—') + '</span></td>' +
        '<td class="cell-name">' + escapeHtml(e.firstName) + ' ' + escapeHtml(e.lastName) + '</td>' +
        '<td class="cell-muted">' + escapeHtml(e.program || '—') + '</td>' +
        '<td><span class="badge ' + riskBadgeClass(e.nabitaRisk) + '">' + escapeHtml(e.nabitaRisk || '—') + '</span></td>' +
        '<td class="cell-muted">' + escapeHtml(e.outreachConducted || '—') + '</td>' +
        '<td class="cell-muted">' + fmtDate(e.outreachDate) + '</td>' +
        '<td class="cell-muted">' + (e.durationMinutes !== '' && e.durationMinutes !== undefined ? e.durationMinutes + ' min' : '—') + '</td>' +
        '<td class="cell-muted">' + escapeHtml(e.concernPrimary || '—') + '</td>' +
        '<td class="cell-muted">' + escapeHtml(e.createdByName || '—') + '</td>' +
        '</tr>';
    }).join('');

    return '' +
      '<div class="page-head">' +
        '<div><div class="page-title">Case Log</div><div class="page-sub">Shared with your whole team — click a row to edit.</div></div>' +
      '</div>' +
      '<div class="filter-bar">' +
        filterChips('caseStatus', optionsFor('caseStatus'), STATE.filters.caseStatus) +
        '<span style="width:1px;height:20px;background:var(--border);margin:0 4px;"></span>' +
        filterChips('nabitaRisk', optionsFor('nabitaRisk'), STATE.filters.nabitaRisk) +
      '</div>' +
      '<div class="table-wrap">' +
        (list.length ? (
        '<table class="data-table">' +
          '<thead><tr>' +
            th('caseStatus', 'Status') + th('lastName', 'Student') + th('program', 'Program') +
            th('nabitaRisk', 'Risk') + th('outreachConducted', 'Outreach') + th('outreachDate', 'Date') +
            th('durationMinutes', 'Duration') + th('concernPrimary', 'Primary Concern') + '<th>Logged By</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>') : emptyState('No entries match your filters', 'Try clearing filters or add a new entry.')) +
      '</div>';
  }

  function th(key, label) {
    var active = STATE.sort.key === key;
    var arrow = active ? (STATE.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    return '<th data-sort="' + key + '">' + label + arrow + '</th>';
  }

  function filterChips(field, options, current) {
    var all = '<button class="filter-chip' + (!current ? ' active' : '') + '" data-filter="' + field + '" data-value="">All</button>';
    var chips = options.map(function (o) {
      return '<button class="filter-chip' + (current === o ? ' active' : '') + '" data-filter="' + field + '" data-value="' + escapeHtml(o) + '">' + escapeHtml(o) + '</button>';
    }).join('');
    return all + chips;
  }

  function emptyState(big, small) {
    return '<div class="empty-state"><div class="big">' + escapeHtml(big) + '</div><div>' + escapeHtml(small) + '</div></div>';
  }

  function optionsFor(fieldKey) {
    var f = getFieldMap()[fieldKey];
    return f ? f.options : [];
  }

  // ---------------- Students view ----------------
  function renderStudentsView() {
    var q = STATE.search.trim().toLowerCase();
    var list = STATE.students.filter(function (s) {
      if (!q) return true;
      return (s.firstName + ' ' + s.lastName + ' ' + (s.program || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) {
      return '<div class="page-head"><div><div class="page-title">Students</div><div class="page-sub">Grouped case history, one card per student.</div></div></div>' +
        emptyState('No students yet', 'Add your first entry to get started.');
    }
    var cards = list.map(function (s) {
      return '<div class="card student-card" data-student="' + escapeHtml(s.studentKey) + '">' +
        '<div class="student-card-head">' +
          '<div><div class="student-name">' + escapeHtml(s.firstName) + ' ' + escapeHtml(s.lastName) + '</div>' +
          '<div class="student-meta">' + escapeHtml(s.program || 'No program on file') + (s.pronouns ? ' · ' + escapeHtml(s.pronouns) : '') + '</div></div>' +
          '<span class="badge ' + caseStatusBadgeClass(s.caseStatus) + '">' + escapeHtml(s.caseStatus || '—') + '</span>' +
        '</div>' +
        '<div class="student-meta">' + escapeHtml(s.enrollmentStatus || '—') + ' · ' + escapeHtml(s.modality || '—') + (s.international === 'Yes' ? ' · International' : '') + '</div>' +
        '<div class="student-stats">' +
          '<div class="student-stat"><b>' + s.entryCount + '</b>entries</div>' +
          '<div class="student-stat"><b>' + Math.round(s.totalMinutes) + '</b>minutes logged</div>' +
          '<div class="student-stat"><b><span class="badge ' + riskBadgeClass(s.nabitaRisk) + '">' + escapeHtml(s.nabitaRisk || '—') + '</span></b></div>' +
          '<div class="student-stat" style="margin-left:auto"><b>' + fmtDate(s.lastContact) + '</b>last contact</div>' +
        '</div>' +
      '</div>';
    }).join('');
    return '<div class="page-head"><div><div class="page-title">Students</div><div class="page-sub">' + list.length + ' students · click a card for full case history.</div></div></div>' +
      '<div class="student-grid">' + cards + '</div>';
  }

  // ---------------- Dashboard view ----------------
  function barList(counts, opts) {
    opts = opts || {};
    var entries = Object.keys(counts).map(function (k) { return [k, counts[k]]; });
    entries.sort(function (a, b) { return b[1] - a[1]; });
    var max = Math.max.apply(null, entries.map(function (e) { return e[1]; }).concat([1]));
    var limit = opts.limit || entries.length;
    var shown = entries.slice(0, limit);
    var rows = shown.map(function (e) {
      var pct = Math.round((e[1] / max) * 100);
      return '<div class="bar-row"><span class="bar-label">' + escapeHtml(e[0]) + '</span><span class="bar-count">' + e[1] + '</span>' +
        '<div class="bar-track"><div class="bar-fill' + (opts.cls ? ' ' + opts.cls : '') + '" style="width:' + pct + '%"></div></div></div>';
    }).join('');
    var more = entries.length > limit ? '<div class="small-muted show-more-toggle">+ ' + (entries.length - limit) + ' more not shown</div>' : '';
    return '<div class="bar-list">' + rows + '</div>' + more;
  }

  function monthChart(counts) {
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var short = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var max = Math.max.apply(null, months.map(function (m) { return counts[m] || 0; }).concat([1]));
    var cols = months.map(function (m, i) {
      var v = counts[m] || 0;
      var h = Math.max(2, Math.round((v / max) * 100));
      return '<div class="month-col"><div class="month-val">' + (v || '') + '</div><div class="month-bar" style="height:' + h + '%"></div><div class="month-label">' + short[i] + '</div></div>';
    }).join('');
    return '<div class="month-grid">' + cols + '</div>';
  }

  function dashCard(title, hint, bodyHtml) {
    return '<div class="card card-pad">' +
      '<div class="dash-section-title">' + escapeHtml(title) + (hint ? ' <span class="hint">' + escapeHtml(hint) + '</span>' : '') + '</div>' +
      bodyHtml + '</div>';
  }

  function renderDashboardView() {
    var d = STATE.dashboard;
    if (!d) return emptyState('Loading…', '');
    var rangeLabel = STATE.dashRangeMode === 'all' ? 'All time' :
      STATE.dashRangeMode === 'semester' ? semesterLabel(new Date()) + ' (auto)' :
      STATE.dashRangeMode === 'year' ? new Date().getFullYear() + ' (calendar year)' : 'Custom range';

    var modeBtn = function (mode, label) {
      return '<button class="filter-chip' + (STATE.dashRangeMode === mode ? ' active' : '') + '" data-dashmode="' + mode + '">' + label + '</button>';
    };
    var customInputs = STATE.dashRangeMode === 'custom' ?
      '<input type="date" id="dashFrom" value="' + escapeHtml(STATE.dashFrom) + '" /><span class="small-muted">to</span><input type="date" id="dashTo" value="' + escapeHtml(STATE.dashTo) + '" />' : '';

    return '' +
      '<div class="page-head"><div><div class="page-title">Dashboard</div><div class="page-sub">' + escapeHtml(rangeLabel) + '</div></div></div>' +
      '<div class="filter-bar">' + modeBtn('all', 'All Time') + modeBtn('semester', 'This Semester') + modeBtn('year', 'This Year') + modeBtn('custom', 'Custom Range') + customInputs + '</div>' +
      '<div class="stat-grid">' +
        statCard('Unique Students', d.totals.uniqueStudents, 'in selected period') +
        statCard('Active Cases', d.totals.activeCases, 'case status = Active') +
        statCard('Total Entries Logged', d.totals.totalEntries, '') +
        statCard('Wellness Hours', d.totalHours, 'total logged, all categories') +
      '</div>' +
      '<div class="dash-grid">' +
        dashCard('Student Status', 'unique students, most recent record', studentStatusBody(d.studentStatus)) +
        dashCard('Case Status', 'unique students, current status', barList(d.caseStatus, { cls: 'success' })) +
        dashCard('Program Breakdown', 'MS Degree Seeking vs. Non-Degree', barList(d.program.buckets)) +
        dashCard('Case Type — NABITA Risk Rubric', 'unique students, current risk level', barList(d.caseType, { cls: 'danger' })) +
        dashCard('Referral Source', 'every logged entry', barList(d.referralSource)) +
        dashCard('Referrals Made', 'Columbia / External / Both', barList(d.referralsMade)) +
        dashCard('Wellness Hours by Category', 'minutes ÷ 60, every logged entry', hoursBody(d.hours, d.totalHours)) +
        dashCard('Outreach Method', 'every logged entry', barList(d.outreachMethod, { limit: 7 })) +
      '</div>' +
      '<div class="dash-section-title" style="margin-top:6px">Wellness Concern Category <span class="hint">counts every Primary + Secondary + Tertiary concern logged</span></div>' +
      '<div class="card card-pad" style="margin-bottom:22px">' + barList(d.concerns) + '</div>' +
      '<div class="dash-section-title">Referral Type <span class="hint">where cases were referred to — every logged entry</span></div>' +
      '<div class="card card-pad" style="margin-bottom:22px">' + barList(d.referralType, { limit: 12 }) + '</div>' +
      '<div class="dash-section-title">Referral Date by Month <span class="hint">referral date, selected period</span></div>' +
      '<div class="card card-pad">' + monthChart(d.referralDateByMonth) + '</div>';
  }

  function statCard(label, value, foot) {
    return '<div class="card stat-card"><div class="stat-label">' + escapeHtml(label) + '</div><div class="stat-value">' + value + '</div><div class="stat-foot">' + escapeHtml(foot) + '</div></div>';
  }

  function studentStatusBody(s) {
    var counts = {
      'Full-Time': s.fullTime, 'Part-Time': s.partTime, 'Not Currently Enrolled': s.notCurrentlyEnrolled, 'Non-Affiliate': s.nonAffiliate,
      'International': s.international, 'Domestic': s.domestic,
      'In Person': s.inPerson, 'Online Only': s.onlineOnly, 'Mode N/A': s.modalityNA,
    };
    return barList(counts);
  }

  function hoursBody(hours, total) {
    return barList(hours, { cls: 'success' }) + '<div class="section-divider"></div><div class="flex-between"><span class="small-muted">Total</span><b>' + total + ' hrs</b></div>';
  }

  // ---------------- Drawer: entry form ----------------
  function fieldInputHtml(f, value) {
    value = value === undefined || value === null ? '' : value;
    var req = f.required ? '<span class="required-mark">*</span>' : '';
    var label = '<label>' + escapeHtml(f.label) + req + '</label>';
    var input;
    if (f.type === 'select') {
      var opts = '<option value="">— Select —</option>' + f.options.map(function (o) {
        return '<option value="' + escapeHtml(o) + '"' + (o === value ? ' selected' : '') + '>' + escapeHtml(o) + '</option>';
      }).join('');
      input = '<select name="' + f.key + '"' + (f.required ? ' required' : '') + '>' + opts + '</select>';
    } else if (f.type === 'textarea') {
      input = '<textarea name="' + f.key + '">' + escapeHtml(value) + '</textarea>';
    } else if (f.type === 'date') {
      input = '<input type="date" name="' + f.key + '" value="' + escapeHtml(toInputDate(value)) + '" />';
    } else if (f.type === 'number') {
      input = '<input type="number" min="0" step="1" name="' + f.key + '" value="' + escapeHtml(value) + '" />';
    } else {
      input = '<input type="text" name="' + f.key + '" value="' + escapeHtml(value) + '"' + (f.required ? ' required' : '') + ' />';
    }
    var full = (f.type === 'textarea') ? ' full' : '';
    return '<div class="form-field' + full + '">' + label + input + '</div>';
  }

  function entryFormHtml(entry, isNew) {
    var sectionsHtml = getSections().map(function (sec) {
      var fields = getFields().filter(function (f) { return f.section === sec.key; });
      var html = fields.map(function (f) { return fieldInputHtml(f, entry ? entry[f.key] : (f.default || '')); }).join('');
      return '<div class="form-section"><div class="form-section-title">' + escapeHtml(sec.label) + '</div><div class="form-grid">' + html + '</div></div>';
    }).join('');

    var linkBox = '';
    if (isNew) {
      linkBox = '<div class="linked-student-box">' +
        '<div class="lbl">Link to an existing student (optional)</div>' +
        '<div class="autocomplete-wrap">' +
          '<input type="text" id="studentSearch" placeholder="Type a student name to reuse their details, or leave blank for a new student" autocomplete="off" />' +
          '<div id="autocompleteList"></div>' +
        '</div>' +
      '</div>';
    }

    return '<form id="entryForm"><div id="formErrors"></div>' + linkBox + sectionsHtml + '</form>';
  }

  function openEntryDrawer(entryId) {
    var isNew = !entryId;
    var entry = isNew ? Object.assign({}, STATE.linkedStudentPrefill || {}) : STATE.entries.find(function (e) { return e.id === entryId; });
    STATE.editingId = isNew ? null : entryId;
    STATE.drawerMode = 'entry';

    var drawer = document.getElementById('drawer');
    var attribution = (!isNew && (entry.createdByName || entry.updatedByName)) ?
      '<div class="drawer-sub">Logged by ' + escapeHtml(entry.createdByName || '—') + (entry.updatedByName && entry.updatedByName !== entry.createdByName ? ' · last edited by ' + escapeHtml(entry.updatedByName) : '') + '</div>' : '';

    drawer.innerHTML = '' +
      '<div class="drawer-head">' +
        '<div><div class="drawer-title">' + (isNew ? 'New Entry' : 'Edit Entry') + '</div>' +
        (isNew ? '<div class="drawer-sub">Mirrors copying row 2 and filling it in for a new interaction.</div>' : '<div class="drawer-sub">' + escapeHtml((entry.firstName || '') + ' ' + (entry.lastName || '')) + '</div>' + attribution) +
        '</div>' +
        '<button class="drawer-close" id="drawerClose">&times;</button>' +
      '</div>' +
      '<div class="drawer-body">' + entryFormHtml(entry, isNew) + '</div>' +
      '<div class="drawer-foot">' +
        (isNew ? '<span></span>' : '<button class="btn danger" id="deleteEntryBtn">Delete Entry</button>') +
        '<div style="display:flex;gap:8px"><button class="btn" id="cancelEntryBtn">Cancel</button><button class="btn primary" id="saveEntryBtn">' + (isNew ? 'Create Entry' : 'Save Changes') + '</button></div>' +
      '</div>';

    openDrawer();
    bindEntryFormEvents(isNew);
  }

  function bindEntryFormEvents(isNew) {
    if (isNew) {
      var searchInput = document.getElementById('studentSearch');
      var listEl = document.getElementById('autocompleteList');
      searchInput.addEventListener('input', debounce(function () {
        var q = searchInput.value.trim().toLowerCase();
        if (!q) { listEl.innerHTML = ''; return; }
        var matches = STATE.students.filter(function (s) { return (s.firstName + ' ' + s.lastName).toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
        if (!matches.length) { listEl.innerHTML = ''; return; }
        listEl.className = 'autocomplete-list';
        listEl.innerHTML = matches.map(function (s) {
          return '<div class="autocomplete-item" data-key="' + escapeHtml(s.studentKey) + '"><div>' + escapeHtml(s.firstName) + ' ' + escapeHtml(s.lastName) + '</div><div class="sub">' + escapeHtml(s.program || 'No program on file') + '</div></div>';
        }).join('');
        listEl.querySelectorAll('.autocomplete-item').forEach(function (item) {
          item.addEventListener('click', function () {
            var s = STATE.students.find(function (x) { return x.studentKey === item.getAttribute('data-key'); });
            fillIdentityFields(s);
            listEl.innerHTML = '';
            listEl.className = '';
            searchInput.value = s.firstName + ' ' + s.lastName;
          });
        });
      }, 150));
    }
    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    document.getElementById('cancelEntryBtn').addEventListener('click', closeDrawer);
    document.getElementById('saveEntryBtn').addEventListener('click', submitEntryForm);
    var delBtn = document.getElementById('deleteEntryBtn');
    if (delBtn) delBtn.addEventListener('click', function () { deleteEntry(STATE.editingId); });
  }

  function fillIdentityFields(s) {
    ['firstName', 'lastName', 'pronouns', 'international', 'program', 'modality', 'enrollmentStatus', 'columbiaOfficer'].forEach(function (key) {
      var el = document.querySelector('[name="' + key + '"]');
      if (el) el.value = s[key] || '';
    });
  }

  function collectFormData() {
    var form = document.getElementById('entryForm');
    var data = {};
    getFields().forEach(function (f) {
      var el = form.querySelector('[name="' + f.key + '"]');
      data[f.key] = el ? el.value : '';
    });
    return data;
  }

  function submitEntryForm() {
    var data = collectFormData();
    var errBox = document.getElementById('formErrors');
    errBox.innerHTML = '';
    var missing = getFields().filter(function (f) { return f.required && !data[f.key]; });
    if (missing.length) {
      errBox.innerHTML = '<div class="form-errors">Please fill in: ' + missing.map(function (f) { return f.label; }).join(', ') + '</div>';
      return;
    }
    var req = STATE.editingId ? api('/api/entries/' + STATE.editingId, { method: 'PUT', body: data }) : api('/api/entries', { method: 'POST', body: data });
    req.then(function () {
      toast(STATE.editingId ? 'Entry updated' : 'Entry created', 'ok');
      closeDrawer();
      return loadAll();
    }).then(render).catch(function (err) {
      errBox.innerHTML = '<div class="form-errors">' + escapeHtml((err.data && err.data.errors ? err.data.errors.join(', ') : err.message)) + '</div>';
    });
  }

  function deleteEntry(id) {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    api('/api/entries/' + id, { method: 'DELETE' }).then(function () {
      toast('Entry deleted', 'ok');
      closeDrawer();
      return loadAll();
    }).then(render);
  }

  // ---------------- Drawer: student detail ----------------
  function openStudentDrawer(studentKey) {
    var s = STATE.students.find(function (x) { return x.studentKey === studentKey; });
    if (!s) return;
    STATE.drawerMode = 'student';
    var drawer = document.getElementById('drawer');

    var items = s.entries.map(function (e) {
      var tags = [e.outreachConducted, e.concernPrimary, e.referralSource].filter(Boolean);
      return '<div class="timeline-item">' +
        '<div class="timeline-date">' + fmtDate(e.outreachDate || e.referralDate || e.createdAt) + ' · <span class="badge ' + caseStatusBadgeClass(e.caseStatus) + '" style="margin-left:2px">' + escapeHtml(e.caseStatus || '—') + '</span></div>' +
        '<div class="timeline-body">' + escapeHtml(e.outreachType || '') + (e.outreachMethod ? ' via ' + escapeHtml(e.outreachMethod) : '') + (e.durationMinutes ? ' · ' + e.durationMinutes + ' min' : '') + '</div>' +
        '<div class="timeline-tags">' + tags.map(function (t) { return '<span class="tag">' + escapeHtml(t) + '</span>'; }).join('') + '</div>' +
        (e.notes ? '<div class="timeline-notes">' + escapeHtml(e.notes) + '</div>' : '') +
        '<div class="timeline-notes">Logged by ' + escapeHtml(e.createdByName || '—') + '</div>' +
        '<div class="timeline-actions"><button class="btn small" data-edit-entry="' + e.id + '">Edit</button></div>' +
      '</div>';
    }).join('');

    drawer.innerHTML = '' +
      '<div class="drawer-head">' +
        '<div><div class="drawer-title">' + escapeHtml(s.firstName) + ' ' + escapeHtml(s.lastName) + '</div>' +
        '<div class="drawer-sub">' + escapeHtml(s.program || 'No program on file') + (s.pronouns ? ' · ' + escapeHtml(s.pronouns) : '') + '</div></div>' +
        '<button class="drawer-close" id="drawerClose">&times;</button>' +
      '</div>' +
      '<div class="drawer-body">' +
        '<div class="stat-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:18px">' +
          statCard('Entries', s.entryCount, '') + statCard('Minutes Logged', Math.round(s.totalMinutes), '') + statCard('Current Risk', s.nabitaRisk || '—', '') +
        '</div>' +
        '<div class="dash-section-title">Case History</div>' +
        '<div class="timeline">' + items + '</div>' +
      '</div>' +
      '<div class="drawer-foot"><span></span><button class="btn primary" id="addFollowupBtn">+ Add Follow-Up Entry</button></div>';

    openDrawer();
    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    document.getElementById('addFollowupBtn').addEventListener('click', function () {
      STATE.linkedStudentPrefill = {
        firstName: s.firstName, lastName: s.lastName, pronouns: s.pronouns, international: s.international,
        program: s.program, modality: s.modality, enrollmentStatus: s.enrollmentStatus, columbiaOfficer: s.columbiaOfficer,
        caseStatus: s.caseStatus,
      };
      openEntryDrawer(null);
    });
    drawer.querySelectorAll('[data-edit-entry]').forEach(function (btn) {
      btn.addEventListener('click', function () { openEntryDrawer(btn.getAttribute('data-edit-entry')); });
    });
  }

  // ---------------- Team view (admin) ----------------
  function renderTeamView() {
    return '<div class="page-head"><div><div class="page-title">Team</div><div class="page-sub">Invite counselors and manage accounts. Signup is invite-only.</div></div></div>' +
      '<div class="dash-section-title">Invite a teammate</div>' +
      '<div class="card card-pad" style="margin-bottom:22px">' +
        '<form id="inviteForm" class="form-grid" style="align-items:end">' +
          '<div class="form-field"><label>Email (optional — leave blank for a shareable link anyone can use)</label><input type="email" name="email" /></div>' +
          '<div class="form-field"><label>Role</label><select name="role"><option value="counselor">Counselor</option><option value="admin">Admin</option></select></div>' +
          '<div class="form-field"><button class="btn primary" type="submit">Create Invite Link</button></div>' +
        '</form>' +
        '<div id="inviteResult"></div>' +
      '</div>' +
      '<div class="dash-section-title">Pending &amp; past invites</div>' +
      '<div class="table-wrap" style="margin-bottom:22px"><div id="invitesTableWrap"></div></div>' +
      '<div class="dash-section-title">Team members</div>' +
      '<div class="table-wrap"><div id="usersTableWrap"></div></div>';
  }

  function loadTeamData() {
    Promise.all([api('/api/users'), api('/api/invites')]).then(function (r) {
      STATE.team.users = r[0].users;
      STATE.team.invites = r[1].invites;
      renderTeamTables();
      bindTeamEvents();
    });
  }

  function renderTeamTables() {
    var invRows = STATE.team.invites.map(function (i) {
      var status = i.usedAt ? '<span class="badge badge-active">Used by ' + escapeHtml(i.usedByName || '') + '</span>' :
        new Date(i.expiresAt) < new Date() ? '<span class="badge badge-closed">Expired</span>' : '<span class="badge badge-monitoring">Pending</span>';
      var link = window.location.origin + '/?invite=' + i.token;
      return '<tr><td class="cell-muted">' + escapeHtml(i.email || 'Anyone with link') + '</td><td class="cell-muted">' + escapeHtml(i.role) + '</td><td>' + status + '</td>' +
        '<td class="cell-muted">' + fmtDate(i.expiresAt) + '</td>' +
        '<td>' + (!i.usedAt ? '<button class="btn small" data-copy-invite="' + escapeHtml(link) + '">Copy Link</button> <button class="btn small danger" data-revoke-invite="' + i.id + '">Revoke</button>' : '') + '</td></tr>';
    }).join('');
    document.getElementById('invitesTableWrap').innerHTML = STATE.team.invites.length ?
      '<table class="data-table"><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th></th></tr></thead><tbody>' + invRows + '</tbody></table>' :
      emptyState('No invites yet', 'Create one above to bring a teammate on board.');

    var userRows = STATE.team.users.map(function (u) {
      return '<tr>' +
        '<td class="cell-name">' + escapeHtml(u.name) + (u.id === STATE.currentUser.id ? ' <span class="small-muted">(you)</span>' : '') + '</td>' +
        '<td class="cell-muted">' + escapeHtml(u.email) + '</td>' +
        '<td>' + roleSelect(u) + '</td>' +
        '<td>' + (u.isActive ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-closed">Deactivated</span>') + '</td>' +
        '<td class="cell-muted">' + fmtDate(u.lastLoginAt) + '</td>' +
        '<td>' + (u.id !== STATE.currentUser.id ? '<button class="btn small' + (u.isActive ? ' danger' : '') + '" data-toggle-active="' + u.id + '" data-next="' + (!u.isActive) + '">' + (u.isActive ? 'Deactivate' : 'Reactivate') + '</button>' : '') + '</td>' +
      '</tr>';
    }).join('');
    document.getElementById('usersTableWrap').innerHTML = '<table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last Login</th><th></th></tr></thead><tbody>' + userRows + '</tbody></table>';
  }

  function roleSelect(u) {
    var disabled = u.id === STATE.currentUser.id ? ' disabled' : '';
    return '<select class="role-select" data-role-user="' + u.id + '"' + disabled + '>' +
      '<option value="counselor"' + (u.role === 'counselor' ? ' selected' : '') + '>Counselor</option>' +
      '<option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>Admin</option>' +
      '</select>';
  }

  function bindTeamEvents() {
    var wrap = document.getElementById('view-root');
    var form = document.getElementById('inviteForm');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      api('/api/invites', { method: 'POST', body: { email: f.email.value, role: f.role.value } }).then(function (d) {
        var link = window.location.origin + '/?invite=' + d.invite.token;
        document.getElementById('inviteResult').innerHTML = '<div class="auth-notice ok" style="margin-top:12px">Invite created: <code>' + escapeHtml(link) + '</code></div>';
        f.reset();
        return loadTeamData();
      });
    });
    wrap.querySelectorAll('[data-copy-invite]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(btn.getAttribute('data-copy-invite')).then(function () { toast('Invite link copied', 'ok'); });
      });
    });
    wrap.querySelectorAll('[data-revoke-invite]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Revoke this invite?')) return;
        api('/api/invites/' + btn.getAttribute('data-revoke-invite'), { method: 'DELETE' }).then(loadTeamData);
      });
    });
    wrap.querySelectorAll('[data-toggle-active]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        api('/api/users/' + btn.getAttribute('data-toggle-active'), { method: 'PATCH', body: { isActive: btn.getAttribute('data-next') === 'true' } }).then(loadTeamData);
      });
    });
    wrap.querySelectorAll('[data-role-user]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        api('/api/users/' + sel.getAttribute('data-role-user'), { method: 'PATCH', body: { role: sel.value } }).then(function () {
          toast('Role updated', 'ok');
          loadTeamData();
        });
      });
    });
  }

  // ---------------- Template view (admin) ----------------
  function renderTemplateView() {
    return '<div class="page-head"><div><div class="page-title">Template</div><div class="page-sub">Add or remove the choices available in each dropdown. This is what "(Do Not Disturb) Main template" started as — you can tailor it to your team.</div></div></div>' +
      '<div id="templateGroups">' + emptyState('Loading…', '') + '</div>';
  }

  function loadTemplateData() {
    api('/api/template').then(function (d) {
      STATE.template.groups = d.groups;
      renderTemplateGroups();
    });
  }

  function renderTemplateGroups() {
    var html = STATE.template.groups.map(function (g) {
      var active = g.options.filter(function (o) { return o.active; });
      var archived = g.options.filter(function (o) { return !o.active; });
      var chips = active.map(function (o) {
        return '<span class="option-chip">' + escapeHtml(o.value) + '<button class="chip-x" data-archive="' + o.id + '" title="Remove">&times;</button></span>';
      }).join('');
      var archivedHtml = archived.length ? '<details class="archived-details"><summary>' + archived.length + ' removed value' + (archived.length > 1 ? 's' : '') + '</summary>' +
        archived.map(function (o) { return '<span class="option-chip archived">' + escapeHtml(o.value) + '<button class="chip-x" data-restore="' + o.id + '" title="Restore">↺</button></span>'; }).join('') +
        '</details>' : '';
      return '<div class="card card-pad" style="margin-bottom:14px">' +
        '<div class="dash-section-title">' + escapeHtml(g.label) + '</div>' +
        '<div class="option-chip-list">' + chips + '</div>' +
        '<form class="add-option-form" data-group="' + g.key + '"><input type="text" placeholder="Add a new value…" required /><button class="btn small" type="submit">Add</button></form>' +
        archivedHtml +
      '</div>';
    }).join('');
    document.getElementById('templateGroups').innerHTML = html;
    bindTemplateEvents();
  }

  function bindTemplateEvents() {
    var wrap = document.getElementById('view-root');
    wrap.querySelectorAll('.add-option-form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = form.querySelector('input');
        var value = input.value.trim();
        if (!value) return;
        api('/api/template/' + form.getAttribute('data-group'), { method: 'POST', body: { value: value } }).then(function () {
          input.value = '';
          return Promise.all([loadTemplateData(), reloadConfig()]);
        }).then(function () { toast('Added "' + value + '"', 'ok'); });
      });
    });
    wrap.querySelectorAll('[data-archive]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var groupKey = btn.closest('.card').querySelector('.add-option-form').getAttribute('data-group');
        api('/api/template/' + groupKey + '/' + btn.getAttribute('data-archive'), { method: 'DELETE' }).then(function () {
          return Promise.all([loadTemplateData(), reloadConfig()]);
        }).then(function () { toast('Removed from dropdown', 'ok'); });
      });
    });
    wrap.querySelectorAll('[data-restore]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var groupKey = btn.closest('.card').querySelector('.add-option-form').getAttribute('data-group');
        api('/api/template/' + groupKey + '/' + btn.getAttribute('data-restore'), { method: 'PATCH' }).then(function () {
          return Promise.all([loadTemplateData(), reloadConfig()]);
        }).then(function () { toast('Restored', 'ok'); });
      });
    });
  }

  // ---------------- Drawer open/close ----------------
  function openDrawer() {
    document.getElementById('drawer').classList.add('open');
    document.getElementById('overlay').classList.add('open');
  }
  function closeDrawer() {
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('overlay').classList.remove('open');
    STATE.linkedStudentPrefill = null;
    STATE.editingId = null;
  }

  // ---------------- Event binding ----------------
  function bindViewEvents() {
    var root = document.getElementById('view-root');
    root.querySelectorAll('tr[data-id]').forEach(function (tr) {
      tr.addEventListener('click', function () { openEntryDrawer(tr.getAttribute('data-id')); });
    });
    root.querySelectorAll('th[data-sort]').forEach(function (thEl) {
      thEl.addEventListener('click', function () {
        var key = thEl.getAttribute('data-sort');
        if (STATE.sort.key === key) STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
        else { STATE.sort.key = key; STATE.sort.dir = 'asc'; }
        render();
      });
    });
    root.querySelectorAll('[data-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () { STATE.filters[chip.getAttribute('data-filter')] = chip.getAttribute('data-value'); render(); });
    });
    root.querySelectorAll('[data-student]').forEach(function (card) {
      card.addEventListener('click', function () { openStudentDrawer(card.getAttribute('data-student')); });
    });
    root.querySelectorAll('[data-dashmode]').forEach(function (btn) {
      btn.addEventListener('click', function () { STATE.dashRangeMode = btn.getAttribute('data-dashmode'); loadDashboard().then(render); });
    });
    var dashFrom = document.getElementById('dashFrom');
    var dashTo = document.getElementById('dashTo');
    if (dashFrom) dashFrom.addEventListener('change', function () { STATE.dashFrom = dashFrom.value; loadDashboard().then(render); });
    if (dashTo) dashTo.addEventListener('change', function () { STATE.dashTo = dashTo.value; loadDashboard().then(render); });
  }

  function bindGlobalEvents() {
    document.getElementById('nav').addEventListener('click', function (e) {
      var btn = e.target.closest('.nav-item');
      if (btn) setView(btn.getAttribute('data-view'));
    });
    document.getElementById('search').addEventListener('input', debounce(function (e) { STATE.search = e.target.value; render(); }, 120));
    document.getElementById('newEntryBtn').addEventListener('click', function () { STATE.linkedStudentPrefill = null; openEntryDrawer(null); });
    document.getElementById('exportBtn').addEventListener('click', function () { window.location.href = '/api/export.csv'; });
    document.getElementById('overlay').addEventListener('click', closeDrawer);
    document.getElementById('logoutBtn').addEventListener('click', function () { window.WCT_AUTH.logout(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  }

  // ---------------- Init ----------------
  function start(user) {
    STATE.currentUser = user;
    document.getElementById('userAvatar').textContent = initials(user.name);
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userRole').textContent = user.role === 'admin' ? 'Admin' : 'Counselor';
    if (user.role === 'admin') {
      document.getElementById('navTemplate').style.display = '';
      document.getElementById('navTeam').style.display = '';
      document.getElementById('adminNavDivider').style.display = '';
    }
    bindGlobalEvents();
    setView('log');
    loadAll().then(render).catch(function (err) { toast('Failed to load data: ' + err.message, 'err'); });
  }

  window.WCT_APP = { start: start };
})();
