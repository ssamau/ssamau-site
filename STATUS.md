# SSAM site — current status

> One-line: head + admin + member portals are feature-complete with
> seasonal-membership intake, in-product support ticketing, full
> permission revalidation, and 7 branded email templates. The last
> sweep audited every admin function + email; everything renders.

Updated: 2026-05-18 (Faisal + Claude). Branch is clean + pushed to
origin/main at commit c19c7ce. Update this when you ship something
material — the goal is that the next coding session can pick up the
project's mental model without re-reading 30+ commits of context.

---

## What landed since 2026-05-16

Major feature work (newest first):

- **Audit recovery** (c19c7ce) — Participants tab now persists
  `participation_status` / `availability_type` / `manager_notes` /
  `outstanding_flag`; Attendance tab now persists
  `checked_by_member_id`. Migration `20260518100001_…` adds the
  columns; existing rows backfill to NULL. Frontend was always
  sending the fields — server was silently dropping them.

- **Admin access fixes** (6704ebe) — 7 endpoints in auth.ts and
  applications.ts had `if (user.access === 'head') {…} else if
  (user.access !== 'superadmin')` blocks that silently forbade
  `admin` (presidency) tier even though the comments said
  presidency could. Fixed: users.list, users.sendPasswordReset,
  auth.invite.byEmail / byPin / revoke, applications.reject, plus
  one already-correct path tightened defensively.

- **Permission watcher** (088d8e6, b7870c2) — `lib/permission-watcher.js`
  re-hits `auth.whoami` on page load, every 5min, and on
  visibilitychange. Inactive members get bounced to
  `login.html?inactive=1`; access-level flips reload the portal so
  RBAC re-runs. The initial version had a `undefined !== null`
  comparison that triggered a spurious reload right after every
  cold load and broke every button on the admin portal — fixed in
  b7870c2 (null-coercing comparison + skip reload on committee-only
  change).

- **In-product support ticketing** (fb23c30, 38b6981) — every
  authenticated user (member / head / admin) gets a 💬 sidebar
  entry that opens a Bug / Feature / Question modal. Optional
  screenshot attachment (4 MB max, private bucket). Submit fires
  to `support.submit` which inserts a row and emails the dev's
  inbox (xtlg511@icloud.com). Superadmin sees an admin support
  inbox tab with status workflow (Open → InProgress → Resolved →
  Closed) and 1-hour signed-URL attachment viewer.

- **Inactive-login gate** (bc82153) — `members.status='Inactive'` now
  blocks login at both the legacy `auth` and `auth.whoami` paths.
  Frontend tears down any partial Supabase session via signOut() +
  clearSession() before re-throwing so a reload doesn't
  short-circuit past the gate.

- **Apply form seasonal toggle** (e83ee6d) — public form gates on
  current month. Jan 1 – May 31: members + volunteers both allowed.
  Jun 1 – Dec 31: server forces `applicant_type='Volunteer'`
  regardless of body; client mirrors the gate by flipping copy.
  New `applications.inviteAsMember` admin action converts a
  volunteer application to a member with a chosen committee +
  fires the auto-invite chain.

- **Opportunity flow upgrades** (e83ee6d, 088d8e6, 5ed571e) — auto
  confirmation email to creator + heads-up to admins on
  `opportunities.create`; new head "Other opportunities" tab where
  heads register interest in events outside their committee;
  `assignments.markAttendance` accepts an `hours_override` that
  upserts a FinalApproved hours row keyed to the assignment
  (overrides the opportunity's estimated_hours); date format leak
  fixed via new `fmtIsoDate` helper; clearable owning_committee_id
  in `opportunities.update` so admins can move an opportunity to
  "all committees".

- **Head portal rich tabs** (4103c53, 97e15db) — Members tab mirrors
  admin's row layout (contact stack + file icons + profile / invite
  buttons) scoped to head's own committee, national-id hidden for
  privacy. Emails + Certificates tabs added with committee-scoped
  list + send + issue flows.

- **Service-worker hardening** (0ae1752) — `updateViaCache: 'none'`
  + `visibilitychange` polling so SW updates propagate to clients
  within a single page load instead of waiting up to 24 hours.
  Resolves the "stale-cache buttons don't work" class of bugs that
  hit prod after every deploy.

- **i18n rollout phases 1–7** — every user-facing string flips
  between Arabic + English via key-based catalog. Live toggle pills
  on every portal + auth + homepage. Server-side error codes
  (`err.<namespace>.<name>`) localized via `localizeError()`.
  Catalogs: `assets/js/lib/strings/{ar,en}.js` (≈1500 keys in
  parity, checked manually).

- **RTL/LTR layout fix + table-header alignment** (a59b347) — admin
  CSS switched from physical (`right:0`) to logical
  (`inset-inline-start:0`) properties so sidebar / table headers
  flip with the language correctly.

---

## Architecture map

