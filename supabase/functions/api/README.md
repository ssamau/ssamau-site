# `api` Edge Function

The single action-dispatch endpoint that replaces
`netlify/functions/api.js` after the cutover. Same wire-protocol — the
frontend POSTs `{ action, ...params }` and gets `{ success, data }` or
`{ success: false, error }` back. Only the URL changes.

## Why one fat function (for now)

The current Netlify Functions architecture is a single file with a giant
action switch. Porting it 1:1 keeps `assets/js/lib/api.js` essentially
unchanged and lets us cut over in one merge. **After** the migration
stabilises (next branch), we'll incrementally pull pure-read actions out
of this function and have the frontend query Supabase tables directly
via the JS client + RLS — the proper Supabase idiom. But that's a
delta-of-delta optimisation, not a precondition for shipping.

## Local development

```bash
# From repo root, after `supabase login + supabase link`:
supabase functions serve api --env-file .env.local --no-verify-jwt

# Then in another terminal:
curl -s -X POST 'http://localhost:54321/functions/v1/api' \
  -H 'Content-Type: application/json' \
  -d '{"action":"healthcheck"}' | jq
```

## Deploy

```bash
supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` is set because the function does its own JWT
verification (against the legacy HS256 secret until the auth migration
swaps to Supabase Auth) — letting Supabase enforce its own JWT layer
would block requests with our custom token.

## Action coverage

Tracker for the migration:

| Status | Action | Notes |
|---|---|---|
| ✅ | `healthcheck` | Smoke test |
| 🟡 | `auth` | TBD — temporarily bcrypt-against-public.users, then Supabase Auth |
| 🟡 | `getMembers`, `getCommittees`, `getAdvisors`, `getProjects` | Pure SELECTs |
| 🟡 | All the CRUD actions (~30) | Port pending |
| 🟡 | `setup.bulkSeed` (4-phase) | Largest port |

🟡 = pending in this branch. Each port is its own commit so reviewer can
isolate any one of them.
