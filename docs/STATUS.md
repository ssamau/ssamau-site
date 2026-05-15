# SSAM Website — Project Status (2026-05-15)

> **For the next session / after compaction.** Pick this up cold —
> it's the single source of truth for what's shipped, what's open,
> what the president has asked for, and what's deferred.

Branch: `main` is feature-ready for beta. All admin + member portal
flows working; email delivery (invites, thanks, certs, opportunity
notifications) plumbed through Google Workspace SMTP.

## Quick-reference: today's tool tip

- DB URL is in `.env.local` as `SUPABASE_DB_URL`. `psql "$DB_URL"` works.
- Edge Function deploy: `supabase functions deploy api --project-ref pfibxvwiulwiiuwerawe`
- Service-role key in `.env.local` as `SUPABASE_SERVICE_ROLE_KEY` — used for Storage admin calls (creating buckets etc.)
- `supabase db push --include-all` for migrations
- DON'T run `supabase config push` — see [docs/auth-config-audit.md](auth-config-audit.md)
- Local dev: `netlify dev` on `:8888`; preview tool's launch.json already wired
- Branch deploy previews: `https://deploy-preview-<N>--ssamau.netlify.app`

## Where we are right now

| Layer | State |
|---|---|
| Public homepage | Live — president's feedback addressed (stats, inactive filter, short names, event cards w/ photos+attendees+manager, past-events dynamic, 9 specialized committees, مرفأ tagged as Initiative) |
| Member signup | Live — email-link + NID/PIN paths, branded recovery template |
| Member portal SPA | Live — profile (with CV + photo uploads), hours w/ 2-stage approval, opportunities (express interest), assignments w/ self-log hours |
| Admin SPA | Live — all 16 tabs working, structural fix for orphan pages, role refactor (superadmin/admin/head split), interest triage workflow, search-as-you-type on 9 dropdowns |
| Advisor role | Live — schema + total_hours rollup + admin UI in hours modal |
| Storage | Live — `member-cvs` + `member-photos` (private, signed URLs), `project-photos` (public) |
| Email delivery (SMTP) | Live — invite, password reset, application notification, thanks emails, cert emails, opportunity notifications |
| Cert verification page | Live — full diploma design with print-to-PDF |

## Currently open

**PR #28** — designed cert page + opportunity-published email notifier (3 modes incl. BCC). Pending merge to prod. Already deployed the Edge Function side — only the frontend assets need Netlify to pick up the merge.

## President's outstanding asks (as of 2026-05-15 evening)

From the WhatsApp screenshots, in time order:

1. ✅ **Homepage stats inconsistency** (59 vs 100 active members) — fixed in PR #22
2. ✅ **Committee count 9 vs 10** (مرفأ is an initiative) — fixed in PR #22 via new `committees.category` column
3. ✅ **Inactive members on homepage** — fixed in PR #22
4. ✅ **Show only first + last name on homepage** — fixed in PR #22 via `shortName()` helper
5. ✅ **Advisors without permissions but with hours** — PR #26 (Phase D)
6. ✅ **Events: photos + attendees + manager** — PR #24 (Phase B)
7. ✅ **Past-events dynamic** — PR #24 (Phase B)
8. ✅ **Search-as-you-type on dropdowns** — PR #25 (Phase C)
9. ✅ **Photo upload for members** — PR #23 (Phase A)
10. ✅ **CV upload via Supabase Storage** — PR #23 (Phase A)
11. ✅ **Eid Al-Adha readiness** — PR #22 (thanks emails + certs actually sending)
12. ✅ **"How does the cert look?"** — PR #28 + `docs/demo-cert.pdf` (sent to him)
13. ✅ **"Thanks/cert emails not arriving"** — root-caused to admin field-name mismatch + fixed in PR #27
14. ✅ **Opportunity-published notification (all / specific / BCC)** — PR #28
15. ⏳ **"Give us guidance on what's required from us and the heads"** — answered with `docs/admin-guide.pdf` (sent to him)

Nothing currently outstanding from him post-PR #28. Waiting on his test.

## Architecture cheat-sheet (for compaction-survival)