```
assets/js/
  lib/                       # shared helpers
    strings/{ar,en}.js          # i18n catalogs (~1500 keys in parity)
    i18n.js                     # t() + applyI18n() + setLang() + onLangChange
    api.js                      # callApi() + localizeError() + apiOrThrow()
    ui.js                       # toast/modal/confirmDelete/refresh/api wrappers
    permission-watcher.js       # whoami polling + access-change reload + inactive bounce
    support.js                  # support-modal open + submit (shared across portals)
    rbac.js                     # client-side access filters
    sw-register.js              # SW registration with updateViaCache + visibilitychange polling
  admin/                     # /admin.html — full presidency portal
    main.js, router.js, dispatch.js
    tabs/                       # 17 tabs (dashboard, members, applications, accounts,
                                #          advisors, committees, projects, participants,
                                #          opportunities, attendance, hours, profile,
                                #          interest, emails, certificates, support, my-profile)
  head/                      # /head.html — committee-head portal
    main.js, router.js
    tabs/                       # 9 tabs (dashboard, members, opportunities,
                                #         other-opportunities, hours, attendance,
                                #         applications, emails, certificates, my-profile)
  member/                    # /member.html — member portal
    main.js, router.js, dispatch.js
    tabs/                       # 4 tabs (profile, hours, opportunities, assignments)

supabase/functions/api/      # single Edge Function, action-dispatcher
  index.ts, _helpers.ts, _sql.ts, _email.ts
  actions/                      # one file per logical area — auth, members,
                                #   advisors, committees, projects, participants,
                                #   attendance, hours, interest, thanks, certs,
                                #   dashboard, opportunities, assignments,
                                #   applications, head, setup, storage,
                                #   storage_project, support
```

Key design decisions worth remembering:

- **Status / role / attendance enums** store CANONICAL ENGLISH in
  the DB, display localized via `_KEY` map → `t(map[enumValue])`.
  Never localize the stored value — the cache (`STATUS_COLORS`
  etc.) keys off the English string and a translation would break it.
- **localizeError()** is forward-compatible: any new server-side
  error code without a catalog entry shows as the raw `err.xyz`
  code rather than blank, so missing-entry regressions are visible
  during dev.
- **Toggle pills** (`.lang-toggle`, `.sb-theme-row`) flip with
  document direction so the active pill stays where the user clicked.
- **Sanity-check unclosed `<div>` in admin.html** when buttons
  silently stop working — the 2026-05-17 "no buttons work"
  incident was a single missing `</div>` after `#ov-application`
  wrapping every subsequent modal + the toast inside an invisible
  parent.
- **`_sql.ts` coerces `undefined` AND `''` → NULL** before binding.
  This means `COALESCE(${field}, column)` silently drops attempts
  to clear a column to null. Use plain `${field ?? null}` for
  fields that should be clearable; keep COALESCE only for required
  / never-null columns.
- **Permission watcher reloads on `access` change only**, not on
  committee-id change — sidebar/RBAC keys off access so a
  committee-only flip is a silent persist, not a reload.

---

## Email templates (audited 2026-05-18)

All 7 custom-built templates rendered + visually inspected. Branded
green/gold letterhead consistent across the suite; RTL-hardened for
phone mail clients that ignore `<html dir="rtl">`. Inline styles
only (CSP-friendly for the cert preview popup too).

| File / function | What it sends |
|---|---|
| `thanks.ts → thanksEnvelope` | Admin-composed thank-you email — branded shell with admin's free-text body. |
| `certs.ts → certDeliveryEmail` | Cert delivery to recipient with verify CTA + monospace code box. |
| `opportunities.ts → renderOppNotificationHtml` | Recruitment notification (admin manual notify flow). |
| `opportunities.ts → renderOppConfirmationHtml` | Two audiences via `audience: 'self' \| 'admin'` — creator gets ✅ "تم إنشاء الفرصة", admins get 📣 "فرصة جديدة" with 👤 المنشئ row. |
| `auth.ts → composeInviteEmail` | Member portal sign-up invite (token mode only; PIN flow doesn't send email). |
| `support.ts → notifyDevOfTicket` | LTR English bug-report to dev inbox with reporter context + repro steps. |
| `applications.ts → notifyNewApplication` | New-application notification to admin inbox (bulletproof table layout). |

**Open items from the audit:**

- Password-reset emails are NOT branded — Supabase sends them via
  `admin.auth.resetPasswordForEmail()`, using its default template.
  Fix in Supabase dashboard → Authentication → Email Templates.
- `composeInviteEmail` has a dead `mode` parameter (no PIN-mode
  branch in the body). Cleanup.
- `applications.ts → section()` helper doesn't HTML-escape value
  cells (because the CV row passes raw `<a>` HTML). Low-severity
  injection vector since the recipient is the admin inbox, but
  worth tightening if hardening pass time comes.

---

## Deployment

- **Static site** (HTML/CSS/JS): auto-deploys on `git push origin
  main` via Netlify. ~30s after push, prod is live.
- **Edge Function** (`supabase/functions/api/`): deploys separately
  with `npx supabase functions deploy api`. Not auto-triggered by git.
- **Database migrations**: deployed with `npx supabase db push`.
  Not auto-triggered by git either. Migrations live in
  `supabase/migrations/<timestamp>_<name>.sql` and use a strict
  timestamp prefix; supabase CLI applies them in order.
- **Service worker cache**: bumped manually in `sw.js` per commit
  with a `CACHE_VERSION` constant. Bumping is mandatory whenever
  any shipped JS / CSS / HTML changes, otherwise SW serves stale.
- **Storage buckets**: `support-attachments` is PRIVATE; created
  one-time via Supabase dashboard (the migration role can't ALTER
  storage.buckets). `project-photos` is PUBLIC.

---

## Known open items (housekeeping, no blockers)

- [ ] Brand the Supabase password-reset email template via dashboard.
- [ ] Pre-commit hook for i18n key parity (`node -e` script in commit
      notes is the manual check today; held up fine through 1500 keys).
- [ ] `apply.css` and `index.css` still have a few physical
      `text-align: right` / `border-right` rules — only affects
      English mode on those public pages.
- [ ] Tighten `section()` helper in applications.ts to HTML-escape
      value cells.
- [ ] Remove dead `mode` parameter from `composeInviteEmail` in
      auth.ts.
