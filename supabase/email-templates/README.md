# Supabase email templates

Source of truth for the transactional emails Supabase Auth sends on
behalf of the project (password recovery, magic links, signup
confirmation, etc.). Supabase stores the active versions in the
dashboard — these files are the version-controlled originals that get
pasted back in if the dashboard copy is lost or needs review.

## How to update

When you change a template here:

1. Open Supabase Dashboard → Authentication → Email Templates.
2. Pick the template (e.g. **Reset Password**).
3. Switch to the **Source** tab (HTML, not the rich text view).
4. Replace the contents with the file in this folder.
5. Save.
6. Send a test to verify rendering — see "Testing" below.

## Templates

| File | Supabase template | When sent |
|---|---|---|
| `password-recovery.html` | Reset Password | `users.sendPasswordReset` admin action |

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
