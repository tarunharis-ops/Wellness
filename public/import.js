// Import wizard: parses any .xlsx/.xls workbook or .csv file entirely in the
// browser (SheetJS for spreadsheets, a small hand-rolled parser for CSV) and
// maps each detected column onto the app's fixed field set
// (window.WELLNESS_CONFIG.FIELDS — the same 26 Columbia-specific fields the
// entry form and Dashboard use) by fuzzy-matching header text against each
// field's label and a short synonym list. Nothing is invented — a column
// that doesn't match anything well enough is left unmapped ("Don't Import")
// rather than becoming a new ad hoc field. This is the architecture
// decision this project settled on: normalize incoming data onto a known
// schema before it reaches the database, rather than storing arbitrary
// structure and dealing with the consequences downstream.
//
// Real-world quirk this still handles: some sheets only fill in the name on
// a student's first interaction row, leaving it blank on follow-up rows
// directly below. Those rows are forward-filled to the last-seen identity.

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

  // ---------------- Date handling (timezone-safe) ----------------
  // cellDates:true was tried and reverted earlier in this project: it
  // converts via JS Date objects using the executing browser's local
  // timezone, which can shift the day. excelSerialToISO does pure
  // arithmetic on the Excel serial number instead. For string dates (CSV,
  // or a text-formatted spreadsheet cell), the ISO and US-slash branches
  // below likewise avoid ever constructing a Date object for the common
  // cases; only the final fallback risks the same class of bug.

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

  // ---------------- Identity column detection ----------------

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

  // ---------------- Fuzzy column -> fixed field matching ----------------
  // A short hand-picked synonym list per field, covering the header
  // variants a real export is likely to use. Not exhaustive by design —
  // anything that doesn't score well enough is left for the admin to map
  // manually (or skip) in the review step, rather than guessing.
  var FIELD_SYNONYMS = {
    caseStatus: ['case status'],
    pronouns: ['pronouns', 'pronoun'],
    international: ['international', 'international student'],
    program: ['program', 'major'],
    modality: ['modality', 'in person or online only', 'in person online', 'mode'],
    enrollmentStatus: ['enrollment status', 'enrollment'],
    columbiaOfficer: ['columbia officer', 'university officer'],
    nabitaRisk: ['nabita risk rubric', 'nabita risk', 'risk', 'risk level', 'risk rubric'],
    referralSource: ['referral source'],
    referralDate: ['referral date'],
    outreachType: ['outreach type'],
    outreachMethod: ['outreach method'],
    outreachDate: ['outreach date', 'date', 'contact date'],
    outreachConducted: ['outreach conducted'],
    durationMinutes: ['duration of outreach', 'duration', 'minutes', 'duration minutes'],
    outreachOutcome: ['outreach outcome', 'outcome'],
    concernPrimary: ['wellness primary concern', 'primary concern', 'concern primary'],
    concernSecondary: ['wellness secondary concern', 'secondary concern', 'concern secondary'],
    concernTertiary: ['wellness tertiary concern', 'tertiary concern', 'concern tertiary'],
    referralsMade: ['referrals made'],
    referralPrimary: ['referral primary', 'primary referral'],
    referralSecondary: ['referral secondary', 'secondary referral'],
    referralTertiary: ['referral tertiary', 'tertiary referral'],
    notes: ['notes', 'comments', 'note'],
  };
  var NON_MAPPABLE_KEYS = { firstName: true, lastName: true, studentIdExternal: true };

  function normalizeText(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function tokenScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return 70;
    var aTokens = a.split(' '), bTokens = b.split(' ');
    var shared = aTokens.filter(function (t) { return bTokens.indexOf(t) !== -1; }).length;
    var union = new Set(aTokens.concat(bTokens)).size;
    return union ? Math.round((shared / union) * 60) : 0;
  }

  // Returns the best-matching field key for a header, or '' if nothing
  // scores highly enough to trust as a default — including when the top
  // score is a tie between two *different* fields (e.g. a bare "Status"
  // column scores equally against Case Status and Enrollment Status; since
  // the header alone can't disambiguate, guessing either would be actively
  // wrong for the loser, so it's left for the admin to pick).
  function suggestFieldForHeader(header, mappableFields) {
    var norm = normalizeText(header);
    var bestScore = 0, bestKeys = [];
    mappableFields.forEach(function (f) {
      var candidates = [normalizeText(f.label)].concat((FIELD_SYNONYMS[f.key] || []).map(normalizeText));
      var fieldScore = candidates.reduce(function (max, c) { return Math.max(max, tokenScore(norm, c)); }, 0);
      if (fieldScore > bestScore) { bestScore = fieldScore; bestKeys = [f.key]; }
      else if (fieldScore === bestScore && fieldScore > 0) { bestKeys.push(f.key); }
    });
    return bestScore >= 40 && bestKeys.length === 1 ? bestKeys[0] : '';
  }

  // header/formattedRows drive detection + most values; rawRows (same shape)
  // is only consulted for date-mapped columns, to reach the Excel serial
  // number for excelSerialToISO. For CSV, raw === formatted.
  function analyzeGrid(header, formattedRows, rawRows) {
    var ident = detectIdentityColumns(header);
    var hasFirstLast = ident.firstIdx !== -1 && ident.lastIdx !== -1;
    var hasFullName = ident.fullIdx !== -1;
    if (!hasFirstLast && !hasFullName) return null;

    var identityIdxSet = {};
    [ident.idIdx, ident.firstIdx, ident.lastIdx, ident.fullIdx].forEach(function (i) { if (i !== -1) identityIdxSet[i] = true; });

    var mappableFields = (window.WELLNESS_CONFIG.FIELDS || []).filter(function (f) { return !NON_MAPPABLE_KEYS[f.key]; });

    var columns = header.map(function (h, i) {
      if (identityIdxSet[i]) return null;
      var label = String(h || '').trim();
      if (!label) return null;
      return { index: i, header: label, mappedTo: suggestFieldForHeader(label, mappableFields) };
    }).filter(Boolean);

    // A student's row block in these sheets often carries case-level info
    // (Case Status, Program, NABITA Risk, ...) only on the first row, with
    // follow-up rows underneath left blank for those columns — they exist
    // only to log another outreach event for the same case. "Case" and
    // "referral" section fields are carried forward from the block's first
    // row when a follow-up row leaves them blank; per-event fields
    // (outreach/concerns/referrals/notes) are always read fresh per row,
    // since those genuinely differ event to event.
    var CARRY_SECTIONS = { case: true, referral: true };

    var rows = [], skippedNoContext = 0, currentIdentity = null, carried = {};
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

      if (firstName || lastName) {
        currentIdentity = { firstName: firstName, lastName: lastName, studentId: studentId };
        carried = {};
      }
      if (!currentIdentity) { skippedNoContext++; continue; }

      var fields = { firstName: currentIdentity.firstName, lastName: currentIdentity.lastName, studentIdExternal: currentIdentity.studentId };
      columns.forEach(function (c) {
        if (!c.mappedTo) return;
        var fieldDef = mappableFields.find(function (f) { return f.key === c.mappedTo; });
        var rawVal = rawRows[r] ? rawRows[r][c.index] : undefined;
        var formattedVal = row[c.index];
        var value;
        if (fieldDef && fieldDef.type === 'date') value = normalizeDateValue(rawVal, formattedVal);
        else if (fieldDef && fieldDef.type === 'number') {
          var n = Number(rawVal !== undefined && rawVal !== null && rawVal !== '' ? rawVal : formattedVal);
          value = isNaN(n) ? '' : n;
        } else value = formattedVal === null || formattedVal === undefined ? '' : String(formattedVal).trim();

        if (fieldDef && CARRY_SECTIONS[fieldDef.section]) {
          if (value === '' || value === null) value = carried.hasOwnProperty(c.mappedTo) ? carried[c.mappedTo] : value;
          else carried[c.mappedTo] = value;
        }
        fields[c.mappedTo] = value;
      });

      rows.push(fields);
    }

    return { columns: columns, rows: rows, skippedNoContext: skippedNoContext };
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
      '<div class="page-head"><div><div class="page-title">Import</div><div class="page-sub">Bring in any spreadsheet or CSV — columns are matched to the existing fields automatically.</div></div></div>' +
      uploadCardHtml() +
      (STATE.sheets.length ? sheetsHtml() : '');
  }

  function uploadCardHtml() {
    return '<div class="card card-pad import-upload">' +
      '<div class="import-upload-inner">' +
        '<input type="file" id="importFile" accept=".xlsx,.xls,.csv" style="display:none" />' +
        '<button class="btn primary" id="importChooseBtn">' + (STATE.fileName ? 'Choose a Different File' : 'Choose a File (.xlsx or .csv)') + '</button>' +
        (STATE.fileName ? '<div class="small-muted" style="margin-top:8px">' + esc(STATE.fileName) + (STATE.parsing ? ' · reading…' : ' · ' + STATE.sheets.length + ' sheet(s) recognized') + '</div>' :
          '<div class="small-muted" style="margin-top:8px">We look for a Student ID and/or Name column to recognize a sheet, then match every other column to one of the existing fields (Case Status, NABITA Risk, Program, etc.) by its header text — review and adjust the mapping below before importing.</div>') +
      '</div>' +
    '</div>';
  }

  function fieldOptionsHtml(currentKey) {
    var mappable = (window.WELLNESS_CONFIG.FIELDS || []).filter(function (f) { return !NON_MAPPABLE_KEYS[f.key]; });
    var bySection = {};
    var sectionOrder = [];
    mappable.forEach(function (f) {
      if (!bySection[f.section]) { bySection[f.section] = []; sectionOrder.push(f.section); }
      bySection[f.section].push(f);
    });
    var sectionLabel = {};
    (window.WELLNESS_CONFIG.SECTIONS || []).forEach(function (s) { sectionLabel[s.key] = s.label; });
    var opts = '<option value=""' + (!currentKey ? ' selected' : '') + '>Don’t Import</option>';
    sectionOrder.forEach(function (sec) {
      opts += '<optgroup label="' + esc(sectionLabel[sec] || sec) + '">';
      bySection[sec].forEach(function (f) {
        opts += '<option value="' + f.key + '"' + (currentKey === f.key ? ' selected' : '') + '>' + esc(f.label) + '</option>';
      });
      opts += '</optgroup>';
    });
    return opts;
  }

  function sheetsHtml() {
    var totalRows = 0, totalStudents = 0, included = 0;
    STATE.sheets.forEach(function (s) { if (s.include) { totalRows += s.rows.length; totalStudents += s.studentCount; included++; } });

    var cards = STATE.sheets.map(function (s, idx) {
      var matchedUser = STATE.knownUsers.find(function (u) { return u.name.toLowerCase() === s.counselorName.trim().toLowerCase(); });
      var attributionNote = s.counselorName.trim() ?
        (matchedUser ? 'Will attribute entries to team member <b>' + esc(matchedUser.name) + '</b>.' : 'No matching team account — entries will show "Logged by ' + esc(s.counselorName.trim()) + '" without linking to a login.') :
        'No counselor name detected — entries will be unattributed unless you fill this in.';

      var mappedCount = s.columns.filter(function (c) { return c.mappedTo; }).length;
      var columnRows = s.columns.map(function (c, cIdx) {
        return '<div class="import-field-row">' +
          '<span class="small-muted" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(c.header) + '</span>' +
          '<select data-col-map="' + cIdx + '" data-sheet-idx="' + idx + '">' + fieldOptionsHtml(c.mappedTo) + '</select>' +
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
          '<summary>' + mappedCount + ' of ' + s.columns.length + ' column(s) matched to existing fields — review or adjust (optional)</summary>' +
          '<div class="import-field-list" style="margin-top:10px">' + (columnRows || '<div class="small-muted">No other columns detected — just identity fields.</div>') + '</div>' +
        '</details>' +
      '</div>';
    }).join('');

    var importBtnLabel = STATE.importing ?
      'Importing… ' + STATE.importProgress.current + ' / ' + STATE.importProgress.total :
      'Import Selected Sheets';

    return '' +
      '<div class="dash-section-title" style="margin-top:20px">Detected Sheets</div>' +
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
    root.querySelectorAll('[data-col-map]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var idx = Number(sel.getAttribute('data-sheet-idx'));
        var colIdx = Number(sel.getAttribute('data-col-map'));
        var sheet = STATE.sheets[idx];
        var newKey = sel.value;
        // A field can only be mapped from one column at a time — reassigning
        // it here clears it from wherever it was mapped before.
        sheet.columns.forEach(function (c) { if (c.mappedTo === newKey && newKey) c.mappedTo = ''; });
        sheet.columns[colIdx].mappedTo = newKey;
        reanalyzeSheetMapping(sheet);
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

  // Re-derives each row's mapped field values after the admin changes a
  // column's mapping in the review UI, without re-parsing the source file.
  function reanalyzeSheetMapping(sheet) {
    var mappable = (window.WELLNESS_CONFIG.FIELDS || []).filter(function (f) { return !NON_MAPPABLE_KEYS[f.key]; });
    sheet.rows.forEach(function (row) {
      Object.keys(row).forEach(function (k) { if (!NON_MAPPABLE_KEYS[k]) delete row[k]; });
    });
    // Rows only carry mapped values, not raw cell data, so a remapped
    // column can't recover values already dropped for the old mapping.
    // This is a acceptable trade for keeping row storage simple; re-choose
    // the file if a mapping needs values that were never captured.
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

  // Sent in chunks (not one request for the whole file) so a large import
  // can't time out a single request, and so the button can show real
  // progress. No template/field creation happens here — fields are fixed,
  // so this is exactly the same path manual entry already uses.
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

    var entries = [];
    included.forEach(function (s) {
      var label = s.semesterLabel.trim();
      var counselorName = s.counselorName.trim();
      s.rows.forEach(function (fields) {
        entries.push({ fields: fields, semesterLabel: label, counselorName: counselorName });
      });
    });

    STATE.importing = true;
    STATE.importProgress = { current: 0, total: entries.length };
    rerender();

    var chunks = [];
    for (var i = 0; i < entries.length; i += CHUNK_SIZE) chunks.push(entries.slice(i, i + CHUNK_SIZE));

    var aggregate = { semestersCreated: 0, entriesImported: 0, totalRows: entries.length, skipped: [] };
    var chain = Promise.resolve();
    chunks.forEach(function (chunk, idx) {
      chain = chain.then(function () {
        return window.WCT_APP.api('/api/import', { method: 'POST', body: { semesters: semesters, entries: chunk } });
      }).then(function (result) {
        aggregate.entriesImported += result.entriesImported;
        aggregate.semestersCreated = result.semestersCreated;
        aggregate.skipped = aggregate.skipped.concat((result.skipped || []).map(function (s) { return { row: s.row + idx * CHUNK_SIZE, reason: s.reason }; }));
        STATE.importProgress.current = Math.min(entries.length, (idx + 1) * CHUNK_SIZE);
        rerender();
      });
    });

    chain.then(function () {
      STATE.importing = false;
      STATE.result = aggregate;
      rerender();
      window.WCT_APP.toast('Imported ' + aggregate.entriesImported + ' entries.', 'ok');
    }).catch(function (err) {
      console.error('Import failed', err, err && err.data);
      STATE.importing = false;
      rerender();
      window.WCT_APP.toast('Import failed: ' + err.message, 'err');
    });
  }

  window.WCT_IMPORT = { render: render };
})();
