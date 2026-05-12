# SSAMAU — Volunteer Hours Management System

Internal admin + public site for **نادي الطلبة السعوديين في ملبورن** (Saudi Students Association in Melbourne, SSAM). Documents members' volunteer contributions to club events, computes hours for SACM (Saudi Cultural Mission) certificates, and surfaces the work for sponsors and the executive board.

The full requirements are in [SSAM_Requirements_v1.1.pdf](../SSAM_Requirements_v1.1.pdf) (Arabic). The system is governed by two principles from §2 of that doc:

> **Principle 1: "هذي حقوق ناس"** — every hour a member volunteers must be tracked accurately and approved fairly, regardless of whether the role is small or large.
>
> **Principle 2: "لا تُسجَّل فرصة لشخص لم يحضرها"** — no hours are recorded against an opportunity unless the person actually attended it.

## Stack

- **Frontend:** static HTML (`index.html`, `login.html`, `admin.html`) — RTL Arabic, vanilla JS
- **Backend:** Netlify Functions (Node ESM) → single POST endpoint at `/.netlify/functions/api` with action-based routing
- **Database:** Netlify DB (Neon Postgres), accessed via `@netlify/database`'s `getDatabase()`. Schema in [`netlify/database/migrations/`](netlify/database/migrations/) — auto-applied on production deploy.
- **Auth:** bcrypt-hashed passwords + JWT, stored in `sessionStorage`. Roles: `superadmin` (presidency, 3 people), `head` (committee head/vice-head, ~10 people), `member` and `volunteer` (planned).
- **Hosting:** Netlify

## First-time setup

See [SETUP.md](SETUP.md). Short version:

```bash
npm install -g netlify-cli && cd ssamau-site && npm install
netlify link                                       # link to the existing Netlify site
netlify db init                                    # provisions a Neon DB on first run
netlify env:set JWT_SECRET "$(openssl rand -base64 48)"
netlify dev                                        # starts at localhost:8888 (terminal 1)
netlify db migrations apply                        # apply schema to local DB
npm run seed                                       # seed CSV + create leadership accounts (terminal 2)
```

The seed prints temp passwords to the terminal — capture them immediately.

## Project layout

```
ssamau-site/
├── index.html, login.html, admin.html        # the static site
├── netlify.toml                              # Netlify build/dev config
├── netlify/
│   ├── functions/
│   │   ├── api.js                            # main router — every action handler
│   │   ├── _db.js                            # lazy-init SQL client (handles undefined→NULL)
│   │   └── _auth.js                          # JWT + role guards + public-action allowlist
│   └── database/migrations/
│       ├── 0001_initial_schema.sql           # 11 tables: members, committees, projects, …
│       └── 0002_hours_breakdown.sql          # hours.before/during/after + total_hours
├── db/
│   └── seed.js                               # posts the Members CSV to setup.bulkSeed
└── SETUP.md                                  # end-to-end setup instructions
```

## Where the requirements work happens

The PDF's §13 lays out five phases. Roughly:

| Phase | What | Status |
|---|---|---|
| 0 | Audit current state | done |
| 1 | Members + projects + opportunities + 2-stage hour approval | partial — see active branches |
| 2 | Help-Requests board + 48h auto-escalation + email notifications | not started |
| 3 | Member/volunteer self-service portals + 3-tier certificates + reports | not started |
| 4 | Pride card, reminder emails, Asalah Academy support | not started |
| 5 | SACM integration, sponsor reports, multi-PM dashboards | not started |

## Branching conventions

- `main` — what's live in production. Don't push directly; merge from a feature branch.
- `feature/<short-name>` — one logical chunk of work per branch. Pushed to GitHub for preview deploys via `netlify deploy --build --alias <branch-slug>`.
- Each feature branch ships with a **descriptive commit message** explaining *why* (not just *what*) — that message + the PR description are the source of truth for "what is this branch for". Read `git log --oneline main..feature/<name>` to see what a branch adds over `main`.

