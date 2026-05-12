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
