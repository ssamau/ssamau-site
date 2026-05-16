# SSAM site — current status

> One-line: i18n + RTL fix done. Head portal now has attendance (with
> edit/delete) and a rich members tab mirroring admin (sans edit/NID).

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

**Head members tab — rich admin-like layout** (2026-05-16). Heads now
get the same row shape admin uses on the Members tab, scoped to their
own committee, with two permission-deltas vs admin:
- National ID column REMOVED (privacy — heads aren't admins).
- No ✏️ edit / 🗑️ delete buttons; heads can only 👤 view profile,
  view 🖼/📄 uploaded files, and 📩/🔄/❌ manage portal invites.

Implementation:
- [head.html](head.html:204): table cols are now Name / Contact / Role
  / Hours / Status / Actions. Two modals embedded at the bottom of
  body: `#ov-member-invite` (copied from admin.html) and `#ov-hd-profile`
  (custom — profile hero + stats + hours history modal, not a separate
  tab like admin uses).
- [head/tabs/members.js](assets/js/head/tabs/members.js) — full
  rewrite. Mirrors admin's renderMembers cell shapes (contact stack
  with LTR + 📱/💬 prefixes; file-icons next to name; invite-state
  buttons gated off `account_*` flags). New module-level cache
  `_members` so language toggles re-render without re-fetching.
- [head/main.js](assets/js/head/main.js) — wires `hd.members.*` click
  actions + the shared `sendInviteByEmail` / `sendInviteByPin` /
  `copyShownPin` / `closeModal` actions used inside the invite +
  profile overlays.
- Server already permits heads on `auth.invite.*` and
  `storage.getMemberFile` (committee-scoped check), so no Edge
  Function changes were needed.

**Previously shipped: head attendance tab** — record / edit / delete
attendance against either a project from the head's committee or an
ad-hoc meeting (Online/InPerson with date/time/location). Hours from
meetings sum into the member's `total_hours` via the widened
`recomputeMemberTotalHours()`. Migration
`20260516120001_head_attendance_meetings.sql` adds nullable meeting
columns + a XOR check.

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
