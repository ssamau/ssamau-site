# Branch 4 — Member Portal Implementation Plan

Living document. Update phase statuses as we land code; the **Status** column
on the phase table is the canonical "what's done / what's next" view.

## Why this branch exists

Branches 1–3 transformed existing functionality — same ~19 admin users doing
the same work, just on better infrastructure. Branch 4 introduces a **new
class of user**: the ~98 regular SSAM members who currently have rows in the
`members` table but no way to log in. They need:

- A signup flow (admin-side invite → member-side credential setup)
- A login routing rule so they land on their own portal, not the admin one
- A separate UI shell (`member.html`) with their own tab tree
- Edge Function actions for self-service (read own hours, edit own profile,
  sign up for opportunities)

## Foundations already in place

These are NOT part of Branch 4 — they were built during the Supabase Auth
migration (`feature/supabase-auth`, May 13) and are ready to build on:

- `public.users.auth_user_id` → `auth.users.id` FK linkage exists
- `public.users.access_level` enum already includes `'member'` and
  `'volunteer'` — the schema is ready for member-tier accounts
- `auth.resolveIdentifier` action supports identifier lookup by email,
  national_id, OR username — works for members the same as admins
- `auth.whoami` returns the unified app-level profile after Supabase sign-in
- Hash router + per-page mount/unmount pattern (`assets/js/admin/main.js`)
  is reusable for `member/main.js`
- RLS is locked: all data flows through the Edge Function, no PostgREST.
  Member-scope checks happen in handlers, not via Postgres policies — we'll
  migrate to RLS only if/when there's a perf reason

## Design decisions

| Question | Choice | Why |
|---|---|---|
| One HTML shell or two? | **Two**: keep `admin.html`, add `member.html` | Smaller bundle per audience. Different mobile UX. RBAC simpler — visiting `member.html` implies member intent. |
| Where do member auth credentials live? | **Supabase Auth, no legacy** | One auth system for the new cohort. The 4 legacy president/leads stay HS256 (their migration is a separate deferred item). |
| When do `users` rows get created for members? | **At invite time** | Admin clicks "Invite" → creates `users` row with `access_level='member'` and a signup token/PIN → that row is "pending signup" until member completes flow. Lets us look up join status from one query. |
| `members.auth_user_id` direct column? | **No — defer** | The 3-table join (`auth.users → users → members`) already works in the Edge Function. Denormalising helps only if we move reads to PostgREST + RLS, which is out of scope. |
| Members access via PostgREST + RLS or Edge Function? | **Edge Function** | Migration `20260514120002_rls_lockdown` denies anon + authenticated everything; service role bypasses. Keep that. Member-scope checks like `user.member_id === row.member_id` in handler code. |
| Two invite paths or just one? | **Both**: email link + NID-and-PIN | 98% phone audience — many members don't reliably check email. PIN path lets admin pass credentials via WhatsApp / in person. Email path is faster for tech-comfortable members. |

## Phasing

Each phase ends with a working, deploy-safe app. We can ship Phase 1+2 first
and defer the rest to a follow-up branch if priorities shift.

| Phase | Scope | Status |
|---|---|---|
| **1** | DB migration for invite/signup state on `public.users` | 🚧 In progress |
| **2** | Edge Function invite actions (`auth.invite.byEmail`, `.byPin`, `.revoke`) + admin "Invite" button in Members tab | ⏳ Pending |
| **3** | Public signup endpoints (`auth.signup.completeByToken`, `.completeByPin`) + `signup.html` page | ⏳ Pending |
| **4** | Login routing: `access_level='member'` redirects to `member.html` instead of `admin.html` | ⏳ Pending |
| **5** | Member portal SPA shell + 4 tabs (profile, own hours, opportunities, assignments) | ⏳ Pending |
| **6** | Closing items: CV upload via Supabase Storage + member self-service password reset wired to existing branded template | ⏳ Pending |

## Phase details

### Phase 1 — DB scaffolding

One migration: `supabase/migrations/20260514130001_member_signup_invites.sql`

