// Import wizard: parses a legacy multi-tab workbook (one sheet per
// counselor+semester, exactly like the original spreadsheet's tabs) entirely
// in the browser using SheetJS, so the admin can review and correct the
// semester/counselor mapping before anything is sent to the server.
//
// Key real-world quirk this has to handle: counselors only fill in
// First/Last Name on the row where a student's case starts. Follow-up
// interactions are logged as new rows immediately below with the name left
// blank — the row "belongs" to whichever named row is above it. This is
// forward-filled here so every imported entry carries a full student
// identity, matching how the live app models one entry per interaction.

(function () {
  'use strict';

  var IDENTITY_KEYS = ['caseStatus', 'firstName', 'lastName', 'pronouns', 'international', 'program', 'modality', 'enrollmentStatus', 'columbiaOfficer'];
  var DATE_KEYS = { referralDate: true, outreachDate: true };

  var STATE = { fileName: '', sheets: [], parsing: false, importing: false, result: null, knownUsers: [] };

  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/vendor/xlsx.full.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load the spreadsheet reader.')); };
      document.head.appendChild(s);
    });
  }

  function esc(s) { return window.WCT_APP.escapeHtml(s); }

  // ---------------- Parsing ----------------

  function excelSerialToISO(serial) {
    var d = window.XLSX.SSF.parse_date_code(serial);
    if (!d) return '';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.y + '-' + pad(d.m) + '-' + pad(d.d);
  }

  function normalizeCell(key, raw) {
    if (raw === null || raw === undefined || raw === '') return '';
    if (DATE_KEYS[key]) {
      if (typeof raw === 'number') return excelSerialToISO(raw);
      var d = new Date(raw);
      return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
    }
    if (key === 'durationMinutes') {
      var n = Number(raw);
      return isNaN(n) ? '' : n;
    }
    return String(raw).trim();
  }

  function parseSheetRows(raw, csvColumns) {
    var results = [];
    var skippedNoContext = 0;
    var currentBlock = null;
    for (var r = 1; r < raw.length; r++) {
      var row = raw[r] || [];
      var hasAnything = row.some(function (v) { return v !== null && v !== undefined && String(v).trim() !== ''; });
      if (!hasAnything) continue;
      var rawObj = {};
      csvColumns.forEach(function (c, i) { rawObj[c.key] = row[i]; });
      var hasName = rawObj.firstName && String(rawObj.firstName).trim();
      if (hasName) {
        currentBlock = {};
        IDENTITY_KEYS.forEach(function (k) { currentBlock[k] = normalizeCell(k, rawObj[k]); });
      }
      if (!currentBlock) { skippedNoContext++; continue; }
      var fields = {};
      IDENTITY_KEYS.forEach(function (k) { fields[k] = currentBlock[k] || ''; });
      csvColumns.forEach(function (c) {
        if (IDENTITY_KEYS.indexOf(c.key) === -1) fields[c.key] = normalizeCell(c.key, rawObj[c.key]);
      });
      results.push(fields);
    }
    return { entries: results, skippedNoContext: skippedNoContext };
  }

  function seasonRange(season, year) {
    if (season === 'fall') return { startsOn: year + '-08-01', endsOn: year + '-12-31' };
    if (season === 'spring') return { startsOn: year + '-01-01', endsOn: year + '-05-31' };
    return { startsOn: year + '-06-01', endsOn: year + '-07-31' };
  }

  function guessFromSheetName(name) {
    var m = name.match(/^(.*?)\s*[-–—]?\s*(Fall|Spring|Summer)\s+(\d{4})\s*$/i);
    if (m) {
      var season = m[2].toLowerCase();
      var year = m[3];
      var range = seasonRange(season, year);
      return {
        counselorName: m[1].trim(),
        semesterLabel: season.charAt(0).toUpperCase() + season.slice(1) + ' ' + year,
        startsOn: range.startsOn,
        endsOn: range.endsOn,
      };
    }
    return { counselorName: '', semesterLabel: name, startsOn: '', endsOn: '' };
  }

  function countUniqueStudents(entries) {
    var seen = {};
    entries.forEach(function (e) { seen[(e.firstName + '|' + e.lastName).toLowerCase()] = 1; });
    return Object.keys(seen).length;
  }

  function analyzeWorkbook(wb) {
    var csvColumns = window.WELLNESS_CONFIG.CSV_COLUMNS;
    var out = [];
    wb.SheetNames.forEach(function (name) {
      var ws = wb.Sheets[name];
      var raw = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      if (!raw.length) return;
      var header = raw[0] || [];
      var h1 = String(header[1] || '').trim().toLowerCase();
      var h2 = String(header[2] || '').trim().toLowerCase();
      if (h1 !== 'first name' || h2 !== 'last name') return; // not a case-log-shaped sheet — skip silently (e.g. summary tabs)

      var parsed = parseSheetRows(raw, csvColumns);
      var guess = guessFromSheetName(name);
      out.push({
        sheetName: name,
        include: parsed.entries.length > 0,
        semesterLabel: guess.semesterLabel,
        startsOn: guess.startsOn,
        endsOn: guess.endsOn,
        counselorName: guess.counselorName,
        entries: parsed.entries,
        skippedNoContext: parsed.skippedNoContext,
        studentCount: countUniqueStudents(parsed.entries),
      });
    });
    return out;
  }

  // ---------------- Rendering ----------------

  var rootEl = null;
  function rerender() { if (rootEl) render(rootEl); }

  function render(root) {
    rootEl = root;
    root.innerHTML = viewHtml();
    bind(root);
  }

  function viewHtml() {
    if (STATE.result) return resultHtml();
    return '' +
      '<div class="page-head"><div><div class="page-title">Import</div><div class="page-sub">Bring in a previous semester\'s workbook — one sheet per counselor/semester, same layout as the original template.</div></div></div>' +
      uploadCardHtml() +
      (STATE.sheets.length ? sheetsHtml() : '');
  }

  function uploadCardHtml() {
    return '<div class="card card-pad import-upload">' +
      '<div class="import-upload-inner">' +
        '<input type="file" id="importFile" accept=".xlsx,.xls" style="display:none" />' +
        '<button class="btn primary" id="importChooseBtn">' + (STATE.fileName ? 'Choose a Different File' : 'Choose Excel File (.xlsx)') + '</button>' +
        (STATE.fileName ? '<div class="small-muted" style="margin-top:8px">' + esc(STATE.fileName) + (STATE.parsing ? ' · reading…' : ' · ' + STATE.sheets.length + ' sheet(s) recognized') + '</div>' : '<div class="small-muted" style="margin-top:8px">Sheets must have "First Name" / "Last Name" as their 2nd and 3rd columns to be recognized — the same layout as the Master Doc template.</div>') +
      '</div>' +
    '</div>';
  }

  function sheetsHtml() {
    var totalEntries = 0, totalStudents = 0, included = 0;
    STATE.sheets.forEach(function (s) { if (s.include) { totalEntries += s.entries.length; totalStudents += s.studentCount; included++; } });

    var cards = STATE.sheets.map(function (s, idx) {
      var matchedUser = STATE.knownUsers.find(function (u) { return u.name.toLowerCase() === s.counselorName.trim().toLowerCase(); });
      var attributionNote = s.counselorName.trim() ?
        (matchedUser ? 'Will attribute entries to team member <b>' + esc(matchedUser.name) + '</b>.' : 'No matching team account — entries will show "Logged by ' + esc(s.counselorName.trim()) + '" without linking to a login.') :
        'No counselor name detected — entries will be unattributed unless you fill this in.';

      return '<div class="card card-pad import-sheet-card' + (s.include ? '' : ' excluded') + '">' +
        '<label class="import-sheet-head">' +
          '<input type="checkbox" data-sheet-include="' + idx + '"' + (s.include ? ' checked' : '') + ' />' +
          '<span class="import-sheet-name">' + esc(s.sheetName) + '</span>' +
          '<span class="small-muted">' + s.entries.length + ' interactions · ' + s.studentCount + ' students' + (s.skippedNoContext ? ' · ' + s.skippedNoContext + ' rows skipped (no student context)' : '') + '</span>' +
        '</label>' +
        '<div class="form-grid" style="margin-top:10px">' +
          '<div class="form-field"><label>Semester Name</label><input type="text" data-sheet-field="semesterLabel" data-sheet-idx="' + idx + '" value="' + esc(s.semesterLabel) + '" /></div>' +
          '<div class="form-field"><label>Counselor Name</label><input type="text" data-sheet-field="counselorName" data-sheet-idx="' + idx + '" value="' + esc(s.counselorName) + '" /></div>' +
          '<div class="form-field"><label>Semester Starts</label><input type="date" data-sheet-field="startsOn" data-sheet-idx="' + idx + '" value="' + esc(s.startsOn) + '" /></div>' +
          '<div class="form-field"><label>Semester Ends</label><input type="date" data-sheet-field="endsOn" data-sheet-idx="' + idx + '" value="' + esc(s.endsOn) + '" /></div>' +
        '</div>' +
        '<div class="small-muted" style="margin-top:8px">' + attributionNote + '</div>' +
      '</div>';
    }).join('');

    return '' +
      '<div class="dash-section-title" style="margin-top:20px">Detected Sheets</div>' +
      '<div class="import-sheet-list">' + cards + '</div>' +
      '<div class="card card-pad import-summary">' +
        '<div><b>' + included + '</b> sheet(s) selected · <b>' + totalEntries + '</b> entries · <b>' + totalStudents + '</b> students (approx., counted per sheet)</div>' +
        '<button class="btn primary" id="importCommitBtn"' + (included === 0 || STATE.importing ? ' disabled' : '') + '>' + (STATE.importing ? 'Importing…' : 'Import Selected Sheets') + '</button>' +
      '</div>';
  }

  function resultHtml() {
    var r = STATE.result;
    var skippedHtml = r.skipped.length ?
      '<div class="dash-section-title" style="margin-top:18px">Skipped Rows <span class="hint">' + r.skipped.length + ' rows could not be imported</span></div>' +
      '<div class="card card-pad"><div class="import-skip-list">' +
        r.skipped.slice(0, 50).map(function (s) { return '<div class="small-muted">Row ' + s.row + ': ' + esc(s.reason) + '</div>'; }).join('') +
        (r.skipped.length > 50 ? '<div class="small-muted">+ ' + (r.skipped.length - 50) + ' more</div>' : '') +
      '</div></div>' : '';

    return '' +
      '<div class="page-head"><div><div class="page-title">Import Complete</div></div></div>' +
      '<div class="stat-grid">' +
        '<div class="card stat-card"><div class="stat-label">Entries Imported</div><div class="stat-value">' + r.entriesImported + '</div></div>' +
        '<div class="card stat-card"><div class="stat-label">Semesters Created</div><div class="stat-value">' + r.semestersCreated + '</div></div>' +
        '<div class="card stat-card"><div class="stat-label">Rows Skipped</div><div class="stat-value">' + r.skipped.length + '</div></div>' +
      '</div>' +
      skippedHtml +
      '<div style="margin-top:18px;display:flex;gap:8px">' +
        '<button class="btn primary" id="importGoLogBtn">Go to Case Log</button>' +
        '<button class="btn" id="importAnotherBtn">Import Another File</button>' +
      '</div>';
  }

  // ---------------- Events ----------------

  function bind(root) {
    var fileInput = document.getElementById('importFile');
    var chooseBtn = document.getElementById('importChooseBtn');
    if (chooseBtn) chooseBtn.addEventListener('click', function () { fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    root.querySelectorAll('[data-sheet-include]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        STATE.sheets[Number(cb.getAttribute('data-sheet-include'))].include = cb.checked;
        rerender();
      });
    });
    root.querySelectorAll('[data-sheet-field]').forEach(function (input) {
      input.addEventListener('change', function () {
        var idx = Number(input.getAttribute('data-sheet-idx'));
        var field = input.getAttribute('data-sheet-field');
        STATE.sheets[idx][field] = input.value;
      });
    });

    var commitBtn = document.getElementById('importCommitBtn');
    if (commitBtn) commitBtn.addEventListener('click', commitImport);

    var goLogBtn = document.getElementById('importGoLogBtn');
    if (goLogBtn) goLogBtn.addEventListener('click', function () {
      window.WCT_APP.refreshAfterImport().then(function () {
        document.querySelector('.nav-item[data-view="log"]').click();
      });
    });
    var againBtn = document.getElementById('importAnotherBtn');
    if (againBtn) againBtn.addEventListener('click', function () {
      STATE = { fileName: '', sheets: [], parsing: false, importing: false, result: null, knownUsers: STATE.knownUsers };
      rerender();
    });
  }

  function handleFile(file) {
    STATE.fileName = file.name;
    STATE.parsing = true;
    STATE.sheets = [];
    rerender();

    var loadUsers = window.WCT_APP.api('/api/users').then(function (d) { STATE.knownUsers = d.users; }).catch(function () { STATE.knownUsers = []; });

    Promise.all([ensureXLSX(), loadUsers]).then(function () {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          var wb = window.XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          STATE.sheets = analyzeWorkbook(wb);
          if (!STATE.sheets.length) {
            window.WCT_APP.toast('No recognizable case-log sheets found in that file.', 'err');
          }
        } catch (err) {
          window.WCT_APP.toast('Could not read that file: ' + err.message, 'err');
        }
        STATE.parsing = false;
        rerender();
      };
      reader.onerror = function () {
        window.WCT_APP.toast('Could not read that file.', 'err');
        STATE.parsing = false;
        rerender();
      };
      reader.readAsArrayBuffer(file);
    }).catch(function (err) {
      window.WCT_APP.toast(err.message, 'err');
      STATE.parsing = false;
      rerender();
    });
  }

  function commitImport() {
    var included = STATE.sheets.filter(function (s) { return s.include; });
    if (!included.length) return;

    var semesterMap = {};
    var semesters = [];
    included.forEach(function (s) {
      var label = s.semesterLabel.trim();
      if (!label || semesterMap[label]) return;
      semesterMap[label] = true;
      semesters.push({ label: label, startsOn: s.startsOn || null, endsOn: s.endsOn || null });
    });

    var entries = [];
    included.forEach(function (s) {
      var label = s.semesterLabel.trim();
      var counselorName = s.counselorName.trim();
      s.entries.forEach(function (fields) {
        entries.push({ fields: fields, semesterLabel: label, counselorName: counselorName });
      });
    });

    STATE.importing = true;
    rerender();

    window.WCT_APP.api('/api/import', { method: 'POST', body: { semesters: semesters, entries: entries } }).then(function (result) {
      STATE.importing = false;
      STATE.result = result;
      rerender();
      window.WCT_APP.toast('Imported ' + result.entriesImported + ' entries.', 'ok');
    }).catch(function (err) {
      STATE.importing = false;
      rerender();
      window.WCT_APP.toast('Import failed: ' + err.message, 'err');
    });
  }

  window.WCT_IMPORT = { render: render };
})();
