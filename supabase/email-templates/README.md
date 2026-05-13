# Supabase email templates

Source of truth for the transactional emails Supabase Auth sends on
behalf of the project (password recovery, magic links, signup
confirmation, etc.). Supabase stores the active versions in the
dashboard — these files are the version-controlled originals that get
pasted back in if the dashboard copy is lost or needs review.

## How to update

Templates are uploaded via `supabase config push`, NOT pasted into the
dashboard. The `[auth.email.template.recovery]` block in
`supabase/config.toml` points at `password-recovery.html` and the push
applies it to the linked project. This keeps the live template in
version control and avoids the dashboard-drift class of bugs.

```bash
# Edit the .html file
$EDITOR supabase/email-templates/password-recovery.html

# Push to the linked Supabase project
supabase config push --yes

# Verify by sending a test (see "Testing" below)
```

The `--yes` flag is important — without it the CLI shows a diff and
waits for `[Y/n]`, and a tail/grep pipe can swallow the prompt with
its default-Y answer (we hit this once and accidentally pushed a
`max_frequency` regression). With `--yes` you accept the diff
intentionally; review what the diff is BEFORE running.

If you ever do edit a template in the dashboard, also update the file
here and run `config push` so they don't drift apart.

## Templates

| File | Supabase template | When sent |
|---|---|---|
| `password-recovery.html` | Reset Password | `users.sendPasswordReset` admin action |

Plus one Edge-Function-generated email (not a Supabase Auth template,
not pasted into the dashboard — composed inline by the action handler):

| Source | When sent | Recipient |
|---|---|---|
| `supabase/functions/api/actions/applications.ts` → `notifyNewApplication()` | After `applications.submit` succeeds | `info@ssamau.com` (shared admin inbox) |

The new-application email uses its own SMTP path (`supabase/functions/api/_email.ts`) rather than Supabase Auth's SMTP, because Supabase Auth's SMTP is reserved for auth-related transactional mail (signup confirm, password recovery, magic links). For our custom notification, we connect directly to Google Workspace SMTP using the same `info@ssamau.com` app-password — stored as separate Edge Function secrets:

```bash
supabase secrets set \
  SMTP_HOST=smtp.gmail.com \
  SMTP_PORT=587 \
  SMTP_USER=info@ssamau.com \
  SMTP_PASS=<16-char google workspace app password> \
  SMTP_FROM='SSAM <info@ssamau.com>'
```

If these aren't set, the Edge Function logs a warning and the
notification is skipped — the application still saves successfully.

The other Supabase templates (Confirm signup, Magic Link, Change Email
Address, Invite user) are NOT customised yet — they keep the Supabase
defaults until we have a flow that actually triggers them. The member
portal (Branch 4) will add at least Confirm signup; we'll add it here
when that lands.

## Variables

Supabase uses Go-style `{{ .Variable }}` syntax. The full list per
template type is in the Supabase Auth docs, but for password recovery
the ones we use are:

| Variable | What it is |
|---|---|
| `{{ .ConfirmationURL }}` | The magic link that lands on `/reset-password.html` |
| `{{ .Email }}` | Recipient's email — useful for "you're getting this because…" copy |
| `{{ .SiteURL }}` | Project site URL (configured in Supabase Auth settings) |

## SMTP

These templates only get sent if **Custom SMTP** is configured under
Authentication → SMTP Settings. We use Google Workspace SMTP via
`info@ssamau.com`:

| Field | Value |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `587` |
| Username | `info@ssamau.com` |
| Password | Google Workspace app password (generate fresh; not committed) |
| Sender email | `info@ssamau.com` |
| Sender name | `SSAM — نادي الطلبة السعوديين في ملبورن` |

Without custom SMTP, Supabase falls back to its default sender
(`noreply@mail.app.supabase.io`), which has a 4-emails-per-hour
rate limit on the free tier and lands in spam more often.

## Testing

After saving a new template:

```bash
# Trigger a recovery email to your own address via the Supabase API
curl 'https://pfibxvwiulwiiuwerawe.supabase.co/auth/v1/recover' \
  -H "apikey: <SUPABASE_ANON_KEY>" \
  -H 'Content-Type: application/json' \
  -d '{"email":"your-email@example.com"}'
```

Or from the running site: log in as a superadmin → Users tab → click
📧 next to any migrated user.

Check the rendered email on:

- Gmail (mobile + web)
- Apple Mail (iOS + macOS)
- Outlook (web — Outlook desktop is most likely to mangle the
  table-based layout; check there too if a leadership member uses it)