- **Frontend**: vanilla JS modules. Admin uses hash router (`#/admin/<tab>`); member portal mirrors same pattern (`#/member/<tab>`). Event delegation via `data-action="<handler>"` attrs, dispatcher in `<admin|member>/dispatch.js`.
- **Backend**: single `api` Edge Function (Deno). Action dispatch via `body.action`. Auth gate uses two paths — Supabase Auth JWT for migrated accounts, legacy HS256 for 4 holdouts (the 4 legacy users in members table that haven't been email-migrated yet). Allowlists: `PUBLIC_ACTIONS`, `ADMIN_ACTIONS`, `SUPERADMIN_ACTIONS` in `_helpers.ts`.
- **RBAC tiers**: `superadmin` (dev only, currently faisal-admin) / `admin` (presidency: 8 leadership accts) / `head` (committee heads: 11 accts, committee-scoped) / `member` / `volunteer`.
- **Hours flow**: §7 of requirements — Draft → PrimaryApproved (committee head) → FinalApproved (presidency). Only FinalApproved counts toward `members.total_hours` / `advisors.total_hours` caches. Principle 2: hours require an attendance=Attended assignment.
- **Storage buckets**: `member-cvs` (private, PDF only, 5MB), `member-photos` (private, image, 3MB), `project-photos` (PUBLIC, image, 4MB). All access via Edge Function service role key; direct anon/authenticated blocked by migration `20260514120002_rls_lockdown`.
- **CSP**: `default-src 'self'; script-src 'self' GTM; style-src 'self' fonts.googleapis.com; style-src-attr 'unsafe-inline'` — inline `<style>` blocks NOT allowed, inline `style=""` attrs ARE. Inline `onclick=` event handlers NOT allowed (script-src-attr).

## Merged-to-main this session arc (after PR #21+#22)

| PR | Commit | What |
|---|---|---|
| [#21](https://github.com/ssamau/ssamau-site/pull/21) | `3ecd367` | Branch 4 Phase 5: member portal SPA + 4 tabs + interest triage + structural fix |
| [#22](https://github.com/ssamau/ssamau-site/pull/22) | `180daa1` | Homepage feedback (stats/inactive/names) + Eid email readiness |
| [#23](https://github.com/ssamau/ssamau-site/pull/23) | `83ec625` | Phase A: CV + profile photo uploads |
| [#24](https://github.com/ssamau/ssamau-site/pull/24) | `a3ef596` | Phase B: events display + past-events-dynamic |
| [#25](https://github.com/ssamau/ssamau-site/pull/25) | `716edb5` | Phase C: typeahead on 9 admin dropdowns |
| [#26](https://github.com/ssamau/ssamau-site/pull/26) | `72f0fca` | Phase D: advisor-with-hours role |
| [#27](https://github.com/ssamau/ssamau-site/pull/27) | (merged) | Fix admin email payload field-name mismatches |
| [#28](https://github.com/ssamau/ssamau-site/pull/28) | *pending merge* | Designed cert page + opportunity notifier |

Plus housekeeping commits: branch cleanup, [docs/auth-config-audit.md](auth-config-audit.md), [docs/admin-guide.pdf](admin-guide.pdf), [docs/demo-cert.pdf](demo-cert.pdf).

## Pending / deferred

| Item | Status | Notes |
|---|---|---|
| **Capacitor wrap** (iOS + Android) | Open | Biggest remaining feature. PWA is solid; wrap is mostly config + asset generation. Estimated 2-3 hrs. |
| **Dev-account handover UI** | Deferred | Manual SQL works today (UPDATE public.users SET access_level=... WHERE username='...'). The UI version would be the atomic-swap modal — needs new SUPERADMIN_ACTIONS entry like `dev.transferDevAccount`. Low priority. |
| **Send 17 password reset emails** | On hold | Until beta-readiness confirmed by president. Cutover for the 17 leadership accounts that don't have Supabase Auth identities yet. |
| **Migrate 4 legacy HS256 users** | On hold | Same cutover — the 4 leadership accounts using `ssam_token`/HS256 instead of Supabase Auth. Removes the legacy auth path entirely from `_helpers.ts`. |
| **Fill null phone/whatsapp for 2 leadership rows** (Abdullah Al-Dama'in, Rawan Al-Ajmi) | Deferred | After beta release per the user. Pure data task, not engineering. |
| **Past `config push` audit recommendations** | Documented | [docs/auth-config-audit.md](auth-config-audit.md) — DON'T push, use dashboard for one-off auth edits. |

## ON-HOLD external coordination

These all wait on the user manually doing something or coordinating with the leadership team:

- **Send the 17 password reset emails** to leadership accounts that don't have a Supabase Auth user yet (one-time per-account `supabase.auth.admin.generateLink({ type: 'recovery' })`).
- **Migrate 4 legacy users** once the password reset emails are out and the users have clicked through.
- **Beta release announcement** to the broader membership.

## Things to remember about workflows

- **Don't run `supabase config push`** — covered in the audit doc, but the short version: local config.toml is missing ~50% of fields the current CLI schema expects, push would silently reset them to defaults (most damagingly email rate-limit dropping to 2/hour).
- **Storage buckets are created via Management API**, not migrations — the migration role doesn't own `storage.buckets`. Pattern is `curl -X POST "https://<ref>.supabase.co/storage/v1/bucket" -H "Authorization: Bearer $SERVICE_KEY" -d '{...}'`.
- **Inline `<style>` blocks fail under CSP**. If you need page-specific styles, create `assets/css/<page>.css` and `<link>` it.
- **Inline `onclick=` event handlers fail under CSP** (`script-src-attr 'self'`). Use `addEventListener` or the `data-action` dispatcher.
- **SW cache version** bumps on every shippable change so installs roll forward. Current value: `v10-2026-05-15-cert-design-and-opp-notify`.
- **Member-tier user trying to load `/admin.html`** gets bounced to `/member.html` via `_requireAuthOrRedirect()` in `admin/main.js`. And vice versa. Use `landingPageForAccess(access)` for routing decisions.
- **`shortName(fullName)`** (in `assets/js/index.js`) is the homepage display helper — returns first + last word only. Apply to anywhere a member name renders publicly.
