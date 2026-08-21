// Import wizard: parses any .xlsx/.xls workbook or .csv file entirely in the
// browser (SheetJS for spreadsheets, a small hand-rolled parser for CSV —
// mirrors lib/csv.js's approach so nothing new is vendored), detects a
// Student ID/Name column plus whatever other columns are present, and infers
// each other column's type (select/date/number/text/textarea) from its
// actual values — no fixed/expected column layout. The admin reviews and can
// adjust every detected field's label/type before anything is imported.
//
// Real-world quirk this still handles: some sheets only fill in the name on
// a student's first interaction row, leaving it blank on follow-up rows
// directly below. Those rows are forward-filled to the last-seen identity —
// but only the identity columns (name/Student ID); every other detected
// field is taken literally per row, since there's no way to know which
// other columns are "identity" (should inherit) vs. "per-interaction"
// (shouldn't) without hardcoding assumptions about what they mean.

(function () {
  'use strict';

  var STATE = { fileName: '', sheets: [], parsing: false, importing: false, importProgress: { current: 0, total: 0 }, result: null, knownUsers: [] };
  var CHUNK_SIZE = 500; // entries per /api/import request — avoids one giant request timing out on a large file

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
  function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  // ---------------- CSV parsing (browser-side; mirrors lib/csv.js) ----------------

  function parseCSVText(text) {
    var rows = [], row = [], field = '', inQuotes = false, i = 0, len = text.length;
    function endField() { row.push(field); field = ''; }
    function endRow() { endField(); rows.push(row); row = []; }
    while (i < len) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { endField(); i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { endRow(); i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  // ---------------- Date handling (timezone-safe — see header comment history) ----------------
  // cellDates:true was tried and reverted earlier in this project: it
  // converts via JS Date objects using the executing browser's local
  // timezone, which can shift the day. excelSerialToISO does pure
  // arithmetic on the Excel serial number instead. For string dates (CSV,
  // or a text-formatted spreadsheet cell), the ISO and US-slash branches
  // below likewise avoid ever constructing a Date object for the common
  // cases; only the final fallback risks the same class of bug, for date
  // formats neither pattern matches.

  function excelSerialToISO(serial) {
    var d = window.XLSX.SSF.parse_date_code(serial);
    if (!d) return '';
    return d.y + '-' + pad2(d.m) + '-' + pad2(d.d);
  }

  function normalizeDateValue(rawValue, formattedValue) {
    if (typeof rawValue === 'number') return excelSerialToISO(rawValue);
    var s = String(formattedValue !== undefined && formattedValue !== null ? formattedValue : (rawValue || '')).trim();
    if (!s) return '';
    var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return iso[1] + '-' + pad2(iso[2]) + '-' + pad2(iso[3]);
    var us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (us) { var yr = us[3].length === 2 ? '20' + us[3] : us[3]; return yr + '-' + pad2(us[1]) + '-' + pad2(us[2]); }
    var d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
  }

  // ---------------- Column detection / type inference ----------------

  var ID_HEADER_RE = /^(student\s*id|id|sid|student\s*#|student\s*number)$/i;
  var FIRST_NAME_RE = /^(first\s*name|fname|given\s*name)$/i;
  var LAST_NAME_RE = /^(last\s*name|lname|surname|family\s*name)$/i;
  var FULL_NAME_RE = /^(full\s*name|name|student\s*name)$/i;

  function detectIdentityColumns(header) {
    var idIdx = -1, firstIdx = -1, lastIdx = -1, fullIdx = -1;
    header.forEach(function (h, i) {
      var t = String(h || '').trim();
      if (idIdx === -1 && ID_HEADER_RE.test(t)) idIdx = i;
      else if (firstIdx === -1 && FIRST_NAME_RE.test(t)) firstIdx = i;
      else if (lastIdx === -1 && LAST_NAME_RE.test(t)) lastIdx = i;
      else if (fullIdx === -1 && FULL_NAME_RE.test(t)) fullIdx = i;
    });
    return { idIdx: idIdx, firstIdx: firstIdx, lastIdx: lastIdx, fullIdx: fullIdx };
  }

  function slugifyKey(header, usedKeys) {
    var words = String(header || '').trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
    var key = words.length ? words[0].toLowerCase() + words.slice(1).map(function (w) { return w[0].toUpperCase() + w.slice(1).toLowerCase(); }).join('') : 'field';
    var base = key, n = 2;
    while (usedKeys[key]) { key = base + n; n++; }
    usedKeys[key] = true;
    return key;
  }

  function looksLikeDateString(v) {
    var s = String(v || '').trim();
    if (!s || !/\d/.test(s)) return false;
    if (!/[-/]/.test(s) && !/^[A-Za-z]+ \d{1,2},? \d{4}$/.test(s)) return false;
    return !isNaN(Date.parse(s));
  }

  // Classifies a column from its actual values — no assumption about what
  // the column "should" be. date/number need an 80% majority (mixed/messy
  // columns fall through to text rather than mis-typing); select needs a
  // small, repeated set of distinct values (a real dropdown-shaped column,
  // not free text that happens to repeat a little).
  function inferColumnType(values) {
    var nonEmpty = values.filter(function (v) { return v !== null && v !== undefined && String(v).trim() !== ''; });
    if (!nonEmpty.length) return 'text';
    var dateCount = nonEmpty.filter(looksLikeDateString).length;
    if (dateCount / nonEmpty.length >= 0.8) return 'date';
    var numCount = nonEmpty.filter(function (v) { return String(v).trim() !== '' && !isNaN(Number(v)); }).length;
    if (numCount / nonEmpty.length >= 0.8) return 'number';
    var distinct = {};
    nonEmpty.forEach(function (v) { distinct[String(v).trim()] = true; });
    var distinctVals = Object.keys(distinct);
    if (distinctVals.length <= 30 && distinctVals.length / nonEmpty.length < 0.5) return 'select';
    var avgLen = nonEmpty.reduce(function (sum, v) { return sum + String(v).length; }, 0) / nonEmpty.length;
    return avgLen > 60 ? 'textarea' : 'text';
  }

  // header/formattedRows drive detection + most values; rawRows (same shape)
  // is only consulted for date-type columns, to reach the Excel serial
  // number for excelSerialToISO. For CSV, raw === formatted (plain strings).
  function analyzeGrid(header, formattedRows, rawRows) {
    var ident = detectIdentityColumns(header);
    var hasFirstLast = ident.firstIdx !== -1 && ident.lastIdx !== -1;
    var hasFullName = ident.fullIdx !== -1;
    if (!hasFirstLast && !hasFullName) return null;

    var identityIdxSet = {};
    [ident.idIdx, ident.firstIdx, ident.lastIdx, ident.fullIdx].forEach(function (i) { if (i !== -1) identityIdxSet[i] = true; });

    var usedKeys = {};
    var columns = header.map(function (h, i) {
      if (identityIdxSet[i]) return null;
      var label = String(h || '').trim();
      if (!label) return null;
      var colValues = formattedRows.map(function (r) { return r[i]; });
      return { index: i, key: slugifyKey(label, usedKeys), label: label, type: inferColumnType(colValues) };
    }).filter(Boolean);

    // Computed for every column, not just ones detected as 'select' — so if
    // the admin overrides a column's type to 'select' in the review UI, its
    // dropdown isn't left empty.
    columns.forEach(function (c) {
      var seen = {}, opts = [];
      formattedRows.forEach(function (r) {
        var v = String(r[c.index] || '').trim();
        if (v && !seen[v]) { seen[v] = true; opts.push(v); }
      });
      c.options = opts;
    });

    var rows = [], skippedNoContext = 0, currentIdentity = null;
    for (var r = 0; r < formattedRows.length; r++) {
      var row = formattedRows[r] || [];
      var hasAnything = row.some(function (v) { return v !== null && v !== undefined && String(v).trim() !== ''; });
      if (!hasAnything) continue;

      var firstName = '', lastName = '', studentId = '';
      if (hasFirstLast) {
        firstName = String(row[ident.firstIdx] || '').trim();
        lastName = String(row[ident.lastIdx] || '').trim();
      } else if (hasFullName) {
        var full = String(row[ident.fullIdx] || '').trim();
        var parts = full.split(/\s+/);
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
      }
      if (ident.idIdx !== -1) studentId = String(row[ident.idIdx] || '').trim();

      if (firstName || lastName) currentIdentity = { firstName: firstName, lastName: lastName, studentId: studentId };
      if (!currentIdentity) { skippedNoContext++; continue; }

      var fields = {};
      columns.forEach(function (c) {
        var rawVal = rawRows[r] ? rawRows[r][c.index] : undefined;
        var formattedVal = row[c.index];
        if (c.type === 'date') fields[c.key] = normalizeDateValue(rawVal, formattedVal);
        else if (c.type === 'number') {
          var n = Number(rawVal !== undefined && rawVal !== null && rawVal !== '' ? rawVal : formattedVal);
          fields[c.key] = isNaN(n) ? '' : n;
        } else fields[c.key] = formattedVal === null || formattedVal === undefined ? '' : String(formattedVal).trim();
      });

      rows.push({ firstName: currentIdentity.firstName, lastName: currentIdentity.lastName, studentIdExternal: currentIdentity.studentId, fields: fields });
    }

    return { fields: columns, rows: rows, skippedNoContext: skippedNoContext };
  }

  function seasonRange(season, year) {
    if (season === 'fall') return { startsOn: year + '-08-01', endsOn: year + '-12-31' };
    if (season === 'spring') return { startsOn: year + '-01-01', endsOn: year + '-05-31' };
    return { startsOn: year + '-06-01', endsOn: year + '-07-31' };
  }

  function guessFromSheetName(name) {
    var m = name.match(/^(.*?)\s*[-–—]?\s*(Fall|Spring|Summer)\s+(\d{4})\s*$/i);
    if (m) {
      var season = m[2].toLowerCase(), year = m[3];
      var range = seasonRange(season, year);
      return { counselorName: m[1].trim(), semesterLabel: season.charAt(0).toUpperCase() + season.slice(1) + ' ' + year, startsOn: range.startsOn, endsOn: range.endsOn };
    }
    return { counselorName: '', semesterLabel: name, startsOn: '', endsOn: '' };
  }

  function countUniqueStudents(rows) {
    var seen = {};
    rows.forEach(function (r) { seen[(r.firstName + '|' + r.lastName).toLowerCase()] = 1; });
    return Object.keys(seen).length;
  }

  function analyzeWorkbook(wb) {
    var out = [];
    wb.SheetNames.forEach(function (name) {
      var ws = wb.Sheets[name];
      var formatted = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
      var raw = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      if (!formatted.length) return;
      var analysis = analyzeGrid(formatted[0] || [], formatted.slice(1), raw.slice(1));
      if (!analysis) return;
      var guess = guessFromSheetName(name);
      out.push(Object.assign({
        sheetKey: 'xlsx:' + name, sheetName: name, include: analysis.rows.length > 0,
        semesterLabel: guess.semesterLabel, startsOn: guess.startsOn, endsOn: guess.endsOn, counselorName: guess.counselorName,
        studentCount: countUniqueStudents(analysis.rows),
      }, analysis));
    });
    return out;
  }

  function analyzeCSV(fileName, text) {
    var grid = parseCSVText(text);
    if (!grid.length) return [];
    var analysis = analyzeGrid(grid[0], grid.slice(1), grid.slice(1));
    if (!analysis) return [];
    var baseName = fileName.replace(/\.[^.]+$/, '');
    var guess = guessFromSheetName(baseName);
    return [Object.assign({
      sheetKey: 'csv:' + fileName, sheetName: baseName, include: analysis.rows.length > 0,
      semesterLabel: guess.semesterLabel, startsOn: guess.startsOn, endsOn: guess.endsOn, counselorName: guess.counselorName,
      studentCount: countUniqueStudents(analysis.rows),
    }, analysis)];
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
      '<div class="page-head"><div><div class="page-title">Import</div><div class="page-sub">Bring in any spreadsheet or CSV — columns are detected automatically, not assumed.</div></div></div>' +
      uploadCardHtml() +
      (STATE.sheets.length ? sheetsHtml() : '');
  }

  function uploadCardHtml() {
    return '<div class="card card-pad import-upload">' +
      '<div class="import-upload-inner">' +
        '<input type="file" id="importFile" accept=".xlsx,.xls,.csv" style="display:none" />' +
        '<button class="btn primary" id="importChooseBtn">' + (STATE.fileName ? 'Choose a Different File' : 'Choose a File (.xlsx or .csv)') + '</button>' +
        (STATE.fileName ? '<div class="small-muted" style="margin-top:8px">' + esc(STATE.fileName) + (STATE.parsing ? ' · reading…' : ' · ' + STATE.sheets.length + ' sheet(s) recognized') + '</div>' :
          '<div class="small-muted" style="margin-top:8px">We look for a Student ID and/or Name column to recognize a sheet, then detect every other column\'s type from its values — review and adjust below before anything is imported.</div>') +
      '</div>' +
    '</div>';
  }

  function sheetsHtml() {
    var totalRows = 0, totalStudents = 0, included = 0;
    STATE.sheets.forEach(function (s) { if (s.include) { totalRows += s.rows.length; totalStudents += s.studentCount; included++; } });

    var cards = STATE.sheets.map(function (s, idx) {
      var matchedUser = STATE.knownUsers.find(function (u) { return u.name.toLowerCase() === s.counselorName.trim().toLowerCase(); });
      var attributionNote = s.counselorName.trim() ?
        (matchedUser ? 'Will attribute entries to team member <b>' + esc(matchedUser.name) + '</b>.' : 'No matching team account — entries will show "Logged by ' + esc(s.counselorName.trim()) + '" without linking to a login.') :
        'No counselor name detected — entries will be unattributed unless you fill this in.';

      var fieldRows = s.fields.map(function (f, fIdx) {
        return '<div class="import-field-row">' +
          '<input type="text" data-field-label="' + fIdx + '" data-sheet-idx="' + idx + '" value="' + esc(f.label) + '" />' +
          '<select data-field-type="' + fIdx + '" data-sheet-idx="' + idx + '">' +
            ['text', 'select', 'date', 'number', 'textarea'].map(function (t) { return '<option value="' + t + '"' + (f.type === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') +
          '</select>' +
          (f.type === 'select' && f.options ? '<span class="small-muted">' + f.options.length + ' distinct value(s)</span>' : '') +
        '</div>';
      }).join('');

      return '<div class="card card-pad import-sheet-card' + (s.include ? '' : ' excluded') + '">' +
        '<label class="import-sheet-head">' +
          '<input type="checkbox" data-sheet-include="' + idx + '"' + (s.include ? ' checked' : '') + ' />' +
          '<span class="import-sheet-name">' + esc(s.sheetName) + '</span>' +
          '<span class="small-muted">' + s.rows.length + ' rows · ' + s.studentCount + ' students' + (s.skippedNoContext ? ' · ' + s.skippedNoContext + ' rows skipped (no name found yet)' : '') + '</span>' +
        '</label>' +
        '<div class="form-grid" style="margin-top:10px">' +
          '<div class="form-field"><label>Semester Name</label><input type="text" data-sheet-field="semesterLabel" data-sheet-idx="' + idx + '" value="' + esc(s.semesterLabel) + '" /></div>' +
          '<div class="form-field"><label>Counselor Name</label><input type="text" data-sheet-field="counselorName" data-sheet-idx="' + idx + '" value="' + esc(s.counselorName) + '" /></div>' +
          '<div class="form-field"><label>Semester Starts</label><input type="date" data-sheet-field="startsOn" data-sheet-idx="' + idx + '" value="' + esc(s.startsOn) + '" /></div>' +
          '<div class="form-field"><label>Semester Ends</label><input type="date" data-sheet-field="endsOn" data-sheet-idx="' + idx + '" value="' + esc(s.endsOn) + '" /></div>' +
        '</div>' +
        '<div class="small-muted" style="margin-top:8px">' + attributionNote + '</div>' +
        '<details class="archived-details" style="margin-top:14px">' +
          '<summary>' + s.fields.length + ' column(s) detected automatically — review or adjust (optional)</summary>' +
          '<div class="import-field-list" style="margin-top:10px">' + (fieldRows || '<div class="small-muted">No other columns detected — just identity fields.</div>') + '</div>' +
        '</details>' +
      '</div>';
    }).join('');

    var importBtnLabel = STATE.importing ?
      'Importing… ' + STATE.importProgress.current + ' / ' + STATE.importProgress.total :
      'Import Selected Sheets';

    return '' +
      '<div class="dash-section-title" style="margin-top:20px">Detected Sheets</div>' +
      '<div class="small-muted" style="margin-bottom:14px">Column types are detected automatically — nothing below requires your input unless something looks wrong.</div>' +
      '<div class="import-sheet-list">' + cards + '</div>' +
      '<div class="card card-pad import-summary">' +
        '<div><b>' + included + '</b> sheet(s) selected · <b>' + totalRows + '</b> entries · <b>' + totalStudents + '</b> students (approx., counted per sheet)</div>' +
        '<button class="btn primary" id="importCommitBtn"' + (included === 0 || STATE.importing ? ' disabled' : '') + '>' + esc(importBtnLabel) + '</button>' +
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
    root.querySelectorAll('[data-field-label]').forEach(function (input) {
      input.addEventListener('change', function () {
        var idx = Number(input.getAttribute('data-sheet-idx'));
        var fIdx = Number(input.getAttribute('data-field-label'));
        STATE.sheets[idx].fields[fIdx].label = input.value;
      });
    });
    root.querySelectorAll('[data-field-type]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var idx = Number(sel.getAttribute('data-sheet-idx'));
        var fIdx = Number(sel.getAttribute('data-field-type'));
        STATE.sheets[idx].fields[fIdx].type = sel.value;
        rerender();
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
      STATE = { fileName: '', sheets: [], parsing: false, importing: false, importProgress: { current: 0, total: 0 }, result: null, knownUsers: STATE.knownUsers };
      rerender();
    });
  }

  function handleFile(file) {
    STATE.fileName = file.name;
    STATE.parsing = true;
    STATE.sheets = [];
    rerender();

    var loadUsers = window.WCT_APP.api('/api/users').then(function (d) { STATE.knownUsers = d.users; }).catch(function () { STATE.knownUsers = []; });
    var isCSV = /\.csv$/i.test(file.name);

    var readP = isCSV ?
      new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function (e) { resolve(analyzeCSV(file.name, e.target.result)); };
        reader.onerror = function () { reject(new Error('Could not read that file.')); };
        reader.readAsText(file);
      }) :
      ensureXLSX().then(function () {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function (e) {
            try { resolve(analyzeWorkbook(window.XLSX.read(new Uint8Array(e.target.result), { type: 'array' }))); }
            catch (err) { reject(err); }
          };
          reader.onerror = function () { reject(new Error('Could not read that file.')); };
          reader.readAsArrayBuffer(file);
        });
      });

    Promise.all([readP, loadUsers]).then(function (r) {
      STATE.sheets = r[0];
      if (!STATE.sheets.length) window.WCT_APP.toast('No recognizable data found — need a Student ID and/or Name column.', 'err');
      STATE.parsing = false;
      rerender();
    }).catch(function (err) {
      window.WCT_APP.toast('Could not read that file: ' + err.message, 'err');
      STATE.parsing = false;
      rerender();
    });
  }

  // Creates a template (with no cloned fields — see the `blank` flag) plus
  // one field per detected column, and select options for select-type
  // fields. Sheets sharing an identical field signature (same keys+types)
  // reuse one template rather than creating a duplicate per sheet — common
  // when a source system exports one CSV per semester with the same columns.
  function resolveTemplatesForSheets(sheets) {
    var bySignature = {}, sheetToTemplateId = {}, chain = Promise.resolve();
    sheets.forEach(function (s) {
      var sig = s.fields.map(function (f) { return f.key + ':' + f.type; }).join('|');
      chain = chain.then(function () {
        if (bySignature[sig]) { sheetToTemplateId[s.sheetKey] = bySignature[sig]; return; }
        return createTemplateForFields(s.sheetName, s.fields).then(function (templateId) {
          bySignature[sig] = templateId;
          sheetToTemplateId[s.sheetKey] = templateId;
        });
      });
    });
    return chain.then(function () { return sheetToTemplateId; });
  }

  // Fields (and each select field's options) are created in parallel rather
  // than one-request-at-a-time — a sheet with 27 columns was previously 27+
  // sequential round trips before the actual import could even start.
  function createTemplateForFields(name, fields) {
    var templateName = (name || 'Import') + ' — ' + new Date().toISOString().slice(0, 10);
    return window.WCT_APP.api('/api/templates', { method: 'POST', body: { name: templateName, blank: true } }).then(function (d) {
      var templateId = d.template.id;
      return Promise.all(fields.map(function (f) {
        return window.WCT_APP.api('/api/templates/' + templateId + '/fields', { method: 'POST', body: { fieldKey: f.key, label: f.label, fieldType: f.type, section: 'Imported Fields' } })
          .then(function () {
            if (f.type !== 'select') return;
            return Promise.all((f.options || []).map(function (opt) {
              return window.WCT_APP.api('/api/templates/' + templateId + '/options/' + f.key, { method: 'POST', body: { value: opt } });
            }));
          });
      })).then(function () { return templateId; });
    });
  }

  // Sent in chunks (not one request for the whole file) so a large import
  // can't time out a single request, and so the button can show real
  // progress instead of just "Importing…" with no feedback for a long file.
  function commitImport() {
    var included = STATE.sheets.filter(function (s) { return s.include; });
    if (!included.length) return;

    var semesterMap = {}, semesters = [];
    included.forEach(function (s) {
      var label = s.semesterLabel.trim();
      if (!label || semesterMap[label]) return;
      semesterMap[label] = true;
      semesters.push({ label: label, startsOn: s.startsOn || null, endsOn: s.endsOn || null });
    });

    STATE.importing = true;
    STATE.importProgress = { current: 0, total: 0 };
    rerender();

    resolveTemplatesForSheets(included).then(function (sheetToTemplateId) {
      var entries = [];
      included.forEach(function (s) {
        var label = s.semesterLabel.trim();
        var counselorName = s.counselorName.trim();
        var templateId = sheetToTemplateId[s.sheetKey];
        s.rows.forEach(function (row) {
          entries.push({
            fields: Object.assign({ firstName: row.firstName, lastName: row.lastName, studentIdExternal: row.studentIdExternal }, row.fields),
            semesterLabel: label, counselorName: counselorName, templateId: templateId,
          });
        });
      });

      STATE.importProgress.total = entries.length;
      rerender();

      var chunks = [];
      for (var i = 0; i < entries.length; i += CHUNK_SIZE) chunks.push(entries.slice(i, i + CHUNK_SIZE));

      var aggregate = { semestersCreated: 0, entriesImported: 0, totalRows: entries.length, skipped: [] };
      var chain = Promise.resolve();
      chunks.forEach(function (chunk, idx) {
        chain = chain.then(function () {
          // semesters sent on every chunk, not just the first — semester
          // creation is idempotent (ON CONFLICT) server-side, and every
          // chunk needs its own semesterId lookups to resolve correctly.
          return window.WCT_APP.api('/api/import', { method: 'POST', body: { semesters: semesters, entries: chunk } });
        }).then(function (result) {
          aggregate.entriesImported += result.entriesImported;
          aggregate.semestersCreated = result.semestersCreated;
          aggregate.skipped = aggregate.skipped.concat((result.skipped || []).map(function (s) { return { row: s.row + idx * CHUNK_SIZE, reason: s.reason }; }));
          STATE.importProgress.current = Math.min(entries.length, (idx + 1) * CHUNK_SIZE);
          rerender();
        });
      });
      return chain.then(function () { return aggregate; });
    }).then(function (result) {
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
