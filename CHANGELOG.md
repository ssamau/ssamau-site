# SSAM Web — CHANGELOG

Cross-repo log of changes that may affect the iOS client. Every entry
that needs iOS work has an explicit `**iOS impact:**` line — see the
sync contract in `~/Desktop/SSAM-Demo-Output/pdfs/ios-app-requirements.pdf`
§17.

Newest first.

---

## [Web] 2026-05-21 · certs.listOwn — member-scoped certificate list

- New action: returns the caller's own certificates (joined with
  project_name). Auth-gated; requires `user.member_id`. Throws
  `err.auth.no_member_link` (404) for accounts with no linked member
  (e.g. dev accounts), same shape as `hours.listOwn`.
- Mirrors the existing `hours.listOwn` / `interest.listOwn` /
  `assignments.listOwn` / `members.getOwn` self-scoped pattern.
- `certs.list` unchanged — still admin/head only, still scopes via
  `ensureProjectScope` / `ensureMemberScope`.
- **iOS impact:** unblocks the Certificates tab. iOS switches
  `CertificatesViewModel` from `certs.list { member_id }` (which
  hit `ensureMemberScope → requireAdminScope` and returned
  `err.access.forbidden`) to `certs.listOwn` (no body). Response
  shape is the same row set, just narrower scope.

## [Web] 2026-05-21 · interest.submit blocks "any role" on full multi-role opps

- `interest.submit` previously skipped the capacity check whenever
  `role_id` was null (the "any role" express path). On an opportunity
  where every role was already at headcount, the row got inserted
  silently — no slot to assign into, no waitlist downstream.
- Fixed by:
  - Drop the `role_id !== null` skip in the express-interest guard.
  - `getRoleCapacity(opportunity_id, null)` on a multi-role opp
    (one with rows in `opportunity_roles`) now sums `headcount_needed`
    across every role and counts every assignment, instead of only
    counting `role_id IS NULL` assignments against the legacy
    `opportunities.headcount_needed`.
  - Legacy single-role opps (no `opportunity_roles` rows) keep the
    original null-branch semantics.
- Same fix closes the gap in `assignments.add` — a head adding a
  member to a full multi-role opp without picking a role now also
  hits `err.business.role_full` server-side instead of slipping
  through.
- **iOS impact:** behavioural — `interest.submit` and `assignments.add`
  now return 409 + `{ success: false, error: 'err.business.role_full' }`
  in a new case (member sent `role_id: null` to a full opportunity).
  Treat it identically to the existing "specific role full" path:
  surface the localized `err.business.role_full` toast and leave the
  member's selection unchanged. No new error code, no schema change.

## [Web] 2026-05-21 · pre-auth 401 envelope reaches the page (signup/login/reset-password)

- `lib/api.js#callApi` used to return `null` on EVERY 401, including
  the allowlisted pre-auth pages. The allowlist stopped the redirect
  but the error envelope was still discarded, so the page fell back
  to a generic "failed" string instead of the localized `err.*` code.
  Discovered when an iOS-side NID typo surfaced as "Activation failed"
  instead of `err.auth.invalid_credentials`.
- Pre-auth pages (`index`, `apply`, `login`, `signup`,
  `reset-password`) now fall through to the JSON parser on 401 so
  `{ success: false, error: 'err.*' }` reaches the caller.
  Authenticated pages still clear the session and redirect to
  `login.html` — identical behaviour to before.
- `signup.js` routes the code through `localizeError()` so the user
  sees the translated string ("Invalid credentials.") rather than
  the raw `err.auth.invalid_credentials`.
- **iOS impact:** none on client code (iOS doesn't share `lib/api.js`).
  Documents one wire-protocol fact worth mirroring in `AuthService`
  and any pre-auth call: on 401, **always parse the body** for
  `{ success, error, errorParams }` and surface `error` through the
  i18n catalog. Don't treat 401 as "session expired" on signup/reset
  flows — same rule the web client follows now.

## [Web] 2026-05-21 · signup/reset-password added to 401 allowlist + signup null guard

- `lib/api.js#callApi` no longer redirects to login when a 401 lands on
  signup.html or reset-password.html. These are pre-auth pages where a
  401 means "bad credentials this attempt", not "session expired".
- `signup.js` now null-guards the `callApi` result (defense-in-depth).
- Surfaced via iOS testing: wrong-PIN attempts crashed with
  "Cannot read properties of null (reading 'success')" before the
  real `err.auth.invalid_credentials` could render.
- **iOS impact:** none on client code, but documents server response
  shape — `auth.signup.completeByPin` returns 401 + envelope
  `{ success: false, error: 'err.auth.invalid_credentials' }` on bad
  PIN. iOS should display the localized error, not treat 401 as
  "session expired" for this action.

## [Web] 2026-05-21 · auth.exchangeSupabaseToken returns token in body

- Symmetric with legacy `auth` handler — supports Bearer-header iOS client.
- Web unchanged (still reads cookie via Set-Cookie).
- **iOS impact:** unblocks Supabase-path login; AuthService relies on this field.