**Schema changes to `public.users`:**

| Column | Type | Default | Purpose |
|---|---|---|---|
| `password_hash` | TEXT | (existing) | **Drop NOT NULL** — Supabase-only accounts (members + future migrated leadership) don't store a password here; Supabase Auth owns it. Only the 4 legacy holdouts need a value. |
| `signup_pin_hash` | TEXT NULL | NULL | bcrypt hash of a one-time 6-digit signup PIN. Set by `auth.invite.byPin`, cleared on signup completion. |
| `signup_pin_expires_at` | TIMESTAMPTZ NULL | NULL | When the PIN stops being accepted. Default expiry: invite time + 72h. |
| `signup_token` | TEXT NULL UNIQUE | NULL | Opaque random token for email-link signup. UNIQUE so a leaked token can't be replayed against another user. |
| `signup_token_expires_at` | TIMESTAMPTZ NULL | NULL | When the token stops being accepted. Default expiry: invite time + 7d. |
| `signup_completed_at` | TIMESTAMPTZ NULL | NULL | Audit timestamp: when the member finished signup. |

**State machine** (no CHECK constraint — too rigid during transition; documented in column comments instead):

```
                                       │
                              invite-time creation:
                                       │
                                       ▼
                ┌───────────────────────────────────────────┐
                │  Pending signup                           │
                │  ───────────────                          │
                │  - access_level = 'member' (or volunteer) │
                │  - signup_token  OR signup_pin_hash set   │
                │  - auth_user_id  NULL                     │
                │  - password_hash NULL                     │
                │  - signup_completed_at NULL               │
                └────────────────┬──────────────────────────┘
                                 │
                  member signs up successfully
                                 │
                                 ▼
                ┌───────────────────────────────────────────┐
                │  Active                                   │
                │  ─────                                    │
                │  - auth_user_id NOT NULL                  │
                │  - password_hash NULL                     │
                │  - signup_token / signup_pin_hash NULL    │
                │  - signup_completed_at = NOW()            │
                └───────────────────────────────────────────┘
```

Plus the existing "Legacy" state (password_hash NOT NULL, auth_user_id NULL) — only the 4 holdouts.

### Phase 2 — Invite Edge Function actions

Extends `supabase/functions/api/actions/auth.ts`:

- **`auth.invite.byEmail({ member_id, redirectTo? })`** — generates a 64-char hex token via `crypto.getRandomValues()`, upserts a pending-signup `users` row, sends an Arabic-first invite email with link `redirectTo + '?token=' + token`. Returns `{ sent: true, expires_at }`.
- **`auth.invite.byPin({ member_id })`** — generates a 6-digit PIN, bcrypt-hashes (rounds=10, matching legacy convention), upserts a pending-signup `users` row. Returns `{ pin: '123456', expires_at }` — the plaintext PIN is in the response **once** so the admin can copy/paste to WhatsApp. After this response, the PIN is unrecoverable.
- **`auth.invite.revoke({ member_id })`** — clears `signup_token`, `signup_pin_hash`, and their expiries. Used if a head wants to cancel a pending invite before the member completes it.

Permissions (matches `users.resetPassword`):
- Superadmin can invite any member
- Head can invite members in their own committee only

Admin UI hook (`assets/js/admin/tabs/members.js`):
- For each member row where `member.users IS NULL`: add a small "Invite to portal" pill button
- For each member row where `member.users.signup_completed_at IS NULL AND member.users.id IS NOT NULL`: show "Resend invite" + "Revoke" actions
- For each member with `signup_completed_at IS NOT NULL`: show a green "Joined" badge

### Phase 3 — Public signup endpoints

Extends `auth.ts`:

- **`auth.signup.completeByToken({ token, password })`** — looks up `users` row by `signup_token`, verifies not expired, creates `auth.users` via Supabase admin API with the user's email + chosen password, links `users.auth_user_id`, clears signup state.
- **`auth.signup.completeByPin({ national_id, pin, password })`** — looks up `members` row by `national_id`, joins to `users` row, verifies PIN against `signup_pin_hash` via bcrypt, then same auth.users creation flow.

