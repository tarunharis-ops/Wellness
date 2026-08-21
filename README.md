# Wellness Case Tracker

A multi-user software replacement for the "(Do Not Disturb) Main template" spreadsheet — the
same 26 tracked fields and dropdown lists, plus the same aggregate reporting, as a shared,
persistent, internet-hosted web app instead of a row-per-case spreadsheet.

## How it works

- **Danger Zone** (bottom of the Team page, admin-only) — permanently deletes case entries,
  scoped to everything, one semester, or one counselor. Requires the separate `PURGE_PASSWORD`
  (not anyone's login password — a shared gate for this one destructive action, read from an
  environment variable so it isn't sitting in git history in plaintext; unset means purge is
  refused entirely). Shows a live count of exactly what will be deleted before you confirm.
  Semesters, templates, and team accounts are never touched by this — only case entries. Every
  purge is written to the Audit Log with the scope and the number of rows deleted.
- **Appearance** (nav item, all users) — Light, Dark, or System, saved per-browser
  (`localStorage`, no server round trip). Applied before first paint so there's no flash of the
  wrong theme (`public/index.html`'s inline script sets `<html data-theme>` immediately; the CSS
  in `public/styles.css` defines dark-mode tokens both under `@media (prefers-color-scheme:
  dark)` for "System" and under `[data-theme="dark"]` for an explicit choice, so a manual pick
  always wins over the OS setting).
- **Shared team workspace.** Everyone with an account sees and edits the same case log — same
  as the original spreadsheet — and every entry shows who logged and last edited it.
- **Invite-only accounts.** Nobody can self-register. The first person to run setup becomes the
  first admin; admins invite everyone else from **Team** (a shareable link, optionally locked to
  one email address).
- **Data lives in Postgres**, not a spreadsheet file — it persists across restarts/deploys, and
  everyone always sees the current state when they log back in, any time.
