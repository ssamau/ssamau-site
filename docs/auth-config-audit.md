# Auth Config Audit — 2026-05-15

## Why this doc exists

Earlier in the project (before the post-beta roadmap) a `supabase config
push` regressed the prod auth setup — "login via email" got disabled and
the user only caught it because production login broke. That was logged
as a "deferred — audit before next config push" item ever since.

This doc is the audit. It does NOT touch `supabase/config.toml` because
the safest action is leaving the file alone and not pushing.

## TL;DR

**Don't run `supabase config push` against this project.** The local
`config.toml` was hand-written months ago against an older CLI schema
and is missing many of the fields the current CLI (2.98.2) expects.
Pushing it would reset every missing field to its CLI default, which
would silently break things (email rate-limit drops to 2/hour, OAuth
providers reset if any are enabled on the dashboard, MFA gets disabled
in the schema even though it's a Pro-plan toggle).

Manual edits via the Supabase Dashboard remain the right path for
auth changes. The CLI's `--dry-run` option for `config push` doesn't
exist, so there's no safe way to preview a push.

## What's in the local config.toml (kept short)

| Section | Settings present |
|---|---|
| `[auth]` | enabled, site_url, additional_redirect_urls (3 entries — prod, deploy previews, local dev), jwt_expiry=604800 (7d), enable_signup=false, enable_anonymous_sign_ins=false |
| `[auth.email]` | enable_signup=false, double_confirm_changes=true, enable_confirmations=true, max_frequency="1m0s", otp_length=6, otp_expiry=3600 |
| `[auth.email.template.recovery]` | subject + content_path (the branded password-recovery HTML) |
| `[auth.sms]` | enable_signup=false, enable_confirmations=false |
| `[functions.api]` | verify_jwt=false |

## What's MISSING (would be reset to CLI defaults on push)

Comparing to `supabase init` output on CLI 2.98.2, these blocks/fields
are absent from our local config.toml:

### High-risk (would break something)
- **`[auth.rate_limit]`** — CLI default `email_sent = 2` is per HOUR.
  We send invite + recovery emails at well over that rate during normal
  operation. Push would clip outbound email to 2/hour. Setting we'd
  want: at least 100/hour, probably more during the leadership-cutover
  email blast.
- **`[auth] enable_refresh_token_rotation = true`** — default in
  template, almost certainly already true on prod, but explicitly
  setting `false` (current absence is interpreted as default) could
  invalidate every active session.
- **`[auth.external.*]`** — 18 OAuth providers. If any are enabled on
  the dashboard via the Supabase UI, push would reset them all to
  `enabled = false`. (We don't currently use any — but if someone
  enables one in the future without updating this file first, push
  would silently disable it.)

### Medium-risk
- **`[auth] minimum_password_length`** — default 6. Our app prompts
  for stronger; aligning at 6 is fine, but a stricter project-wide
  enforcement is a reasonable upgrade.
- **`[auth] password_requirements`** — empty string (no requirements).
  Could be tightened to `letters_digits`.
- **`[auth.email] secure_password_change = false`** — default. Means
  changing password doesn't require re-auth. Probably fine for the
  member portal flow.

### Low-risk
- `[auth.mfa.*]`, `[auth.passkey]`, `[auth.webauthn]`, `[auth.captcha]`,
  `[auth.web3.solana]`, `[auth.third_party.*]`, `[auth.hook.*]`,
  `[auth.sessions]`, `[auth.email.smtp]` (we use SMTP secrets, not
  config.toml block). All disabled by default; the schema entries
  exist on dashboard regardless. Push would not regress these unless
  we'd somehow enabled them via dashboard.
- `[realtime]`, `[db.pooler]`, `[storage.s3_protocol]`, etc. —
  data-plane settings unrelated to auth.

## What the previous `config push` regression most likely was

Best reconstruction from conversation history + the schema diff:

The push wrote `[auth.email] enable_signup = false` to prod. The
dashboard's "Enable Email provider" toggle was unaffected (it's a
different field), but new members trying to sign up via the magic-link
flow would have failed with "signups disabled" — which the user
described as "login via email was disabled" because the UX-level
symptom was that nobody new could log in.

The fix at the time was to flip the dashboard toggle back manually,
which restored signup. The local config.toml still says
`enable_signup = false` — that's correct policy (admins create members,
no public signup), but it means re-pushing the file would re-disable
signup. Counterintuitive: the local config says what we want, but
pushing it can still break things because the dashboard's invite/
recovery flows use the same flag in unexpected ways.

## Workflow going forward

1. **Default: don't push.** Dashboard edits are the supported path for
   one-off auth tweaks. The dashboard preserves whatever it had before
   for any field you don't touch.

2. **If a config.toml change becomes unavoidable** (e.g. updating the
   branded recovery email template — that's the one case where a push
   is unavoidable because templates aren't dashboard-editable per-
   template), do this checklist FIRST:
   - Run `supabase init` in `/tmp` to dump the current CLI schema.
   - Diff our `supabase/config.toml` against the fresh template.
   - For every field present in the fresh template but absent in ours:
     check the dashboard's current value for that setting and pin it
     explicitly in our config.toml BEFORE pushing.
   - Especially: `[auth.rate_limit] email_sent`, every
     `[auth.external.*] enabled` flag, and `enable_refresh_token_rotation`.

3. **Template-only pushes via the dashboard** — for the recovery
   email, the Supabase Dashboard now (CLI 2.98+) supports uploading
   the template HTML directly through Authentication > Email
   Templates. Use that path instead of `config push` for any future
   template edits.

4. **Re-audit if the CLI minor-version bumps.** The schema changes
   between CLI minor versions; what's safe today is not necessarily
   safe in 6 months.

## Things to verify on the dashboard right now (one-time check)

When you have a free moment, open
https://supabase.com/dashboard/project/pfibxvwiulwiiuwerawe/auth/providers
and confirm:

- Email provider: enabled
- Confirm email enabled: true
- Signup (Email): enabled
- All other providers: disabled
- Rate limit (Authentication > Rate Limits): email > 2/hour
  (whatever the current value is)
- JWT expiry (Authentication > Sessions): 7 days

These are the cells most likely to disagree with our local config.toml,
and the disagreement is what would bite on a future push. If any of
them have drifted from "what we'd expect", reconcile via the
dashboard, not by pushing.
