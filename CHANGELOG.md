# SSAM Web — CHANGELOG

Cross-repo log of changes that may affect the iOS client. Every entry
that needs iOS work has an explicit `**iOS impact:**` line — see the
sync contract in `~/Desktop/SSAM-Demo-Output/pdfs/ios-app-requirements.pdf`
§17.

Newest first.

---

## [Web] 2026-07-27 · issue certificates to volunteers by name + email (no member/registry)

Meeting request: issue a certificate to a volunteer who is not a club
member and has no account, using just their name + email.

- **Client-only change.** No server or schema change: `certificates.member_id`
  is already nullable, `recipient_name`/`recipient_email` are already
  request fields on `certs.issue`, and every issuance gate
  (`project Completed`, `role required`, hours-governance) is already
  member-id-agnostic. The admin/head cert-issue forms simply gained a
  "recipient type" toggle (registered member vs volunteer). Volunteer
  mode sends `{ project_id, recipient_name, recipient_email, role }` with
  **no** `member_id`.
- Hours are intentionally omitted for volunteer certs — a member-less
  cert has no governed hours source, and cert hours are governed-only
  (ticket SUP_3RT6RJRC). Server derives 0. Project must still be
  `Completed` and a role is still required (unchanged gates).
- Files: `admin.html`, `head.html` (form + radios), `admin/tabs/certificates.js`,
  `head/tabs/certificates.js` (`onCertRcptTypeChange` / `onHeadCertRcptTypeChange`
  + volunteer branch in `issueCert`/`issueHeadCert`), dispatch wiring in
  `admin/main.js` + `head/main.js`, new `ap.cert.*` strings (AR+EN), `sw.js`
  cache bump to `v79`.
- **iOS impact:** none. iOS never issues certificates (admin/head-only).
  A volunteer cert has no `member_id`, so it never appears in any member's
  `certs.listOwn`; `certs.verify` already renders member-less certs. No new
  error codes. New strings are staff-portal-only — regenerate
  `Localizable.strings` only if you want them, nothing depends on them on iOS.

---

## [Web] 2026-05-28 · cert issuance: complete-project gate + governed hours (ticket SUP_3RT6RJRC)

Three fixes around volunteer-hours integrity on certificates, all in
`supabase/functions/api/actions/certs.ts`.

