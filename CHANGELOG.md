# SSAM Web — CHANGELOG

Cross-repo log of changes that may affect the iOS client. Every entry
that needs iOS work has an explicit `**iOS impact:**` line — see the
sync contract in `~/Desktop/SSAM-Demo-Output/pdfs/ios-app-requirements.pdf`
§17.

Newest first.

---

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
