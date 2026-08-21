// Minimal RFC-4180 CSV parser (no npm dependency — quoted fields, embedded
// commas/newlines, and "" escaped quotes). Used only at migrate-time to load
// the Student Records seed CSVs, so it favors correctness over speed.

'use strict';

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField() { row.push(field); field = ''; }
  function endRow() { endField(); rows.push(row); row = []; }

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) endRow();

  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(function (r) { return r.length > 1 || r[0] !== ''; }).map(function (r) {
    const obj = {};
    header.forEach(function (h, idx) { obj[h] = r[idx] === undefined ? '' : r[idx]; });
    return obj;
  });
}

module.exports = { parseCSV };