Frontend: `signup.html` (Arabic-first, mobile-first) with two modes:
- `?token=XXX` URL → email-link mode, only asks for password
- No URL param → NID+PIN mode, asks for national_id + pin + password

Both modes added to `PUBLIC_ACTIONS` allowlist in `_helpers.ts`.

### Phase 4 — Login routing

Modify `assets/js/login.js`:

```javascript
// After successful login (either Supabase or legacy path)
const session = getSession();
const isAdmin = session.access === 'superadmin' || session.access === 'head';
location.href = isAdmin ? 'admin.html' : 'member.html';
```

Also: `member.html` checks session on load — kicks superadmins/heads back to `admin.html` (prevents a stale-link scenario where a freshly-promoted user has a member session cached).

### Phase 5 — Member portal SPA shell

- `member.html` — Arabic-first RTL shell mirroring admin.html's layout (header with logo + greeting + logout, sidebar drawer on mobile, main content area)
- `assets/js/member/main.js` — hash router, same registration pattern as admin
- `assets/js/member/tabs/`:
  - `profile.js` — view + edit own profile (calls `members.getOwn` + `members.updateOwn`)
  - `hours.js` — own approved + pending hours (calls `hours.listOwn`)
  - `opportunities.js` — browse open opportunities + sign up (filters `opportunities.list` to own committee or "open to all", uses existing `interest.submit`)
  - `assignments.js` — opportunities the member is confirmed for (calls `assignments.listOwn`)

Routes: `#/member/profile`, `#/member/hours`, `#/member/opportunities`, `#/member/assignments`.

New Edge Function actions:
- `members.getOwn` — returns the caller's own member row (no admin scope check; uses `user.member_id` as the implicit filter)
- `members.updateOwn` — updates a whitelist of fields on the caller's own member row (name, phone, email, address, skills, etc.). NOT allowed to update: committee_id, club_role, status, total_hours.
- `hours.listOwn` — returns only the caller's hours
- `assignments.listOwn` — returns only the caller's assignments

### Phase 6 — Closing items

- **CV upload via Supabase Storage** — bucket `member-cvs`, RLS policy "members can read/write their own folder identified by `auth_user_id`". `profile.js` adds an `<input type="file">` that uploads then patches `members.cv_url`.
- **Member self-service password reset** — wire "Forgot password?" link on `login.html` to call Supabase Auth's `resetPasswordForEmail()`. The branded recovery template uploaded on May 13 already covers this — works for members and admins both.

## Risk callouts

- **`users.password_hash` NOT NULL drop** — backwards-compatible (existing rows have values), but a follow-up migration could re-tighten it once the 4 legacy holdouts are migrated.
- **`users.username` UNIQUE NOT NULL on pending-signup rows** — generate deterministic `mbr_<member_id>` placeholder since `member_id` is unique. Member never sees this username; it's an internal handle.
- **Race: admin invites, member signs up before email delivers** — token verification is single-use server-side, only one path wins. Fine.
- **`supabase config push` ban still in effect** — none of these phases require it. We're only writing SQL migrations (applied via `supabase db push`), Edge Function code (`supabase functions deploy api`), and frontend (Netlify auto-deploys on merge). The auth config audit is still on the deferred list.
- **Bcrypt cost** — keep rounds=10 to match legacy. `_helpers.ts` already provides `bcryptHash`/`bcryptCompare`.
- **Email deliverability for invites** — invite emails go via the same SMTP path the application-notification email uses (`supabase/functions/api/_email.ts`). Already proven to work after the May 13 denomailer encoding fix.

## What lands now (Phase 1)

This commit lands ONLY the migration. Phase 2 (invite Edge Function actions
+ admin UI button) is the next commit. The migration is intentionally
backwards-compatible — applying it on its own doesn't change any
application behaviour. It just opens the schema for the rest of Branch 4.
