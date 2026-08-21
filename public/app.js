(function () {
  'use strict';

  function getFields() { return window.WELLNESS_CONFIG.FIELDS; }
  function getSections() { return window.WELLNESS_CONFIG.SECTIONS; }

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

  var SEMESTER_STORAGE_KEY = 'wct_semester_id';
  var LAST_VIEW_STORAGE_KEY = 'wct_last_view';
  var WELLNESS_VIEWS = ['log', 'students', 'dashboard', 'template', 'appearance', 'import', 'team', 'audit'];

  var STATE = {
    currentUser: null,
    view: localStorage.getItem(LAST_VIEW_STORAGE_KEY) || 'recordsSearch',
    entries: [],
    students: [],
    semesters: [],
    currentSemesterId: localStorage.getItem(SEMESTER_STORAGE_KEY) || 'all',
    dashCounselor: 'all',
    search: '',
    filters: {},
    sort: { key: 'createdAt', dir: 'desc' },
    dashboard: null,
    dashRangeMode: 'all',
    dashFrom: '',
    dashTo: '',
    drawerMode: null,
    editingId: null,
    linkedStudentPrefill: null,
    team: { users: [], invites: [] },
    templates: [],
    templateOptionsCache: {},
    templateView: { selectedId: null, groups: [] },
    auditFilters: { actionType: '', actorId: '' },
    purge: { scope: 'all', semesterId: '', counselor: '', counselors: [], previewCount: null },
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

  function semesterQueryParam() {
    return STATE.currentSemesterId && STATE.currentSemesterId !== 'all' ? STATE.currentSemesterId : '';
  }

  function loadAll() {
    var qs = semesterQueryParam() ? '?semesterId=' + encodeURIComponent(semesterQueryParam()) : '';
    return Promise.all([
      api('/api/semesters').then(function (d) { STATE.semesters = d.semesters; }),
      api('/api/templates').then(function (d) { STATE.templates = d.templates; }),
      api('/api/entries' + qs).then(function (d) { STATE.entries = d.entries; }),
      api('/api/students' + qs).then(function (d) { STATE.students = d.students; }),
    ]).then(loadDashboard);
  }

  function counselorOptions() {
    var seen = {};
    var names = [];
    STATE.entries.forEach(function (e) {
      if (e.createdByName && !seen[e.createdByName]) { seen[e.createdByName] = true; names.push(e.createdByName); }
    });
    names.sort();
    return names;
  }

  function loadDashboard() {
    var range = computeDashRange();
    var params = [];
    if (range.from) params.push('from=' + encodeURIComponent(range.from));
    if (range.to) params.push('to=' + encodeURIComponent(range.to));
    if (semesterQueryParam()) params.push('semesterId=' + encodeURIComponent(semesterQueryParam()));
    if (STATE.dashCounselor && STATE.dashCounselor !== 'all') params.push('counselor=' + encodeURIComponent(STATE.dashCounselor));
    var qs = params.length ? '?' + params.join('&') : '';
    return api('/api/dashboard' + qs).then(function (d) { STATE.dashboard = d; });
  }

  function setSemester(semesterId) {
    STATE.currentSemesterId = semesterId || 'all';
    localStorage.setItem(SEMESTER_STORAGE_KEY, STATE.currentSemesterId);
    return loadAll().then(render);
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

  // Timestamps (audit log, createdAt/updatedAt) are real instants, not
  // date-only values — format in the viewer's local timezone as usual.
  function fmtDateTime(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    localStorage.setItem(LAST_VIEW_STORAGE_KEY, view);
    var inWellness = WELLNESS_VIEWS.indexOf(view) !== -1;
    document.querySelectorAll('.nav-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-view') === view);
    });
    document.getElementById('navWellnessToggle').classList.toggle('active', inWellness);
    document.getElementById('navWellness').style.display = inWellness ? '' : 'none';
    document.querySelector('.semester-wrap').style.display = inWellness ? '' : 'none';
    document.querySelector('.search-wrap').style.display = inWellness ? '' : 'none';
    document.querySelector('.topbar-actions').style.display = inWellness ? '' : 'none';
    render();
  }

  function render() {
    var root = document.getElementById('view-root');
    var footer = document.getElementById('entryCountFooter');
    footer.textContent = STATE.entries.length + ' entries · ' + STATE.students.length + ' students';
    renderSemesterSelect();
    if (STATE.view === 'log') root.innerHTML = renderLogView();
    else if (STATE.view === 'students') root.innerHTML = renderStudentsView();
    else if (STATE.view === 'dashboard') root.innerHTML = renderDashboardView();
    else if (STATE.view === 'team') { root.innerHTML = renderTeamView(); loadTeamData(); }
    else if (STATE.view === 'template') { root.innerHTML = renderTemplateView(); loadTemplateData(); }
    else if (STATE.view === 'import') { window.WCT_IMPORT.render(root); }
    else if (STATE.view === 'audit') { root.innerHTML = renderAuditView(); loadAuditData(); }
    else if (STATE.view === 'appearance') { root.innerHTML = renderAppearanceView(); }
    else if (STATE.view === 'recordsSearch') { window.WCT_RECORDS.renderSearch(root); }
    else if (STATE.view === 'recordsProfile') { window.WCT_RECORDS.renderProfile(root); }
    else if (STATE.view === 'sourceSis') { window.WCT_RECORDS.renderSource(root, 'sis'); }
    else if (STATE.view === 'sourceHousing') { window.WCT_RECORDS.renderSource(root, 'housing'); }
    else if (STATE.view === 'sourceCampusSafety') { window.WCT_RECORDS.renderSource(root, 'campusSafety'); }
    else if (STATE.view === 'sourceAcademicIntegrity') { window.WCT_RECORDS.renderSource(root, 'academicIntegrity'); }
    else if (STATE.view === 'sourceWebReports') { window.WCT_RECORDS.renderSource(root, 'webReports'); }
    bindViewEvents();
  }

  // ---------------- Appearance ----------------
  function renderAppearanceView() {
    var current = window.WCT_THEME.get();
    var option = function (value, label, swatchInner, desc) {
      return '<button class="theme-option' + (current === value ? ' active' : '') + '" data-theme-option="' + value + '">' +
        '<div class="theme-swatch">' + swatchInner + '</div>' +
        '<div><div class="theme-option-label">' + escapeHtml(label) + '<span class="theme-option-check"></span></div>' +
        '<div class="theme-option-desc">' + escapeHtml(desc) + '</div></div>' +
      '</button>';
    };
    return '<div class="page-head"><div><div class="page-title">Appearance</div><div class="page-sub">Choose how Wellness Tracker looks on this device.</div></div></div>' +
      '<div class="theme-grid">' +
        option('light', 'Light', '<span class="sw-bg"></span><span class="sw-surface"></span>', 'Ivory background, dark text — the default.') +
        option('dark', 'Dark', '<span class="sw-dark-bg"></span><span class="sw-dark-surface"></span>', 'Near-black background, light text.') +
        option('system', 'System', '<span class="sw-split"></span>', 'Follows your device\'s light/dark setting automatically.') +
      '</div>';
  }

  function renderSemesterSelect() {
    var sel = document.getElementById('semesterSelect');
    if (!sel) return;
    var options = ['<option value="all"' + (STATE.currentSemesterId === 'all' ? ' selected' : '') + '>All Semesters</option>'];
    STATE.semesters.forEach(function (s) {
      options.push('<option value="' + s.id + '"' + (STATE.currentSemesterId === s.id ? ' selected' : '') + '>' + escapeHtml(s.label) + ' (' + s.entryCount + ')</option>');
    });
    sel.innerHTML = options.join('');
    var delBtn = document.getElementById('deleteSemesterBtn');
    if (delBtn) delBtn.style.display = (STATE.currentSemesterId !== 'all' && STATE.currentUser && STATE.currentUser.role === 'admin') ? '' : 'none';
  }

  // ---------------- Log view ----------------
  // Search scans identity fields plus every dynamic field value present on
  // an entry — not a fixed list of "searchable" columns, since fields vary
  // by template. Filters are likewise a generic { fieldKey: value } map.
  function filteredEntries() {
    var q = STATE.search.trim().toLowerCase();
    var list = STATE.entries.filter(function (e) {
      for (var key in STATE.filters) {
        if (STATE.filters[key] && e[key] !== STATE.filters[key]) return false;
      }
      if (!q) return true;
      var hay = [e.firstName, e.lastName, e.studentIdExternal]
        .concat(Object.keys(e.fields || {}).map(function (k) { return e.fields[k]; }))
        .join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    var key = STATE.sort.key, dir = STATE.sort.dir === 'asc' ? 1 : -1;
    list.sort(function (a, b) {
      var av = a[key] || '', bv = b[key] || '';
      if (key === 'createdAt' || key === 'updatedAt') {
        av = av ? new Date(av).getTime() : 0;
        bv = bv ? new Date(bv).getTime() : 0;
      } else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return list;
  }

  function templateNameFor(templateId) {
    var t = STATE.templates.find(function (x) { return x.id === templateId; });
    return t ? t.name : '—';
  }

  // Table columns are the only fields guaranteed to exist across any
  // template — everything else lives in the per-entry drawer, which renders
  // whatever fields that entry's template actually defines.
  function renderLogView() {
    var list = filteredEntries();
    var showSemesterCol = STATE.currentSemesterId === 'all';
    var rows = list.map(function (e) {
      return '<tr data-id="' + e.id + '">' +
        '<td class="cell-muted">' + escapeHtml(e.studentIdExternal || '—') + '</td>' +
        '<td class="cell-name">' + escapeHtml(e.firstName) + ' ' + escapeHtml(e.lastName) + '</td>' +
        '<td class="cell-muted">' + escapeHtml(templateNameFor(e.templateId)) + '</td>' +
        '<td class="cell-muted">' + escapeHtml(e.createdByName || '—') + '</td>' +
        '<td class="cell-muted">' + fmtDateTime(e.createdAt) + '</td>' +
        (showSemesterCol ? '<td class="cell-muted">' + escapeHtml(e.semesterLabel || '—') + '</td>' : '') +
        '</tr>';
    }).join('');

    // One dropdown filter per select-type field on the active template —
    // capped to fields with a handful of options so the bar stays usable
    // even when a template has many select fields (e.g. 19 on Default).
    var dynamicFilters = getFields().filter(function (f) { return f.type === 'select' && f.options && f.options.length && f.options.length <= 8; });
    var filterBarHtml = dynamicFilters.map(function (f) {
      var opts = '<option value="">All ' + escapeHtml(f.label) + '</option>' + f.options.map(function (o) {
        return '<option value="' + escapeHtml(o) + '"' + (STATE.filters[f.key] === o ? ' selected' : '') + '>' + escapeHtml(o) + '</option>';
      }).join('');
      return '<select class="counselor-select" data-dynamic-filter="' + f.key + '">' + opts + '</select>';
    }).join('');

    return '' +
      '<div class="page-head">' +
        '<div><div class="page-title">Case Log</div><div class="page-sub">Shared with your whole team — click a row to edit.</div></div>' +
      '</div>' +
      (filterBarHtml ? '<div class="filter-bar">' + filterBarHtml + '</div>' : '') +
      '<div class="table-wrap">' +
        (list.length ? (
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th>Student ID</th>' + th('lastName', 'Student') + '<th>Template</th><th>Logged By</th>' + th('createdAt', 'Date') +
            (showSemesterCol ? '<th>Semester</th>' : '') +
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

  function emptyState(big, small) {
    return '<div class="empty-state"><div class="big">' + escapeHtml(big) + '</div><div>' + escapeHtml(small) + '</div></div>';
  }

  // ---------------- Students view ----------------
  // Only entry count / first / last contact are guaranteed across any
  // template — per-student status/program/risk badges moved into the
  // per-entry drawer (opened from the card), since a template might not
  // define anything shaped like those fields at all.
  function renderStudentsView() {
    var q = STATE.search.trim().toLowerCase();
    var list = STATE.students.filter(function (s) {
      if (!q) return true;
      return (s.firstName + ' ' + s.lastName + ' ' + (s.studentIdExternal || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) {
      return '<div class="page-head"><div><div class="page-title">Students</div><div class="page-sub">Grouped case history, one card per student.</div></div></div>' +
        emptyState('No students yet', 'Add your first entry to get started.');
    }
    var cards = list.map(function (s) {
      return '<div class="card student-card" data-student="' + escapeHtml(s.studentKey) + '">' +
        '<div class="student-card-head">' +
          '<div><div class="student-name">' + escapeHtml(s.firstName) + ' ' + escapeHtml(s.lastName) + '</div>' +
          '<div class="student-meta">' + escapeHtml(s.studentIdExternal || 'No student ID on file') + '</div></div>' +
        '</div>' +
        '<div class="student-stats">' +
          '<div class="student-stat"><b>' + s.entryCount + '</b>entries</div>' +
          '<div class="student-stat"><b>' + fmtDate(s.firstContact) + '</b>first contact</div>' +
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

  // One card per section the API returns — sections are the merged
  // select/number/date fields actually defined across active templates
  // (see server.js's buildFieldSchemaForDashboard), not a fixed report
  // layout. A template with no fields shaped like Case Status/NABITA Risk
  // simply produces no section for them; nothing here assumes they exist.
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

    var currentSemesterLabel = STATE.currentSemesterId === 'all' ? 'All semesters' :
      ((STATE.semesters.find(function (s) { return s.id === STATE.currentSemesterId; }) || {}).label || 'Selected semester');

    var counselors = counselorOptions();
    var counselorSelect = '<select id="dashCounselor" class="counselor-select">' +
      '<option value="all">All Counselors</option>' +
      counselors.map(function (name) { return '<option value="' + escapeHtml(name) + '"' + (STATE.dashCounselor === name ? ' selected' : '') + '>' + escapeHtml(name) + '</option>'; }).join('') +
      '</select>';

    var sectionCards = d.sections.map(function (sec) {
      if (sec.type === 'select') return dashCard(sec.label, 'every logged entry', barList(sec.counts, { limit: 12 }));
      if (sec.type === 'number') return dashCard(sec.label, 'sum / average, every logged entry', numberBody(sec));
      if (sec.type === 'date') return dashCard(sec.label + ' by Month', 'selected period', monthChart(sec.monthCounts));
      return '';
    }).join('');

    return '' +
      '<div class="page-head"><div><div class="page-title">Dashboard</div><div class="page-sub">' + escapeHtml(currentSemesterLabel) + ' · ' + escapeHtml(rangeLabel) + '</div></div>' +
        '<button class="btn" id="exportDashboardBtn">Export Dashboard…</button>' +
      '</div>' +
      '<div class="filter-bar">' + modeBtn('all', 'All Time') + modeBtn('semester', 'This Semester') + modeBtn('year', 'This Year') + modeBtn('custom', 'Custom Range') + customInputs +
        '<span style="width:1px;height:20px;background:var(--border);margin:0 4px;"></span>' + counselorSelect +
      '</div>' +
      '<div class="stat-grid">' +
        statCard('Unique Students', d.totals.uniqueStudents, 'in selected period') +
        statCard('Total Entries Logged', d.totals.totalEntries, '') +
      '</div>' +
      (d.sections.length ? '<div class="dash-grid">' + sectionCards + '</div>' :
        emptyState('No breakdown sections yet', 'Add select, number, or date fields to a template to see them charted here.'));
  }

  function statCard(label, value, foot) {
    return '<div class="card stat-card"><div class="stat-label">' + escapeHtml(label) + '</div><div class="stat-value">' + value + '</div><div class="stat-foot">' + escapeHtml(foot) + '</div></div>';
  }

  function numberBody(sec) {
    return '<div class="stat-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:0">' +
      statCard('Sum', sec.sum, sec.count + ' logged') + statCard('Average', sec.average, '') +
    '</div>';
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

  function semesterFieldHtml(entry) {
    var current = entry && entry.semesterId ? entry.semesterId : (STATE.currentSemesterId !== 'all' ? STATE.currentSemesterId : '');
    var opts = '<option value="">— Select —</option>' + STATE.semesters.map(function (s) {
      return '<option value="' + s.id + '"' + (s.id === current ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>';
    }).join('');
    return '<div class="form-section">' +
      '<div class="form-section-title">Semester</div>' +
      '<div class="form-grid"><div class="form-field"><label>Semester<span class="required-mark">*</span></label>' +
      '<select name="semesterId" required>' + opts + '</select></div></div>' +
      (STATE.semesters.length ? '' : '<div class="small-muted" style="margin-top:6px">No semesters yet — use "+ Semester" in the top bar to create one.</div>') +
    '</div>';
  }

  var CREATE_TEMPLATE_VALUE = '__create_new_template__';

  function templateFieldHtml(entry) {
    var current = entry && entry.templateId ? entry.templateId : (window.WELLNESS_CONFIG.DEFAULT_TEMPLATE_ID || '');
    var opts = STATE.templates.map(function (t) {
      return '<option value="' + t.id + '"' + (t.id === current ? ' selected' : '') + '>' + escapeHtml(t.name) + (t.isDefault ? ' (Default)' : '') + '</option>';
    }).join('') + '<option value="' + CREATE_TEMPLATE_VALUE + '">+ Create New Template…</option>';
    return '<div class="form-section">' +
      '<div class="form-section-title">Template</div>' +
      '<div class="form-grid"><div class="form-field"><label>Which dropdown options should this entry use?<span class="required-mark">*</span></label>' +
      '<select name="templateId" id="entryTemplateSelect" required>' + opts + '</select></div></div>' +
      '<div class="small-muted" style="margin-top:6px">Starts from the Default list — create a new template to add or remove choices just for this context.</div>' +
    '</div>';
  }

  // First/Last Name (+ optional Student ID) are the only guaranteed fields —
  // structural columns, not part of a template's dynamic field list — so
  // they're always rendered, independent of which template is selected.
  function coreIdentityFieldsHtml(entry) {
    return '<div class="form-section"><div class="form-section-title">Identity</div><div class="form-grid">' +
      fieldInputHtml({ key: 'firstName', label: 'First Name', type: 'text', required: true }, entry ? entry.firstName : '') +
      fieldInputHtml({ key: 'lastName', label: 'Last Name', type: 'text', required: true }, entry ? entry.lastName : '') +
      fieldInputHtml({ key: 'studentIdExternal', label: 'Student ID (optional)', type: 'text' }, entry ? entry.studentIdExternal : '') +
    '</div></div>';
  }

  // Renders one form-section per section in the given template config
  // (fetched from GET /api/templates/:id/fields) — everything past Identity/
  // Semester/Template is fully dynamic and driven by that template's field
  // list, not a fixed schema.
  function buildDynamicSectionsHtml(config, entry) {
    return (config.SECTIONS || []).map(function (sec) {
      var fields = (config.FIELDS || []).filter(function (f) { return f.section === sec.key; });
      var html = fields.map(function (f) { return fieldInputHtml(f, entry ? entry[f.key] : (f.default || '')); }).join('');
      return '<div class="form-section"><div class="form-section-title">' + escapeHtml(sec.label) + '</div><div class="form-grid">' + html + '</div></div>';
    }).join('');
  }

  function entryFormHtml(entry, isNew, config) {
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

    return '<form id="entryForm"><div id="formErrors"></div>' + linkBox + coreIdentityFieldsHtml(entry) + semesterFieldHtml(entry) + templateFieldHtml(entry) +
      '<div id="entryDynamicSections">' + buildDynamicSectionsHtml(config, entry) + '</div></form>';
  }

  // Swaps in a different template's whole field set (not just its option
  // values — templates can have entirely different fields now). Cached per
  // template so switching back and forth doesn't re-fetch; the Template admin
  // page invalidates this cache (STATE.templateOptionsCache) when a
  // template's fields/options change.
  function applyTemplateFields(templateId, entryForPrefill) {
    if (!templateId || templateId === CREATE_TEMPLATE_VALUE) return Promise.resolve();
    var cached = STATE.templateOptionsCache[templateId];
    var fetchP = cached ? Promise.resolve(cached) : api('/api/templates/' + templateId + '/fields').then(function (config) {
      STATE.templateOptionsCache[templateId] = config;
      return config;
    });
    return fetchP.then(function (config) {
      var container = document.getElementById('entryDynamicSections');
      if (container) container.innerHTML = buildDynamicSectionsHtml(config, entryForPrefill || null);
    });
  }

  function openEntryDrawer(entryId) {
    var isNew = !entryId;
    var entry = isNew ? Object.assign({}, STATE.linkedStudentPrefill || {}) : STATE.entries.find(function (e) { return e.id === entryId; });
    STATE.editingId = isNew ? null : entryId;
    STATE.drawerMode = 'entry';

    var initialTemplateId = (entry && entry.templateId) ? entry.templateId : (window.WELLNESS_CONFIG.DEFAULT_TEMPLATE_ID || '');
    var cached = initialTemplateId ? STATE.templateOptionsCache[initialTemplateId] : null;
    var configPromise = !initialTemplateId ? Promise.resolve({ FIELDS: [], SECTIONS: [] }) :
      cached ? Promise.resolve(cached) :
      api('/api/templates/' + initialTemplateId + '/fields').then(function (config) { STATE.templateOptionsCache[initialTemplateId] = config; return config; });

    configPromise.then(function (config) {
      var drawer = document.getElementById('drawer');
      var attribution = (!isNew && (entry.createdByName || entry.updatedByName)) ?
        '<div class="drawer-sub">Logged by ' + escapeHtml(entry.createdByName || '—') + (entry.updatedByName && entry.updatedByName !== entry.createdByName ? ' · last edited by ' + escapeHtml(entry.updatedByName) : '') + '</div>' : '';

      drawer.innerHTML = '' +
        '<div class="drawer-head">' +
          '<div><div class="drawer-title">' + (isNew ? 'New Entry' : 'Edit Entry') + '</div>' +
          (isNew ? '<div class="drawer-sub">Fill in a new interaction.</div>' : '<div class="drawer-sub">' + escapeHtml((entry.firstName || '') + ' ' + (entry.lastName || '')) + '</div>' + attribution) +
          '</div>' +
          '<button class="drawer-close" id="drawerClose">&times;</button>' +
        '</div>' +
        '<div class="drawer-body">' + entryFormHtml(entry, isNew, config) + '</div>' +
        '<div class="drawer-foot">' +
          (isNew ? '<span></span>' : '<button class="btn danger" id="deleteEntryBtn">Delete Entry</button>') +
          '<div style="display:flex;gap:8px"><button class="btn" id="cancelEntryBtn">Cancel</button><button class="btn primary" id="saveEntryBtn">' + (isNew ? 'Create Entry' : 'Save Changes') + '</button></div>' +
        '</div>';

      openDrawer();
      bindEntryFormEvents(isNew);
    });
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
    var templateSelect = document.getElementById('entryTemplateSelect');
    var activeTemplateId = templateSelect.value;
    templateSelect.addEventListener('change', function () {
      if (templateSelect.value === CREATE_TEMPLATE_VALUE) {
        var name = prompt('New template name (e.g. "Undergrad Wellness"):');
        if (!name || !name.trim()) { templateSelect.value = activeTemplateId; return; }
        api('/api/templates', { method: 'POST', body: { name: name.trim() } }).then(function (d) {
          STATE.templates.push(d.template);
          STATE.templateOptionsCache[d.template.id] = d.config;
          var newOpt = document.createElement('option');
          newOpt.value = d.template.id;
          newOpt.textContent = d.template.name;
          templateSelect.insertBefore(newOpt, templateSelect.lastElementChild);
          templateSelect.value = d.template.id;
          activeTemplateId = d.template.id;
          toast('Template "' + d.template.name + '" created', 'ok');
          return applyTemplateFields(d.template.id);
        }).catch(function (err) { toast(err.message, 'err'); templateSelect.value = activeTemplateId; });
      } else {
        activeTemplateId = templateSelect.value;
        applyTemplateFields(activeTemplateId);
      }
    });

    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    document.getElementById('cancelEntryBtn').addEventListener('click', closeDrawer);
    document.getElementById('saveEntryBtn').addEventListener('click', submitEntryForm);
    var delBtn = document.getElementById('deleteEntryBtn');
    if (delBtn) delBtn.addEventListener('click', function () { deleteEntry(STATE.editingId); });
  }

  function fillIdentityFields(s) {
    var fnEl = document.querySelector('[name="firstName"]'); if (fnEl) fnEl.value = s.firstName || '';
    var lnEl = document.querySelector('[name="lastName"]'); if (lnEl) lnEl.value = s.lastName || '';
    var idEl = document.querySelector('[name="studentIdExternal"]'); if (idEl) idEl.value = s.studentIdExternal || '';
    document.querySelectorAll('#entryDynamicSections [name]').forEach(function (el) {
      if (s[el.name] !== undefined) el.value = s[el.name] || '';
    });
  }

  function collectFormData() {
    var form = document.getElementById('entryForm');
    var data = {};
    ['firstName', 'lastName', 'studentIdExternal'].forEach(function (key) {
      var el = form.querySelector('[name="' + key + '"]');
      data[key] = el ? el.value : '';
    });
    form.querySelectorAll('#entryDynamicSections [name]').forEach(function (el) { data[el.name] = el.value; });
    var semesterEl = form.querySelector('[name="semesterId"]');
    data.semesterId = semesterEl ? semesterEl.value : '';
    var templateEl = form.querySelector('[name="templateId"]');
    data.templateId = templateEl ? templateEl.value : '';
    return data;
  }

  function submitEntryForm() {
    var data = collectFormData();
    var errBox = document.getElementById('formErrors');
    errBox.innerHTML = '';
    var missing = [];
    if (!data.firstName) missing.push({ label: 'First Name' });
    if (!data.lastName) missing.push({ label: 'Last Name' });
    if (!data.semesterId) missing.push({ label: 'Semester' });
    if (!data.templateId || data.templateId === CREATE_TEMPLATE_VALUE) missing.push({ label: 'Template' });
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

    // Each entry's own template defines its fields — shows a handful of
    // whatever values that entry actually has (as tags) plus which template
    // it used, rather than assuming specific fields like Outreach Method.
    var items = s.entries.map(function (e) {
      var tags = Object.keys(e.fields || {}).map(function (k) { return e.fields[k]; }).filter(Boolean).slice(0, 4);
      return '<div class="timeline-item">' +
        '<div class="timeline-date">' + fmtDateTime(e.createdAt) + ' · <span class="tag" style="margin-left:2px">' + escapeHtml(templateNameFor(e.templateId)) + '</span></div>' +
        '<div class="timeline-tags">' + tags.map(function (t) { return '<span class="tag">' + escapeHtml(t) + '</span>'; }).join('') + '</div>' +
        '<div class="timeline-notes">Logged by ' + escapeHtml(e.createdByName || '—') + '</div>' +
        '<div class="timeline-actions"><button class="btn small" data-edit-entry="' + e.id + '">Edit</button></div>' +
      '</div>';
    }).join('');

    drawer.innerHTML = '' +
      '<div class="drawer-head">' +
        '<div><div class="drawer-title">' + escapeHtml(s.firstName) + ' ' + escapeHtml(s.lastName) + '</div>' +
        '<div class="drawer-sub">' + escapeHtml(s.studentIdExternal || 'No student ID on file') + '</div></div>' +
        '<button class="drawer-close" id="drawerClose">&times;</button>' +
      '</div>' +
      '<div class="drawer-body">' +
        '<div class="stat-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:18px">' +
          statCard('Entries', s.entryCount, '') + statCard('Last Contact', fmtDate(s.lastContact), '') +
        '</div>' +
        '<div class="dash-section-title">Case History</div>' +
        '<div class="timeline">' + items + '</div>' +
      '</div>' +
      '<div class="drawer-foot"><span></span><button class="btn primary" id="addFollowupBtn">+ Add Follow-Up Entry</button></div>';

    openDrawer();
    document.getElementById('drawerClose').addEventListener('click', closeDrawer);
    document.getElementById('addFollowupBtn').addEventListener('click', function () {
      var latest = s.entries && s.entries[0];
      STATE.linkedStudentPrefill = Object.assign(
        { firstName: s.firstName, lastName: s.lastName, studentIdExternal: latest ? latest.studentIdExternal : '' },
        latest && latest.fields ? latest.fields : {}
      );
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
      '<div class="table-wrap" style="margin-bottom:22px"><div id="usersTableWrap"></div></div>' +
      '<div id="dangerZoneWrap">' + renderDangerZone() + '</div>';
  }

  function renderDangerZone() {
    var scope = STATE.purge.scope;
    var scopeBtn = function (value, label) {
      return '<button class="filter-chip' + (scope === value ? ' active' : '') + '" data-purge-scope="' + value + '">' + label + '</button>';
    };
    var scopePicker = '';
    if (scope === 'semester') {
      scopePicker = '<div class="form-field" style="max-width:280px;margin-top:12px"><label>Semester</label><select id="purgeSemester">' +
        '<option value="">— Select —</option>' +
        STATE.semesters.map(function (s) { return '<option value="' + s.id + '"' + (s.id === STATE.purge.semesterId ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>'; }).join('') +
        '</select></div>';
    } else if (scope === 'counselor') {
      scopePicker = '<div class="form-field" style="max-width:280px;margin-top:12px"><label>Counselor</label><select id="purgeCounselor">' +
        '<option value="">— Select —</option>' +
        STATE.purge.counselors.map(function (c) { return '<option value="' + escapeHtml(c) + '"' + (c === STATE.purge.counselor ? ' selected' : '') + '>' + escapeHtml(c) + '</option>'; }).join('') +
        '</select></div>';
    }

    var previewText = STATE.purge.previewCount === null ? 'Choose a scope to see how many entries this affects.' :
      '<b>' + STATE.purge.previewCount + '</b> entr' + (STATE.purge.previewCount === 1 ? 'y' : 'ies') + ' will be permanently deleted. Semesters, templates, and team accounts are not affected. This cannot be undone.';

    var canSubmit = STATE.purge.previewCount !== null && STATE.purge.previewCount > 0;

    return '<div class="dash-section-title" style="color:var(--danger)">Danger Zone</div>' +
      '<div class="card card-pad" style="border-color:var(--danger)">' +
        '<div class="filter-bar" style="margin-bottom:0">' +
          scopeBtn('all', 'All Data') + scopeBtn('semester', 'One Semester') + scopeBtn('counselor', 'One Counselor') +
        '</div>' +
        scopePicker +
        '<div class="small-muted" style="margin-top:14px;line-height:1.6">' + previewText + '</div>' +
        '<div class="form-grid" style="margin-top:14px;align-items:end;max-width:520px">' +
          '<div class="form-field"><label>Danger Zone Password</label><input type="password" id="purgePassword" autocomplete="off" placeholder="Required to confirm" /></div>' +
          '<div class="form-field"><button class="btn danger" id="purgeConfirmBtn"' + (canSubmit ? '' : ' disabled') + '>Permanently Delete</button></div>' +
        '</div>' +
      '</div>';
  }

  function loadTeamData() {
    Promise.all([api('/api/users'), api('/api/invites'), api('/api/counselors')]).then(function (r) {
      STATE.team.users = r[0].users;
      STATE.team.invites = r[1].invites;
      STATE.purge.counselors = r[2].counselors;
      renderTeamTables();
      refreshPurgeZone();
      bindTeamEvents();
    });
  }

  function refreshPurgeZone() {
    var container = document.getElementById('dangerZoneWrap');
    if (!container) return;
    container.innerHTML = renderDangerZone();
    bindDangerZoneEvents();
  }

  function fetchPurgePreview() {
    var scope = STATE.purge.scope;
    var params = ['scope=' + scope];
    if (scope === 'semester') { if (!STATE.purge.semesterId) { STATE.purge.previewCount = null; refreshPurgeZone(); return; } params.push('semesterId=' + encodeURIComponent(STATE.purge.semesterId)); }
    if (scope === 'counselor') { if (!STATE.purge.counselor) { STATE.purge.previewCount = null; refreshPurgeZone(); return; } params.push('counselor=' + encodeURIComponent(STATE.purge.counselor)); }
    api('/api/admin/purge/preview?' + params.join('&')).then(function (d) {
      STATE.purge.previewCount = d.count;
      refreshPurgeZone();
    });
  }

  function bindDangerZoneEvents() {
    var wrap = document.getElementById('view-root');
    wrap.querySelectorAll('[data-purge-scope]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        STATE.purge.scope = btn.getAttribute('data-purge-scope');
        STATE.purge.previewCount = null;
        refreshPurgeZone();
        if (STATE.purge.scope === 'all') fetchPurgePreview();
      });
    });
    var semSel = document.getElementById('purgeSemester');
    if (semSel) semSel.addEventListener('change', function () { STATE.purge.semesterId = semSel.value; fetchPurgePreview(); });
    var counSel = document.getElementById('purgeCounselor');
    if (counSel) counSel.addEventListener('change', function () { STATE.purge.counselor = counSel.value; fetchPurgePreview(); });

    var confirmBtn = document.getElementById('purgeConfirmBtn');
    if (confirmBtn) confirmBtn.addEventListener('click', function () {
      var password = document.getElementById('purgePassword').value;
      if (!password) { toast('Enter the Danger Zone password.', 'err'); return; }
      var body = { scope: STATE.purge.scope, password: password };
      if (STATE.purge.scope === 'semester') body.semesterId = STATE.purge.semesterId;
      if (STATE.purge.scope === 'counselor') body.counselor = STATE.purge.counselor;
      confirmBtn.disabled = true;
      api('/api/admin/purge', { method: 'POST', body: body }).then(function (d) {
        toast('Deleted ' + d.deletedCount + ' entries.', 'ok');
        STATE.purge = { scope: 'all', semesterId: '', counselor: '', counselors: STATE.purge.counselors, previewCount: null };
        return loadAll();
      }).then(function () { loadTeamData(); render(); })
        .catch(function (err) { toast(err.message, 'err'); confirmBtn.disabled = false; });
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

  // ---------------- Audit log (admin) ----------------
  var AUDIT_ACTION_TYPES = [
    'auth.login', 'auth.login_failed', 'auth.logout', 'auth.setup', 'auth.idle_timeout',
    'invite.create', 'invite.revoke', 'invite.accept',
    'user.role_change', 'user.deactivate', 'user.reactivate',
    'entry.create', 'entry.update', 'entry.delete', 'entry.view', 'entry.export',
    'semester.create', 'template.create', 'template.option_add', 'template.option_archive', 'template.option_restore',
    'dashboard.export', 'data.purge', 'student_record.view',
  ];

  function renderAuditView() {
    var actionOptions = '<option value="">All Actions</option>' + AUDIT_ACTION_TYPES.map(function (a) {
      return '<option value="' + a + '"' + (STATE.auditFilters.actionType === a ? ' selected' : '') + '>' + a + '</option>';
    }).join('');
    var actorOptions = '<option value="">All Team Members</option>' + STATE.team.users.map(function (u) {
      return '<option value="' + u.id + '"' + (STATE.auditFilters.actorId === u.id ? ' selected' : '') + '>' + escapeHtml(u.name) + '</option>';
    }).join('');
    return '<div class="page-head"><div><div class="page-title">Audit Log</div><div class="page-sub">Every sensitive access and change, for SOC 2 / FERPA-style audit review. Most recent first.</div></div></div>' +
      '<div class="audit-filters">' +
        '<select id="auditActionFilter">' + actionOptions + '</select>' +
        '<select id="auditActorFilter">' + actorOptions + '</select>' +
      '</div>' +
      '<div id="auditTableWrap">' + emptyState('Loading…', '') + '</div>';
  }

  function loadAuditData() {
    var params = [];
    if (STATE.auditFilters.actionType) params.push('actionType=' + encodeURIComponent(STATE.auditFilters.actionType));
    if (STATE.auditFilters.actorId) params.push('actorId=' + encodeURIComponent(STATE.auditFilters.actorId));
    var qs = params.length ? '?' + params.join('&') : '';
    Promise.all([
      api('/api/audit-log' + qs),
      STATE.team.users.length ? Promise.resolve({ users: STATE.team.users }) : api('/api/users'),
    ]).then(function (r) {
      STATE.team.users = r[1].users;
      renderAuditTable(r[0].logs);
    });
  }

  function renderAuditTable(logs) {
    var rows = logs.map(function (l) {
      return '<tr>' +
        '<td class="cell-muted">' + fmtDateTime(l.createdAt) + '</td>' +
        '<td class="cell-name">' + escapeHtml(l.actorName || 'System') + '</td>' +
        '<td><span class="tag">' + escapeHtml(l.actionType) + '</span></td>' +
        '<td class="cell-muted">' + escapeHtml(l.targetRecordId || '—') + '</td>' +
        '<td class="cell-muted">' + escapeHtml(l.ipAddress || '—') + '</td>' +
      '</tr>';
    }).join('');
    var wrap = document.getElementById('auditTableWrap');
    wrap.innerHTML = logs.length ?
      '<div class="table-wrap"><table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target Record</th><th>IP Address</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="audit-meta" style="margin-top:8px">Showing ' + logs.length + ' most recent event(s).</div>' :
      emptyState('No matching events', 'Try clearing filters.');
    var actionSel = document.getElementById('auditActionFilter');
    var actorSel = document.getElementById('auditActorFilter');
    if (actionSel) actionSel.addEventListener('change', function () { STATE.auditFilters.actionType = actionSel.value; loadAuditData(); });
    if (actorSel) actorSel.addEventListener('change', function () { STATE.auditFilters.actorId = actorSel.value; loadAuditData(); });
  }

  // ---------------- Template view (admin) ----------------
  function renderTemplateView() {
    if (!STATE.templateView.selectedId) {
      var def = STATE.templates.find(function (t) { return t.isDefault; });
      STATE.templateView.selectedId = def ? def.id : (STATE.templates[0] || {}).id;
    }
    var templateSelect = '<select id="templateViewSelect" class="semester-select">' +
      STATE.templates.map(function (t) {
        return '<option value="' + t.id + '"' + (t.id === STATE.templateView.selectedId ? ' selected' : '') + '>' + escapeHtml(t.name) + (t.isDefault ? ' (Default)' : '') + '</option>';
      }).join('') + '</select>';

    var selected = STATE.templates.find(function (t) { return t.id === STATE.templateView.selectedId; });
    var canDelete = selected && !selected.isDefault && STATE.currentUser && STATE.currentUser.role === 'admin';

    return '<div class="page-head"><div><div class="page-title">Template</div><div class="page-sub">Add or remove the choices available in each dropdown. "Default" is what "(Do Not Disturb) Main template" started as — create additional templates for other contexts.</div></div></div>' +
      '<div class="filter-bar">' + templateSelect + '<button class="btn small ghost" id="newTemplateBtn">+ New Template</button>' +
        (canDelete ? '<button class="btn small danger" id="deleteTemplateBtn">Delete Template</button>' : '') +
      '</div>' +
      '<div id="templateGroups">' + emptyState('Loading…', '') + '</div>';
  }

  function selectedTemplateIsDefault() {
    var t = STATE.templates.find(function (t) { return t.id === STATE.templateView.selectedId; });
    return t ? t.isDefault : false;
  }

  function canEditSelectedTemplate() {
    return !selectedTemplateIsDefault() || (STATE.currentUser && STATE.currentUser.role === 'admin');
  }

  function loadTemplateData() {
    if (!STATE.templateView.selectedId) { renderTemplateGroups(); return; }
    api('/api/templates/' + STATE.templateView.selectedId + '/options').then(function (d) {
      STATE.templateView.groups = d.groups;
      renderTemplateGroups();
    });
  }

  function renderTemplateGroups() {
    var editable = canEditSelectedTemplate();
    var restrictedNote = !editable ? '<div class="auth-notice" style="margin-bottom:16px">Only admins can edit the Default template. Create your own template to customize freely.</div>' : '';
    var html = STATE.templateView.groups.map(function (g) {
      var active = g.options.filter(function (o) { return o.active; });
      var archived = g.options.filter(function (o) { return !o.active; });
      var chips = active.map(function (o) {
        return '<span class="option-chip">' + escapeHtml(o.value) + (editable ? '<button class="chip-x" data-archive="' + o.id + '" title="Remove">&times;</button>' : '') + '</span>';
      }).join('');
      var archivedHtml = archived.length ? '<details class="archived-details"><summary>' + archived.length + ' removed value' + (archived.length > 1 ? 's' : '') + '</summary>' +
        archived.map(function (o) { return '<span class="option-chip archived">' + escapeHtml(o.value) + (editable ? '<button class="chip-x" data-restore="' + o.id + '" title="Restore">↺</button>' : '') + '</span>'; }).join('') +
        '</details>' : '';
      return '<div class="card card-pad" style="margin-bottom:14px">' +
        '<div class="dash-section-title">' + escapeHtml(g.label) + '</div>' +
        '<div class="option-chip-list">' + chips + '</div>' +
        (editable ? '<form class="add-option-form" data-group="' + g.key + '"><input type="text" placeholder="Add a new value…" required /><button class="btn small" type="submit">Add</button></form>' : '') +
        archivedHtml +
      '</div>';
    }).join('');
    document.getElementById('templateGroups').innerHTML = restrictedNote + html;
    bindTemplateEvents();
  }

  function bindTemplateEvents() {
    var wrap = document.getElementById('view-root');
    var templateId = STATE.templateView.selectedId;
    wrap.querySelectorAll('.add-option-form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = form.querySelector('input');
        var value = input.value.trim();
        if (!value) return;
        api('/api/templates/' + templateId + '/options/' + form.getAttribute('data-group'), { method: 'POST', body: { value: value } }).then(function () {
          input.value = '';
          delete STATE.templateOptionsCache[templateId];
          return Promise.all([loadTemplateData(), reloadConfig()]);
        }).then(function () { toast('Added "' + value + '"', 'ok'); });
      });
    });
    wrap.querySelectorAll('[data-archive]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var groupKey = btn.closest('.card').querySelector('.add-option-form').getAttribute('data-group');
        api('/api/templates/' + templateId + '/options/' + groupKey + '/' + btn.getAttribute('data-archive'), { method: 'DELETE' }).then(function () {
          delete STATE.templateOptionsCache[templateId];
          return Promise.all([loadTemplateData(), reloadConfig()]);
        }).then(function () { toast('Removed from dropdown', 'ok'); });
      });
    });
    wrap.querySelectorAll('[data-restore]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var groupKey = btn.closest('.card').querySelector('.add-option-form').getAttribute('data-group');
        api('/api/templates/' + templateId + '/options/' + groupKey + '/' + btn.getAttribute('data-restore'), { method: 'PATCH' }).then(function () {
          delete STATE.templateOptionsCache[templateId];
          return Promise.all([loadTemplateData(), reloadConfig()]);
        }).then(function () { toast('Restored', 'ok'); });
      });
    });
    var templateViewSelect = document.getElementById('templateViewSelect');
    if (templateViewSelect) templateViewSelect.addEventListener('change', function () {
      STATE.templateView.selectedId = templateViewSelect.value;
      loadTemplateData();
    });
    var deleteTemplateBtn = document.getElementById('deleteTemplateBtn');
    if (deleteTemplateBtn) deleteTemplateBtn.addEventListener('click', function () {
      var t = STATE.templates.find(function (x) { return x.id === templateId; });
      if (!t) return;
      if (!confirm('Delete template "' + t.name + '"? This only works if no entries use it, and cannot be undone.')) return;
      api('/api/templates/' + templateId, { method: 'DELETE' }).then(function () {
        STATE.templates = STATE.templates.filter(function (x) { return x.id !== templateId; });
        delete STATE.templateOptionsCache[templateId];
        STATE.templateView.selectedId = null;
        toast('Template "' + t.name + '" deleted', 'ok');
        render();
      }).catch(function (err) { toast(err.message, 'err'); });
    });
    var newTemplateBtn = document.getElementById('newTemplateBtn');
    if (newTemplateBtn) newTemplateBtn.addEventListener('click', function () {
      var name = prompt('New template name (e.g. "Undergrad Wellness"):');
      if (!name || !name.trim()) return;
      api('/api/templates', { method: 'POST', body: { name: name.trim() } }).then(function (d) {
        STATE.templates.push(d.template);
        STATE.templateView.selectedId = d.template.id;
        toast('Template "' + d.template.name + '" created', 'ok');
        render();
      }).catch(function (err) { toast(err.message, 'err'); });
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
    root.querySelectorAll('[data-dynamic-filter]').forEach(function (sel) {
      sel.addEventListener('change', function () { STATE.filters[sel.getAttribute('data-dynamic-filter')] = sel.value; render(); });
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
    var dashCounselor = document.getElementById('dashCounselor');
    if (dashCounselor) dashCounselor.addEventListener('change', function () { STATE.dashCounselor = dashCounselor.value; loadDashboard().then(render); });
    var exportDashboardBtn = document.getElementById('exportDashboardBtn');
    if (exportDashboardBtn) exportDashboardBtn.addEventListener('click', openExportDashboardDrawer);
    root.querySelectorAll('[data-theme-option]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.WCT_THEME.set(btn.getAttribute('data-theme-option'));
        render();
      });
    });
  }

  // ---------------- Export Dashboard (Semester x Counselor scope picker) ----------------
  function openExportDashboardDrawer() {
    STATE.drawerMode = 'export';
    var drawer = document.getElementById('drawer');
    drawer.innerHTML = '' +
      '<div class="drawer-head">' +
        '<div><div class="drawer-title">Export Dashboard</div><div class="drawer-sub">Downloads the same metrics shown on screen as a spreadsheet-ready file.</div></div>' +
        '<button class="drawer-close" id="drawerClose">&times;</button>' +
      '</div>' +
      '<div class="drawer-body">' +
        '<div class="form-section">' +
          '<div class="form-section-title">Scope</div>' +
          '<div class="form-grid">' +
            '<div class="form-field"><label>Semester</label><select id="exportSemester">' +
              '<option value="all">All Semesters</option>' +
              STATE.semesters.map(function (s) { return '<option value="' + s.id + '"' + (s.id === STATE.currentSemesterId ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="form-field"><label>Counselor</label><select id="exportCounselor"><option value="all">All Counselors</option></select></div>' +
          '</div>' +
          '<div class="small-muted" style="margin-top:10px">Includes every section on the Dashboard: student status, program breakdown, wellness hours, concerns, referral source/type, and referral date by month — computed fresh for whatever you pick here, independent of what\'s currently on screen.</div>' +
        '</div>' +
      '</div>' +
      '<div class="drawer-foot"><span></span><button class="btn primary" id="exportDashboardConfirmBtn">Download CSV</button></div>';

    openDrawer();
    document.getElementById('drawerClose').addEventListener('click', closeDrawer);

    var counselorSelect = document.getElementById('exportCounselor');
    api('/api/counselors').then(function (d) {
      d.counselors.forEach(function (name) {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === STATE.dashCounselor) opt.selected = true;
        counselorSelect.appendChild(opt);
      });
    });

    document.getElementById('exportDashboardConfirmBtn').addEventListener('click', function () {
      var semesterId = document.getElementById('exportSemester').value;
      var counselor = counselorSelect.value;
      var params = [];
      if (semesterId !== 'all') params.push('semesterId=' + encodeURIComponent(semesterId));
      if (counselor !== 'all') params.push('counselor=' + encodeURIComponent(counselor));
      window.location.href = '/api/dashboard/export' + (params.length ? '?' + params.join('&') : '');
      closeDrawer();
    });
  }

  function bindGlobalEvents() {
    document.getElementById('nav').addEventListener('click', function (e) {
      var btn = e.target.closest('.nav-item');
      if (btn) setView(btn.getAttribute('data-view'));
    });
    document.getElementById('navWellness').addEventListener('click', function (e) {
      var btn = e.target.closest('.nav-item');
      if (btn) setView(btn.getAttribute('data-view'));
    });
    document.getElementById('search').addEventListener('input', debounce(function (e) { STATE.search = e.target.value; render(); }, 120));
    document.getElementById('newEntryBtn').addEventListener('click', function () { STATE.linkedStudentPrefill = null; openEntryDrawer(null); });
    document.getElementById('exportBtn').addEventListener('click', function () {
      var qs = semesterQueryParam() ? '?semesterId=' + encodeURIComponent(semesterQueryParam()) : '';
      window.location.href = '/api/export.csv' + qs;
    });
    document.getElementById('overlay').addEventListener('click', closeDrawer);
    document.getElementById('logoutBtn').addEventListener('click', function () { window.WCT_AUTH.logout(); });
    document.getElementById('semesterSelect').addEventListener('change', function (e) { setSemester(e.target.value); });
    document.getElementById('newSemesterBtn').addEventListener('click', promptNewSemester);
    document.getElementById('deleteSemesterBtn').addEventListener('click', function () {
      var s = STATE.semesters.find(function (x) { return x.id === STATE.currentSemesterId; });
      if (!s) return;
      if (!confirm('Delete semester "' + s.label + '"? This only works if no entries use it, and cannot be undone.')) return;
      api('/api/semesters/' + s.id, { method: 'DELETE' }).then(function () {
        toast('Semester "' + s.label + '" deleted', 'ok');
        return setSemester('all');
      }).catch(function (err) { toast(err.message, 'err'); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  }

  function promptNewSemester() {
    var label = prompt('New semester name (e.g. "Fall 2026"):');
    if (!label || !label.trim()) return;
    var guess = guessSemesterDates(label.trim());
    api('/api/semesters', { method: 'POST', body: { label: label.trim(), startsOn: guess.startsOn, endsOn: guess.endsOn } }).then(function (d) {
      toast('Semester "' + d.semester.label + '" created', 'ok');
      return setSemester(d.semester.id);
    }).catch(function (err) { toast(err.message, 'err'); });
  }

  function guessSemesterDates(label) {
    var m = label.match(/(Fall|Spring|Summer)\s+(\d{4})/i);
    if (!m) return { startsOn: '', endsOn: '' };
    var season = m[1].toLowerCase(), year = m[2];
    if (season === 'fall') return { startsOn: year + '-08-01', endsOn: year + '-12-31' };
    if (season === 'spring') return { startsOn: year + '-01-01', endsOn: year + '-05-31' };
    return { startsOn: year + '-06-01', endsOn: year + '-07-31' };
  }

  // ---------------- Init ----------------
  function start(user) {
    STATE.currentUser = user;
    document.getElementById('userAvatar').textContent = initials(user.name);
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userRole').textContent = user.role === 'admin' ? 'Admin' : 'Counselor';
    if (user.role === 'admin') {
      document.getElementById('navImport').style.display = '';
      document.getElementById('navTeam').style.display = '';
      document.getElementById('navAudit').style.display = '';
      document.getElementById('adminNavDivider').style.display = '';
    }
    bindGlobalEvents();
    initIdleTimer();
    setView(STATE.view);
    loadAll().then(render).catch(function (err) { toast('Failed to load data: ' + err.message, 'err'); });
  }

  // ---------------- Idle timeout (NIST-style: 15 min idle -> forced logout) ----------------
  // The server independently enforces this on every request (see
  // server.js's currentUser()) — this timer just gives a proactive warning
  // and a clean redirect instead of the user discovering it on their next click.
  var IDLE_LIMIT_MS = 15 * 60 * 1000;
  var IDLE_WARNING_AT_MS = 14 * 60 * 1000;
  var idleLastActivity = Date.now();
  var idleWarningShown = false;
  var idleCheckHandle = null;

  function idleMarkActive() {
    idleLastActivity = Date.now();
    if (idleWarningShown) hideIdleWarning();
  }

  function showIdleWarning() {
    idleWarningShown = true;
    document.getElementById('idleOverlay').style.display = 'flex';
  }

  function hideIdleWarning() {
    idleWarningShown = false;
    document.getElementById('idleOverlay').style.display = 'none';
  }

  function idleForceLogout() {
    clearInterval(idleCheckHandle);
    api('/api/auth/logout', { method: 'POST' }).catch(function () {}).then(function () {
      window.location.reload();
    });
  }

  function initIdleTimer() {
    idleLastActivity = Date.now(); // don't count page-load time against the idle budget
    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(function (evt) {
      document.addEventListener(evt, idleMarkActive, { passive: true });
    });
    document.getElementById('idleStayBtn').addEventListener('click', function () {
      idleMarkActive();
      api('/api/auth/me').catch(function () {}); // refresh server-side last_seen_at
    });
    idleCheckHandle = setInterval(function () {
      var idleMs = Date.now() - idleLastActivity;
      if (idleMs >= IDLE_LIMIT_MS) { idleForceLogout(); return; }
      if (idleMs >= IDLE_WARNING_AT_MS) {
        if (!idleWarningShown) showIdleWarning();
        var secondsLeft = Math.max(0, Math.round((IDLE_LIMIT_MS - idleMs) / 1000));
        document.getElementById('idleCountdown').textContent = secondsLeft;
      }
    }, 1000);
  }

  window.WCT_APP = {
    start: start,
    api: api,
    toast: toast,
    escapeHtml: escapeHtml,
    fmtDate: fmtDate,
    getFields: getFields,
    getState: function () { return STATE; },
    setView: setView,
    refreshAfterImport: function () { return loadAll().then(render); },
  };
})();
