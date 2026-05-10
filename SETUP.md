# SSAMAU — Netlify migration setup

This is the one-time setup to switch the backend from Google Apps Script + Sheet to **Netlify DB (Neon Postgres) + Netlify Functions**. After this is done, the only step to deploy is `git push`.

You'll do this from the `ssamau-site/` directory.

---

## 1. Install prerequisites (once per machine)

```bash
# Node 20+ — check with `node --version`
# Netlify CLI:
npm install -g netlify-cli
```

## 2. Install project dependencies

```bash
cd ssamau-site
npm install
```

## 3. Link to your Netlify site

If the site is already on Netlify, link the local folder to it:
```bash
netlify link
```
…and pick the existing site from the list.

If it's a brand-new project:
```bash
netlify init
```
…follow the prompts to create a new site.

## 4. Provision the database

```bash
netlify db init
```

This creates a free Neon Postgres database under your Netlify account and **automatically sets `NETLIFY_DATABASE_URL`** as an environment variable on the site.

## 5. Set the JWT secret

```bash
netlify env:set JWT_SECRET "$(openssl rand -base64 48)"
```

(Pick anything random and long — this signs login tokens. Don't commit it.)

## 6. Start the dev server (applies the schema)

```bash
netlify dev
```

Leave this terminal running. On startup, Netlify:
- Boots a local Postgres branch.
- Auto-applies every `.sql` file in `netlify/database/migrations/` (we have one: `0001_initial_schema.sql`, which creates all 11 tables).
- Serves the frontend + Functions at http://localhost:8888.

## 7. Seed the data (in a NEW terminal — leave the dev server running)

```bash
cd "/Users/faisal/Desktop/SSAMAU Website/ssamau-site"
netlify dev:exec npm run seed
```

This:
- Creates 8 committees (`COM_001`..`COM_008`).
- Imports all 58 rows from `SSAMwebmanagment - Members.csv`.
- Generates login accounts for the 13 leadership rows (3 presidency = `superadmin`, 10 heads/vice-heads = `head`).
- **Prints temporary passwords to the terminal** — copy them now and distribute through a secure channel. They are bcrypt-hashed in the DB and won't be retrievable later.

## 8. Test locally

The dev server from step 6 is already running at http://localhost:8888. Test:
1. `/login.html` — log in as one of the seeded users.
2. `/admin.html` — every tab should load.
3. **The bug**: Attendance → record one → click delete → it should now disappear (was `Action not found: updateAttendance` before). Same for Hours.
4. `/index.html` — public site should render board/committees/advisors/recent projects pulled live from the DB.

## 9. Deploy

```bash
git add .
git commit -m "Migrate backend to Netlify DB + Functions"
git push
```

Netlify auto-deploys on push. When the deploy is green, the production site is on the new backend.

---

## What changed in the codebase

**New (all under `ssamau-site/`):**
- `netlify.toml` — Netlify build/dev config
- `package.json` — npm deps (`@neondatabase/serverless`, `@netlify/database`, `bcryptjs`, `jsonwebtoken`)
- `netlify/functions/api.js` — single endpoint, 40 actions, mirrors the Apps Script router
- `netlify/functions/_db.js` — Neon client + helpers
- `netlify/functions/_auth.js` — JWT + role guards
- `netlify/database/migrations/0001_initial_schema.sql` — DDL for 11 tables (auto-applied by Netlify)
- `db/seed.js` — CSV → DB importer + leadership user creation

**Modified:**
- `login.html` — API URL, captures returned JWT into `sessionStorage.ssam_token`
- `admin.html` — API URL, helpers now POST with `Authorization: Bearer …`, response envelope flattened so existing call sites still work
- `index.html` — API URL, `apiGet()` now POSTs JSON instead of GET-with-querystring

**Unchanged:**
- All HTML/CSS/UI rendering code.
- The 40 action names — `getMembers`, `attendance.bulkRecord`, `certs.verify`, etc. They mean the same thing on the new backend.
- Old Google Apps Script web app — still live, can be shut down or kept as a read-only export source for the original Sheet.

## Bugs fixed

- ✅ `updateAttendance` now exists → attendance delete works.
- ✅ `updateHours` now exists → hours delete works.

Both were called by the frontend but missing from the old Apps Script router.

## What is NOT in this migration

The full §4 data model in the requirements PDF is **not** rebuilt yet — this is a like-for-like swap of the existing Sheet-backed features. The follow-up work (separate plans needed) covers:

- Membership applications (form → review → accept/reject/interview)
- Opportunities as first-class entities (role, hours, headcount per role)
- Two-stage hour approval (committee head → presidency)
- Help-Requests board with 48-hour auto-escalation
- Three-tier certificates (SACM annual, event/project, annual volunteer) with QR/signatures
- Asalah Academy recurring sessions
- Member & volunteer self-service portals

Doing those on Postgres is much easier than on Sheets — that's the point of this migration.
