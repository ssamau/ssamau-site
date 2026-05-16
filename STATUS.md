# SSAM site — current status

> One-line: All 7 i18n phases shipped + an RTL/LTR layout fix. Now adding
> an attendance tab to the head portal.

Updated: 2026-05-16 (Faisal + Claude). Update this when you ship something
material — the goal is that the next coding session can pick up the
project's mental model without re-reading 6k lines of commit messages.

---

## What just landed (last 7 days)

- **i18n rollout (phases 1–7)** — every user-facing string now flips
  between Arabic + English via a key-based catalog. Live toggle pills
  in every portal sidebar + on the auth pages + on the homepage. Choice
  persists in `localStorage.ssam_lang` and is shared across all pages.
  - Catalogs: `assets/js/lib/strings/{ar,en}.js` (1320 keys, in parity).
  - Helper: `assets/js/lib/i18n.js` (`t()`, `setLang()`, `applyI18n()`).
  - Side-effect import sets `<html dir/lang>` on first paint.
  - HTML elements use `data-i18n`, `data-i18n-placeholder`,
    `data-i18n-title`, `data-i18n-aria-label` attrs; `applyI18n()` walks
    the DOM and writes from the catalog. Re-runs on language change.
  - JS-generated content goes through `t()` calls; tabs re-fire their
    loader on `onLangChange` so dynamic rows pick up the new language.

- **Phase 6: server error codes**
  - Edge Function (`supabase/functions/api/`) now emits stable
    `err.<namespace>.<name>` codes instead of raw English strings.
  - Client `localizeError()` helper in `assets/js/lib/api.js` looks
    codes up in the i18n catalog; unrecognised codes fall through to
    raw text so the rollout doesn't break when the server hasn't
    redeployed yet.
  - **Deploy step pending**: run `npx supabase functions deploy api`
    to push the server-side changes to Supabase. Until that lands,
    the legacy English error strings keep flowing — the client gracefully
    degrades.

- **RTL/LTR layout fix** — sidebar in admin/member/head portals stayed
  glued to the physical right edge in English mode. Fixed by
  converting `assets/css/admin.css` from physical
  (`right: 0` / `margin-right` / `border-right`) to logical
  (`inset-inline-start: 0` / `margin-inline-start` / `border-inline-end`)
  properties. Mobile drawer's `translateX(100%)` keeps a
  `[dir="ltr"] .sidebar { translateX(-100%) }` override so the drawer
  slides off the correct physical edge in both directions.
  Lang-toggle + theme-toggle rows pinned with `direction: ltr` so the
  pill order stays stable across language changes (user clicks AR
  → AR pill stays where it was, only the `.active` class moves).

---

## Active work

**Head-portal attendance tab** (suggested by a committee head 2026-05-16).
The current head portal (`head.html`) doesn't have an attendance section
— heads can mark attendance only on the admin portal, which requires
admin tier.

Scope (agreed with user):
1. New `attendance` tab in head sidebar, between `hours` and
   `applications`.
2. Two registration modes:
   a. Linked to an existing project/event from the head's committee
      → uses the existing project-scoped flow.
   b. Ad-hoc meeting (online / in-person) → head enters meeting title,
      type, date, start time, optional location.
3. For BOTH modes, the head can input hours which auto-FinalApprove
   (skip the two-stage approval chain) and count toward the member's
   `total_hours` immediately.
4. Attendees: members of head's committee + free-text external
   volunteers (name/email).
5. Schema: migration adds nullable meeting fields to `attendance`,
   makes `project_id` nullable, adds a CHECK that exactly one of
   `project_id` / `meeting_title` is set per row. `meeting_hours`
   column holds the head's input; `recomputeMemberTotalHours()` is
   widened to sum both `hours` table (FinalApproved) + attendance
   `meeting_hours`.

---

## Architecture map (rough)

```
assets/js/
  lib/                # shared helpers (api, auth, ui, format, i18n, theme)
    strings/{ar,en}.js   # i18n catalogs (1320 keys each, in parity)
    i18n.js              # t() + applyI18n() + setLang() + onLangChange
    api.js               # callApi() + localizeError() + apiOrThrow()
    ui.js                # toast/modal/confirmDelete/refresh/api wrappers
  admin/              # /admin.html — 16-tab presidency portal
    main.js, router.js, dispatch.js
    tabs/             # one module per sidebar entry
  head/               # /head.html — committee-head portal
    main.js, router.js
    tabs/             # dashboard / members / opps / hours / apps / my-profile
  member/             # /member.html — member portal
    main.js, router.js, dispatch.js
    tabs/             # profile / hours / opportunities / assignments

supabase/functions/api/   # single Edge Function, action-dispatcher
  index.ts, _helpers.ts, _sql.ts, _email.ts
  actions/                # one file per logical area
                          # (auth, members, hours, opportunities, ...)
```

Portals share `assets/css/admin.css` for the sidebar + topbar chrome.
Head + member ALSO load their own tiny stylesheet for tab-specific
styling. Auth pages share `assets/css/login.css`.

Key design decisions worth remembering:
- Status / role / attendance enums store CANONICAL ENGLISH in DB,
  display localized via `_KEY` map → `t(map[enumValue])`. Never
  localize the stored value — the cache (`STATUS_COLORS` etc.) keys
  off the English string and a translation would break it.
- `localizeError()` is forward-compatible: any new server-side error
  code that hits the client without a catalog entry shows as the raw
  `err.xyz` code rather than blank, so missing-entry regressions are
  visible during dev.
- Toggle pills (`.lang-toggle`, `.sb-theme-row`) use `direction: ltr`
  on the container so children keep a stable physical order
  regardless of `<html dir>`. The same reasoning applies any time you
  add a button row where physical position matters more than reading
  direction.

---

## Deployment

- **Static site** (HTML/CSS/JS): auto-deploys on `git push origin main`
  via Netlify. ~30s after push, prod is live.
- **Edge Function** (`supabase/functions/api/`): deploys separately
  with `npx supabase functions deploy api`. Not auto-triggered by git.
- **Database migrations**: deployed with `npx supabase db push`. Not
  auto-triggered by git either. Migrations live in
  `supabase/migrations/<timestamp>_<name>.sql` and use a strict
  timestamp prefix; supabase CLI applies them in order.
- **Service worker cache**: bumped manually in `sw.js` per commit
  with a `CACHE_VERSION` constant. Bumping is mandatory whenever
  any shipped JS / CSS / HTML changes, otherwise SW serves stale.

## Known open items

- [ ] `npx supabase functions deploy api` to activate Phase 6 server
      error codes in prod.
- [ ] No automated tests on i18n key parity — `node -e` script in
      commit notes is the manual check. Consider a pre-commit hook
      if catalogs grow further.
- [ ] `apply.css` and `index.css` have several `text-align: right` /
      `border-right` rules that work fine in Arabic but may need
      logical-property conversion if/when more pages get tested in
      English mode. Audited only the obvious ones (`.ev-strip-content`,
      `.hd-welcome` mobile).
