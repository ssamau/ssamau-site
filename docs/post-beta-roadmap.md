# Post-Beta Roadmap — 2026-05-15

Living plan for the 6 follow-up items the president wants addressed after
the beta cutover (PR #22 merged 2026-05-15, prod is now feature-ready).
Phases are ordered by dependency + shared scope so we can ship coherent
PRs instead of fragmenting across the codebase.

## Status table (canonical "what's done / what's next")

| Phase | Items | Status |
|---|---|---|
| **A** | CV upload + member profile photo upload (via Supabase Storage) | ⏳ Pending |
| **B** | Events display upgrade + past-events-dynamic | ⏳ Pending |
| **C** | Search-as-you-type on admin dropdowns | ⏳ Pending |
| **D** | Advisor-with-hours role | ⏳ Pending |

## Why this ordering

- **A first** because (1) Phase 6 of Branch 4 already had CV upload on its
  scope, (2) profile-photo upload uses the exact same primitive, and
  (3) Phase B's event photos reuse the Storage bucket pattern. Ship the
  foundation once.
- **B next** because the homepage events area is the president's most
  visible ask. Display upgrade + past-events-dynamic land together — both
  modify the same DOM, splitting them would mean back-to-back churn on
  `index.html` and `index.js`.
- **C** is independent of A/B/D. Ship anytime, but third because the
  scope is moderate and the rest of the items are higher-visibility.
- **D last** because it's a schema change (`hours` needs an
  `advisor_id` path) with broader ripple effects (admin UI, approval
  guards, totals query). Isolating it means it doesn't block A/B/C
  beta-readiness if anything in D needs more cycles.

## Phase A — Storage foundation (CV + profile photo)

### Why these together
Both are "member uploads a file, URL gets stored on `members.<col>`,
admin + member portal can view". Same Storage bucket, same RLS-via-
Edge-Function pattern, same file-type validation. Two files, one
infrastructure pass.

### Pieces

| Piece | Details |
|---|---|
| Storage buckets | Two private buckets: `member-cvs` and `member-photos`. Private so RLS-via-Edge-Function gates access; the Edge Function returns signed URLs (1h TTL) on read. |
| New Edge Function action | `storage.uploadMemberFile({ kind: 'cv'\|'photo', filename, contentType, base64Data })`. Auth-gated, scoped to caller's `user.member_id`. Validates content-type (`application/pdf` for cv, `image/*` for photo) + size cap (5 MB cv, 3 MB photo). Writes to `<bucket>/<member_id>/<filename>` and updates `members.cv_url` / `members.profile_photo_url` with the storage path (NOT a public URL — we resolve on read). |
| New Edge Function action | `storage.getMemberFile({ kind, member_id })`. Returns a 1h signed URL. Auth: any logged-in user can fetch their own; admin-tier can fetch anyone's; head can fetch own committee's. |
| Frontend — member portal profile tab | Drag-or-pick file input for each. Shows current file (preview thumbnail for photo, "View CV" link for pdf). Upload progress + replace + delete actions. |
| Frontend — admin members tab | Per-row pdf icon if CV exists, click to open. Per-row avatar pulls from photo if exists, falls back to initials. |
| Migration | Already-existing `members.cv_url` and `members.profile_photo_url` are TEXT — repurposing to store storage paths. No schema change needed. |

### Recovery instructions if compaction hits mid-phase
1. `git checkout -b feature/storage-cv-photo`
2. Run `supabase storage list` to confirm bucket state — re-create idempotently if needed.
3. Implement the 2 Edge Function actions in `supabase/functions/api/actions/storage.ts` (new file).
4. Hook into `assets/js/member/tabs/profile.js` (uploader) and `assets/js/admin/tabs/members.js` (display).

## Phase B — Events display upgrade + past-events-dynamic

### Why these together
Both replace static homepage event cards with DB-driven ones. The
display upgrade adds photos / attendee count / manager; past-events
makes the same cards DB-sourced instead of hardcoded. Doing them in
one PR avoids touching `index.html`'s events section twice.

### Pieces

