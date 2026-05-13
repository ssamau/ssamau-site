# Supabase backend

All backend infrastructure for the SSAM Website lives on Supabase:
database, auth, storage, and edge functions. Netlify is reduced to
static hosting + the redirect that fronts the Edge Functions endpoint.

## Layout

```
supabase/
├── config.toml            Project config — schemas, auth, storage, etc.
├── migrations/            Schema migrations, applied in filename order.
│   ├── 20260513120001_initial_schema.sql        (port of Netlify 0001)
│   ├── 20260513120002_hours_breakdown.sql       (port of Netlify 0002)
│   ├── 20260513120003_opportunities_and_approval.sql (port of 0003)
│   ├── 20260513120004_membership_applications.sql    (port of 0004)
│   ├── 20260513120005_apply_form_v2.sql               (port of 0005)
│   ├── 20260513120006_members_full_profile.sql        (port of 0006)
│   └── 20260513120007_application_whatsapp.sql        (port of 0007)
└── functions/             Edge Functions (Deno) — one folder per function.
```

Each migration in `migrations/` is a hand-port of the corresponding
`netlify/database/migrations/000N_*.sql` file. Behaviour is identical;
the comments inside each file note any Supabase-specific changes (there
were none of consequence — Postgres triggers + DO blocks + ALTER TABLE
all run unchanged).

## Local development

```bash
# One-time
brew install supabase/tap/supabase
supabase login

# Once we link to the real project:
supabase link --project-ref <project-ref>

# Spin up a full local Supabase stack (Postgres + Auth + Storage +
# Functions runtime + Studio + Inbucket email trap)
supabase start

# Re-apply migrations from scratch (wipes the local DB)
supabase db reset

# Read locally-captured emails (magic links during testing)
# http://localhost:54324
```

## Deploy

Migrations are applied to the linked project on `supabase db push`. CI
will run this automatically once the auth migration lands and we point
the deploy at the project ref.

## Rollback procedure (post-cutover)

Production runs on Supabase after merge commit `8fad4b9` (tagged
`v2-supabase-stack`) landed on main. The pre-cutover state lives at
the previous main commit `966e827` (tagged `v1-neon-stack`, also the
HEAD of the `legacy-neon` branch on origin). Netlify's own deploy
history keeps that build live — every Netlify deploy is independently
addressable via "Publish deploy" indefinitely.

If Supabase fails:

1. Netlify dashboard → Deploys → find the deploy at commit `966e827c`
   (it's the one immediately before the cutover merge `8fad4b9`).
   Click "Publish deploy".
2. The Neon DB still has all data — Netlify DB integration was never
   deleted. The Netlify Functions in that deploy still read/write to it.
3. Netlify env vars for `JWT_SECRET` stay set in the project settings.
   `NETLIFY_DATABASE_URL` is auto-injected by the integration, no
   action needed.
4. Total rollback time: ~30 seconds. DNS doesn't change.

If you'd rather do it in git than the Netlify UI:
`git revert -m 1 8fad4b9` reverts the merge commit, push to main,
Netlify rebuilds at the prior state.