- **2A — gate on project completion.** `certsIssue` and `certsBulkIssue`
  used to accept any project in scope, regardless of `project_status`.
  Reporter: "incomplete events are getting certificates issued on
  them — that's wrong." Now both paths throw
  `err.business.project_not_complete` (409) when the project's
  `project_status` is anything other than `Completed`. The error
  envelope carries the actual status in `errorParams.status` so the
  client can surface it to the admin (e.g. "this project is still
  Planned / Active / Planning"). `certsList` and `certsVerify` are
  unchanged — only issuance writes are gated.

- **2B — cert hours are governed, not free-typed.** Source of truth
  for cert hours is now the member's `FinalApproved` hours rows for
  this specific project, matching the predicate
  `recomputeMemberTotalHours` uses to maintain `members.total_hours`:
  `approval_status = 'FinalApproved' AND notes IS DISTINCT FROM
  'Deleted'`. Both handlers ignore any client-supplied `hours` and
  derive the value server-side via a new private helper
  `deriveMemberHours(member_id, project_id)`. The bulk path's LEFT
  JOIN onto `hours` previously summed every row regardless of
  approval state (Draft, PrimaryApproved, Rejected all counted) —
  fixed to the same predicate. Volunteers without a `member_id`
  (volunteer-only certs) get `hours = 0`: they have no rows in the
  `hours` table to draw from, and the cert still issues — hours
  just isn't the right metric for them.

- **2C — profile total reflects cert hours, no double-count.** Under
  2B's rule, `certificates.hours` for a given (member, project) is
  EXACTLY the slice of that member's profile total
  (`members.total_hours`, maintained by
  `recomputeMemberTotalHours`) contributed by that project — they're
  the same SQL aggregate. Issuing a cert doesn't write to the `hours`
  table and doesn't trigger a recompute, so no second tally can form;
  the cert and the profile reference one source of truth by
  construction. (The old free-typed `hours` column on `certificates`
  rows that were issued before this change is left in place — those
  rows pre-date the new rule and the profile total has always come
  from `hours`/`members.total_hours`, not from the cert column, so
  there's nothing to backfill.)

New error code `err.business.project_not_complete` with matching
entries in `assets/js/lib/strings/{ar,en}.js`. Pre-commit parity
check passes (1644 keys each side). No DB schema change.

Live smoke-tested as `apple_reviewer` (head of Events / COM_007):
- Issue against `PRJ_APLREV2` (Planned) → rejected with
  `err.business.project_not_complete`, `errorParams.status = "Planned"`.
- Issue against `PRJ_APLREV1` (Completed) with client `hours: 99` →
  cert created with derived `hours: 0` (member has no FinalApproved
  hours for that project). Test cert cleaned up post-verify.

**iOS impact:**
- **2A — needs follow-up on iOS.** The cert-issue project picker
  should filter to `project_status = 'Completed'` only, or surface a
  disabled-with-hint state for non-completed projects. Without this,
  iOS admins will see ineligible projects, pick one, and get a 409
  toast. The error code surfaces cleanly via the existing
  localizeError flow once iOS regens `Localizable.strings` from
  these catalogs.
- **2B — needs follow-up on iOS.** The cert-issue hours field can
  drop free input. Either remove it from the form entirely (server
  is authoritative, the value will be 0 for volunteers and the
  member's FinalApproved sum otherwise), or convert it to a
  read-only display populated from a preview lookup. The server now
  silently ignores whatever the client sends.
- 2C: no iOS work; the profile total endpoint already reads
  `members.total_hours` which has always been the source of truth.

## [Web] 2026-05-28 · certificate print dimensions + require role on issuance (ticket SUP_BNYPAHUK)

Two independent fixes from the same admin support ticket:

- **1A — certificate print dimensions.** The print block in
  `assets/css/cert.css` was locking `.cert-sheet` to `285mm × 198mm`
  on the assumption that the browser would always honour
  `@page { margin: 6mm }`. Safari and any user who picked a custom
  margin in their print dialog were getting a sheet sized for a
  printable rectangle the browser wasn't actually providing → cert
  came out scaled-down with large whitespace, or cropped. Reporter:
  "the certificate is excellent, but its dimensions need adjusting —
  when printing, the certificate doesn't come out with correct
  dimensions."
  Fix: `.cert-sheet` now uses `width: 100%; height: 100%;
  aspect-ratio: auto; margin: 0` in print, so it fills whatever
  printable rectangle the browser actually allocates after the @page
  margins / user-overridden margins / browser defaults. The cqi-based
  internal typography rescales with the new container width. Verified
  by previewing the cert at an A4-landscape pixel viewport (1123×794
  at 96 DPI) — the screen render fills the rectangle exactly, with
  the proportions print will produce.

- **1B — require role on cert issuance.** `certsIssue` and
  `certsBulkIssue` in `supabase/functions/api/actions/certs.ts` were
  silently inserting `NULL` when `role` was missing or blank. President's
  rule via the same ticket: "either the person's committee role or a
  specific role must be written, but we should not issue anything
  without a role." Both handlers now trim the incoming role and throw
  `err.required.cert_role` (400) if it's empty. Server is the
  authoritative gate — covers the web admin form, the iOS app (which
  already guards client-side in build 87), and any future caller.
  Existing rows with `role IS NULL` are unaffected; the gate only
  applies to new issuances.

- New error code `err.required.cert_role` with matching entries in
  `assets/js/lib/strings/{ar,en}.js` — pre-commit parity check passes
  (1643 keys both sides).
- Edge function deployed; grep confirms 2 occurrences of the new code
  in the live bundle (one per handler).
- No schema or migration changes.

**iOS impact:**
- 1A: none. The certificate is rendered by the web template only;
  iOS never produces the cert document itself.
- 1B: client already guards (build 87). The new `err.required.cert_role`
  will surface as a raw code in any older iOS build that issues a
  cert with an empty role — until iOS regens `Localizable.strings`
  from `assets/js/lib/strings/{ar,en}.js` on its next build. No
  Codable / response-shape changes.

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