| Piece | Details |
|---|---|
| Schema | Add `projects.cover_photo_url` (TEXT, storage path — reuses Phase A bucket or a dedicated `project-photos` bucket). Optional `projects.gallery_photo_urls` (TEXT[]) for multi-photo events. |
| Edge Function action | Extend `getProjects` or add `projects.listHomepageFeatured` returning the N most-recent `event_date < NOW()` projects with photos + attendee count (subquery from `participants`) + manager name + event_date. |
| Frontend — homepage | `updatePastEvents(projects)` in `assets/js/index.js`. Replaces the 3 static `.past-card` divs with cards built from API data. Each card: cover photo / project name / date / role chip / "X attendees" + manager name. |
| Admin — projects tab | File picker for cover photo on project create/edit form. Stores in Storage, updates `projects.cover_photo_url`. |

### Risk callouts
- Existing static cards have specific styling. Make sure new dynamic cards reuse the same CSS classes so the visual landing-page identity is preserved.
- President said "show photos if any" — fail-soft: if no `cover_photo_url`, render with a placeholder gradient (current static cards already do this).

## Phase C — Search-as-you-type on admin dropdowns

### Why
President: "Search for names appears as a list. I want if we can write the
name in the blank space and search." Currently the admin uses `<select>`
with 100+ options for member pickers — fine for desktop but painful on
mobile + slow when scanning by name.

### Pieces

| Piece | Details |
|---|---|
| New lib module | `assets/js/lib/typeahead.js` — exports `attachTypeahead(input, { items, displayKey, valueKey, onSelect })`. Renders a hidden `<select>` for form submission compat + an overlay popover for filtered suggestions. Keyboard nav (Up/Down/Enter/Esc), click-outside-to-close, fuzzy match (Arabic + Latin) on substring. |
| Sites to upgrade | (1) Interest modal member picker, (2) Certs modal member picker, (3) Thanks modal member picker, (4) Hours form member picker, (5) Assignments add-member, (6) Profile tab member picker. |
| Backwards compat | Each upgrade is a thin wrapper around the existing `<select>` — replace the `<select>` markup with `<input type="text">` + hidden `<select>` so existing JS that reads `.value` still works. |

## Phase D — Advisor-with-hours role

### Why
President: advisors are senior figures who help at the club level (mentor,
liaison with the embassy, etc.). Currently `advisors` exists as a table
but there's no way to log hours against them. He wants to be able to
record "advisor contributed X hours doing Y" and have it count somewhere.

### Pieces

| Piece | Details |
|---|---|
| Schema migration | `hours.advisor_id INTEGER NULL REFERENCES advisors(id) ON DELETE SET NULL`. Add a CHECK constraint: exactly one of `member_id`, `volunteer_email`, `advisor_id` must be non-NULL. Update `participant_type` enum / accepted values to include `'advisor'`. |
| Edge Function | `recordHours` accepts `participant_type='advisor'` + `advisor_id`. Approval guards stay: head primary-approves Draft, presidency final-approves. |
| Total hours rollup | `recomputeMemberTotalHours()` currently rolls up FinalApproved → `members.total_hours`. New `recomputeAdvisorTotalHours()` mirrors that for `advisors.total_hours`. Schema needs `advisors.total_hours NUMERIC(10,2)` (mirror the members column). |
| Admin UI | Hours tab `participant_type` dropdown adds "مستشار" option. When selected, member-picker swaps to advisor-picker. |
| Advisors tab | Show `total_hours` column. Per-advisor profile (or modal) lists their hours like members do. |

### Risk
Touches the hottest table (`hours`). Migration needs to be additive-only
(no drops/renames on existing rows). The new CHECK constraint can't be
"exactly one non-NULL" if existing rows might violate it — verify before
adding.

## After all 4 phases land

These are the items still on the deferred list, unchanged:
- Dev-account handover UI (manual SQL works today)
- Auth config audit before next `supabase config push`
- Send 17 password reset emails (ON HOLD until beta-readiness confirmed)
- Migrate 4 legacy users (ON HOLD pending emails arrival)
- Capacitor wrap (iOS + Android apps — post-release)
- Fill null phone/whatsapp for Abdullah Al-Dama'in + Rawan Al-Ajmi (data task, not engineering)