- **Multiple templates, each a full set of dropdown lists.** **Template** always has a "Default"
  (the workbook's original lists, seeded from `lib/config.js` — admin-editable). Anyone can create
  a new named template from there, or inline from the entry form itself; it starts as a clone of
  Default's current options and is freely editable from that point on. When logging an entry, a
  **Template** field asks which one to use — its choice decides what shows up in every dropdown
  on the rest of that form (Program, Concerns, Referral Types, etc.), so different contexts (e.g.
  undergrad vs. graduate) can keep their own option sets without touching the shared Default.
- **Semesters are first-class.** Every entry belongs to a semester (create one from **+ Semester**
  in the top bar); the semester selector there filters the whole app, or switch to "All Semesters"
  to see everything combined. The Dashboard adds its own Counselor filter on top, so a semester's
  numbers can be viewed team-wide or narrowed to one person.
- **Import a previous semester's spreadsheet from Admin → Import.** Upload a workbook shaped like
  the original template (one sheet per counselor/semester, e.g. "Brooke Fall 2025") and it parses
  entirely in your browser — nothing is uploaded until you review and confirm the mapping. It
  correctly handles the spreadsheet's real-world shorthand: counselors only filled in a student's
  name on their first row, leaving follow-up interaction rows blank underneath it. The importer
  detects those blocks and carries the student's identity down through the follow-ups, the same
  way the software's own "+ New Entry" does when linking to an existing student.
- **Export Dashboard** (button on the Dashboard page) downloads the on-screen metrics — student
  status, program breakdown, wellness hours, concerns, referral source/type, referral date by
  month — as a labeled CSV, for any Semester × Counselor combination: all data, one semester (all
  counselors), one counselor (all semesters), or one semester + one counselor. This is separate
  from the top bar's **Export CSV**, which downloads the raw case log rows rather than the
  aggregated metrics.

## Student Records (separate from the Wellness case tracker)

A second top-level section, switched to via the **Wellness / Student Records** toggle above the
sidebar nav. It's a read-only lookup over a synthetic demo roster ("Alderbrook University") joined
across four source systems — SIS, Housing, Campus Safety, Academic Integrity, and the Web/Anonymous
Reporting Portal — seeded once from the CSVs in `data/student_records/` (see that folder's
`README.md` for column definitions and provenance) into their own Postgres tables (`students`,
`housing`, `campus_safety`, `academic_integrity`, `student_reports` in `db/schema.sql`), imported by
`db/migrate.js` the first time it runs against an empty `students` table. This dataset is entirely
separate from the Wellness `entries` table above — no data flows between the two.

Search by name or student ID (`Student Records → Search & Priors`) to open a profile with five tabs:

- **Demographics** — identification and academic standing (major, class, advisor, enrollment date).
- **Contact & Housing** — email/phone/address, current housing assignment, and full housing history.
- **Incidents & Case Reports** — filterable by source: General Reports, Campus Safety, Academic
  Integrity, each shown with its own fields and narrative.
- **Resolution & Status** — Campus Safety and Academic Integrity cases in one table, with status and
  severity badges.
- **Priors & Case History** — per-student counters (report/incident/violation counts) plus a unified
  chronological timeline merging housing tenure with every incident, violation, and report on file.

Every profile view is written to the Audit Log (`student_record.view`), same as Wellness entry views.

## Security controls

These are real, verified technical controls — not a claim of FERPA/HIPAA/SOC 2 *certification*,
which is a legal/organizational status involving policy, agreements with vendors, and usually a
third-party audit, none of which code alone can grant. What's actually implemented:

- **RBAC.** Team and invite management, and editing the shared Default template, are admin-only.
  Deleting a case record is restricted to that record's own creator or an admin — previously any
  signed-in user could delete anyone's entries.
- **Audit log** (**Audit Log**, admin-only). Every sensitive access or mutation — entry
  create/update/delete/view, CSV export, semester/template changes, invite and role changes, login/
  logout — writes one row with actor, action type, target record id, IP, user agent, and a
  timestamp. Logging is fire-and-forget (`server.js`'s `logAudit`): a logging failure never blocks
  or fails the action it's recording.
- **15-minute idle session timeout**, NIST-style. The server is the actual enforcement point —
  every request checks the session's last-activity time and invalidates it server-side past 15
  minutes idle, independent of anything client-side (`server.js`'s `currentUser`). The browser
  mirrors this with its own timer so an idle user gets a warning ~1 minute before logout and a
  clean redirect at the limit, rather than just failing on their next click.

## Local development

1. Copy `.env.example` to `.env` and set `DATABASE_URL` to a Postgres connection string (a free
   one from [neon.tech](https://neon.tech) works well).
2. Install dependencies and set up the database:
   ```bash
   npm install
   npm run migrate
   ```
   `npm run migrate` is idempotent — safe to re-run any time (e.g. after pulling schema changes).
   It also does a one-time import of `data/db.json` if that legacy file is still present.
3. Start the server:
   ```bash
   npm start
   ```
   Open **http://localhost:4787** — you'll land on "Set up your workspace" the first time.

## Deploying so anyone on the internet can reach it

This repo includes `render.yaml`, a [Render](https://render.com) Blueprint, paired with a free
Postgres database from [Neon](https://neon.tech). Both have free tiers; you'll need to create
accounts on each yourself (an assistant can't do that on your behalf).

1. **Create the database:** sign up at neon.tech → New Project → copy the connection string
   (starts with `postgres://`).
2. **Push this project to a GitHub repo** (Render deploys from git).
3. **Create the web service:** sign up at render.com → New → Blueprint → point it at your repo.
   Render reads `render.yaml` and provisions the service automatically.
4. **Set the secrets:** in the Render dashboard for the new service → Environment → add
   `DATABASE_URL` with the Neon connection string from step 1, and `PURGE_PASSWORD` with whatever
   you want the Danger Zone's confirmation password to be (leave it unset to disable Danger Zone
   entirely).
5. Deploy. Render runs `npm install && npm run migrate` as the build step, then `npm start`.
6. Visit the `.onrender.com` URL Render gives you → **Set up your workspace** → you're the first
   admin → invite your team from **Team**.

(Render's free web services sleep after inactivity and take ~30s to wake back up on the next
visit — fine for a small team tool; upgrade the plan if that matters to you.)

## What maps to what

The spreadsheet's workflow — "copy row 2, paste it down, fill it in, move to the next student" —
is now: click **+ New Entry**, optionally search for an existing student to reuse their details,
fill in the new interaction, save. Each interaction is still one record; a student who's
contacted multiple times just has multiple records grouped under their name in **Students**.

| Spreadsheet | App |
|---|---|
| Master Doc rows | **Case Log** (flat, sortable, filterable table, shows who logged each entry) |
| Same row, grouped by name in your head | **Students** (grouped case history / timeline) |
| Z842:AA998 aggregation formulas | **Dashboard** (live, filterable by date range) |
| Column dropdown lists | **Template** — a "Default" seeded from the original lists, plus any number of named templates cloned from it, picked per entry |
| Emailing the file around / one shared drive copy | Everyone logs into the same hosted app |
| Copy/paste a snapshot into "General Data" sheets | Dashboard's date-range filter, live |

`lib/config.js` documents a few places where the original workbook's dropdown lists had drifted
out of sync with its own count formulas (options you could pick that were never counted
anywhere — including safety-critical ones like *Suicidal Ideation/Self Harm* and *Threat to
Others*). Those are fixed here so every selectable value is reflected on the dashboard, including
any custom values an admin adds later (unmapped custom values roll up into an "Other" bucket
rather than disappearing).

## Exporting

**Export CSV** (top bar) downloads every logged entry in the same column order as the original
Master Doc tab, so it can be opened in Excel or handed off for institutional reporting.

## Project layout

```
server.js         http server + router: auth, entries, dashboard, template, team endpoints
lib/config.js     field schema, default dropdown lists, dashboard bucket mappings
lib/auth.js       password hashing (scrypt) + session cookie helpers
lib/aggregate.js  dashboard aggregation logic
lib/id.js         id generation
db/schema.sql     Postgres schema (users, sessions, invites, entries, template_options)
db/pool.js        Postgres connection pool (reads DATABASE_URL)
db/repo.js        all database queries
db/migrate.js     idempotent schema setup + default option seeding + legacy data import
public/           frontend (vanilla HTML/CSS/JS, no build step) — auth.js, app.js, import.js, styles.css
public/vendor/    SheetJS (xlsx.full.min.js), vendored — lazy-loaded only when Import is opened
```