Recent feature branches:

- **`feature/netlify-migration`** — moved the backend off Google Apps Script + Sheets onto Netlify Functions + Netlify DB. Fixed two missing actions (`updateAttendance`, `updateHours`) that were breaking soft-delete in admin.html. Adds the schema, seed flow, JWT auth, and the cross-project polish for Participants/Attendance/Hours tabs. Merged into `main`.
- **`feature/opportunities-and-approval`** — adds `opportunities` + `assignments` entities (replacing flat participants for new flows) and the two-stage hour approval workflow from §7 of the requirements. Hours go `Draft → PrimaryApproved (committee head) → FinalApproved (presidency)`. Members' `total_hours` rollup counts only `FinalApproved`. The 14 standard roles from §12 are exposed as a dropdown in the new Opportunities tab.
- **`feature/membership-applications`** — replaces the external Google Form with an in-app pipeline (§6). New public `apply.html` form that anyone can submit; presidency triages each `PendingTriage` row to a committee; that committee's head accepts (auto-creates a `members` row tied to the committee, status `Active`, today's join_date) / rejects with reason / requests an interview. No `users` (login) row is created on accept — login provisioning is intentionally deferred to the upcoming member-portal restructure. The "انضم إلى النادي" CTA on `index.html` is repointed from `forms.gle/...` to `/apply.html`.
- **`feature/apply-form-v2`** — production-ready expansion of the apply form per the leadership spec. Migration 0005 adds 20+ columns to `membership_applications` (Arabic + English 4-part names, DOB, Melbourne address, phone country code, 7-option scholarship dropdown with Other, study level + university canonical lists, study-start + expected-graduation windows, CV URL, skills/hobbies, about-self, referral source, suggestions, confirmation acknowledgment) and introduces `members.national_id` as the natural key for the upcoming signup-by-reference flow. The admin review modal now displays every captured field grouped by section, and the Members tab gets a National ID column + an editable field on the member modal so leadership can backfill their own NIDs before the bulk import branch lands.
- **`feature/bulk-import-members`** — imports the leadership-supplied `بيانات اللجان.xlsx` (the real-world members roster) into the DB so the dummy seed can be retired pre-beta. Adds a 3-script workflow under `db/`: `inspect-import.js` normalises the xlsx (committee names, role labels, scholarship/university/referral free-text, dual phone normalization to E.164 incl. Aussie-mobile-without-leading-zero recovery, per-row overrides for malformed cells like Excel scientific-notation phones) and writes a gitignored `import-preview.json`; `preview-import.js` prints a terminal-friendly summary so reviewers don't have to open the JSON; `import-members.js` authenticates as the president, posts the preview to a new `setup.bulkImportMembers` action that matches existing leadership by name (preserves their `member_id` so login accounts keep working), inserts everyone else, wires committee head/vice-head FKs, creates 5 new committees (`COM_009`..`COM_013`), and sweeps the orphan seed dummies. Migration 0006 denormalises 15 application-time fields onto `members` (`whatsapp`, `name_en`, `date_of_birth`, `address_melbourne`, full study profile, skills/about/cv/linkedin) so the import doesn't lose data, and migration 0007 adds the same `whatsapp` capture to the apply form. The Members tab gets a stacked "التواصل" cell (email + 📱 phone + 💬 whatsapp) so admins see every contact channel at a glance. Side-effects in the same branch: re-enables `updateEvents()` so admin-created projects appear on the public page; ships `import-static-events.js` for the 8 originally-hardcoded upcoming events; fixes a latent HTML-attribute bug where Arabic names with quotes silently broke every delete button on the admin (`attrJson()` helper).
- **`feature/admin-accounts`** — admin/dev manages user accounts in-app. New "🔑 حسابات المستخدمين" tab that's superadmin-only for full CRUD (create/edit/delete/reset-password), and committee-head-scoped (their committee only, reset-password only) so heads can help their members get back in without paging the dev. New `users.list / create / update / delete / resetPassword` actions; heads' `users.list` returns the full roster of their committee (including members who don't have an account yet, faded with a "— لم يُنشأ حساب بعد —" hint and an admin-only ➕ quick-create button). Includes a `db/create-admin.js` one-shot CLI to bootstrap a superadmin account (e.g. `faisal-admin`) without going through the UI — useful for the dev/maintainer who's not a club member, or as a lockout-recovery path. Linking semantics: admins always pick an existing member from a dropdown that filters out members who already have accounts; new members must come through apply.html, not this flow. NID is auto-suggested as the username when a member with NID is selected (per the convention agreed for the upcoming member portal). Side-effects: removes the Apps-Script-era "ارفع الأعضاء إلى Google Sheets" banner from admin.html that was triggering "Forbidden — superadmin only" toasts on non-superadmin sessions; adds `external_node_modules` + `included_files = ["node_modules/**"]` to netlify.toml so esbuild stops dropping transitive CJS deps for `pg`/`jsonwebtoken`/`bcryptjs`; bumps bcryptjs to 3.x (Node 26's strict ESM resolver doesn't accept 2.4.3's `"main": "index.js"` without proper `exports`).
- **`feature/unified-xlsx-seed`** — collapses the two-step seed+import flow into a single xlsx-driven `npm run seed`. Replaces the dummy-CSV `setup.bulkSeed` with a new action that reads a pre-normalised xlsx payload (committees discovered from the data instead of a hardcoded list, full member profile inserted, committee head/vice-head FKs wired, leadership user accounts created with NID-or-email-local-part usernames and generated temp passwords) — all in one logical pass. Adds an optional `dev_admin` payload so a dev/maintainer superadmin (e.g. `faisal-admin`) can be created in the same transaction via `DEV_ADMIN_USERNAME=faisal-admin npm run seed` — critical for prod deploys to never end up locked-out. Lockout safety: refuses to commit if zero superadmins would exist after the seed (e.g. xlsx with no presidency rows AND no dev_admin). Extracts the xlsx normalisation into a shared `db/_normalise-xlsx.js` so the inspector + seed always stay in lockstep. `SEED_FORCE=1` wipes all app-level data and re-seeds cleanly (FK-safe DELETE order, no TRUNCATE lock contention with the running function). Removes the now-redundant `setup.bulkImportMembers` action + `db/import-members.js` client — single seed pipeline going forward.

## Critical files for any change

- [admin.html](admin.html) — every admin tab; the central `api()` helper at the top of `<script>` is where requests get the `Authorization: Bearer …` header. Look for the `loaders` map to find which function loads a tab.
- [netlify/functions/api.js](netlify/functions/api.js) — the action router. Adding a new action means adding a key to the `handlers` object plus (if not public) accounting for it in `_auth.js`'s `PUBLIC_ACTIONS` / `SUPERADMIN_ACTIONS` sets.
- [netlify/database/migrations/](netlify/database/migrations/) — never edit an applied migration. Add a new numbered file.

## Two principles to keep in mind when adding code

1. **Server enforces the permissions matrix** (§5) — don't trust the UI to hide buttons. Every write action checks the caller's `access` and (for committee heads) their `committee_id`.
2. **Hours are stable history** — once a row is `FinalApproved`, only the presidency can `Reject` it (which moves it to `Rejected`, never deletes it). The audit trail (`primary_approver_id`, `primary_approved_at`, `final_approver_id`, `final_approved_at`, `rejected_reason`) is non-negotiable.

## Useful commands

```bash
netlify dev                                  # local server with hot-reload
netlify deploy --build --alias <slug>        # deploy a feature branch to a preview URL
netlify deploy --build --prod                # deploy the current code to production
netlify db connect                           # open a psql session against the prod DB
netlify db migrations apply                  # apply pending migrations to the local DB
SEED_ENDPOINT='https://<url>/.netlify/functions/api' npm run seed    # seed any environment
```
