// Idempotent migration/bootstrap script. Safe to run on every deploy boot:
// creates tables if missing, seeds default dropdown options if a group is
// empty, and (once, if the legacy data/db.json file exists) imports old
// local entries into Postgres.
//
// Usage: node db/migrate.js

'use strict';

const fs = require('fs');
const path = require('path');
require('../lib/env');
const db = require('./pool');
const cfg = require('../lib/config');
const { uuid } = require('../lib/id');

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('Schema OK.');

  for (const group of cfg.OPTION_GROUPS) {
    const existing = await db.query('SELECT COUNT(*)::int AS n FROM template_options WHERE group_key = $1', [group.key]);
    if (existing.rows[0].n > 0) continue;
    for (let i = 0; i < group.defaults.length; i++) {
      await db.query(
        'INSERT INTO template_options (id, group_key, value, sort_order) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [uuid(), group.key, group.defaults[i], i]
      );
    }
    console.log('Seeded ' + group.defaults.length + ' default options for "' + group.key + '".');
  }

  const legacyPath = path.join(__dirname, '..', 'data', 'db.json');
  if (fs.existsSync(legacyPath)) {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    const entries = legacy.entries || [];
    if (entries.length) {
      const already = await db.query('SELECT COUNT(*)::int AS n FROM entries');
      if (already.rows[0].n === 0) {
        const repo = require('./repo');
        const users = await repo.listUsers();
        const attributeTo = (users.find(function (u) { return u.role === 'admin'; }) || users[0] || {}).id || null;
        for (const e of entries) {
          const fields = {};
          cfg.FIELDS.forEach(function (f) { fields[f.key] = e[f.key] || ''; });
          await repo.createEntry(fields, attributeTo);
        }
        console.log('Imported ' + entries.length + ' legacy entries from data/db.json.');
      } else {
        console.log('Entries table already has data — skipped legacy import.');
      }
    }
  }

  console.log('Migration complete.');
  process.exit(0);
}

run().catch(function (err) {
  console.error('Migration failed:', err);
  process.exit(1);
});
