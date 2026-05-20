# SSAM Web — CHANGELOG

Cross-repo log of changes that may affect the iOS client. Every entry
that needs iOS work has an explicit `**iOS impact:**` line — see the
sync contract in `~/Desktop/SSAM-Demo-Output/pdfs/ios-app-requirements.pdf`
§17.

Newest first.

---

## [Web] 2026-05-21 · fix off-by-one in hours → attendance meeting join

- `getMemberHours` and `hours.listOwn` extract the attendance id
  from `hours.notes` (marker pattern `'auto:meeting:<id>'`) and
  join to `attendance` on it. The substring start was 15; the
  prefix is 13 characters long so the first digit sits at
  position 14. With FROM 15:
  - one-digit ids → `''` → NULL → join misses, `meeting_title`
    and `meeting_date` come back null even though the row clearly
    links to a meeting.
  - two-digit ids → first digit dropped → join silently matches
    the **wrong** attendance row (e.g. id 10 parses as 0).
- Fixed both sites to `SUBSTRING ... FROM 14`. Verified against
  the three production rows currently using the marker — all
  now resolve to the correct attendance row.
- **iOS impact:** response shape unchanged. `meeting_title` /
  `meeting_date` start populating on hours rows linked to a
  meeting (previously nil), and existing two-digit-id rows stop
  showing the wrong meeting's data. iOS already decodes both
  fields as optional — no Codable change, no migration.

## [Web] 2026-05-21 · hours.listOwn returns approver chain

- Response now includes `primary_approved_at`, `final_approved_at`,
  `rejected_reason`, plus `preferred_name` + `full_name` pairs for
  the primary and final approver (joined `users → members` from the
  approver-id columns already on `hours`).
- All five new fields are nullable — they're populated only when the
  row reaches the matching approval stage.
- No schema change — columns already exist on `hours`. `hours.list`,
  `getMemberHours`, and the head-facing handlers are untouched.
- **iOS impact:** `HoursRow` Codable gains the five new fields. The
  member-portal hours detail sheet renders an approver-chain
  section ("Primary approved by X on …", "Final approved by Y on
  …", "Rejected — reason"). iOS hides whichever pair is nil. Names
  use the existing `preferred_name ?? full_name ?? "—"` fallback.

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
