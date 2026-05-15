// Interest tab — members express interest in upcoming projects.
//
// Two loaders: `loadInterestAll` for the full set (the tab's default loader),
// and `loadInterest(pid)` for filtering by project from the dropdown. Both
// re-render the same table and update the same stats bar.
//
// Phase-5 admin workflow additions:
//   - "➕ تعيين" per-row button opens the #ov-int-assign modal pre-filled
//     with the interest's member/project + the project's opportunities,
//     auto-selecting the one whose role_name matches the comment hint.
//     Confirming creates an assignment (via assignments.add) AND marks
//     the interest as reviewed in one transaction-of-clicks.
//   - "✓ مراجعة" per-row button toggles reviewed_at directly without
//     creating an assignment (for "no longer relevant" requests).
//   - Reviewed rows render at the bottom + faded; a header toggle hides
//     them entirely so the admin sees only un-triaged requests by default.

import { DB } from '../../lib/state.js';
import { esc, gv, sv, tag, setEl } from '../../lib/format.js';
import { api, apiGet, toast, openModal, closeModal, populateNewSelects } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

// Availability enum (canonical English) → translation key. Shared with
// the participant + opportunity availability vocabulary.
const AVAIL_KEY = {
  Full:    'ap.par.avail_full',
  Before:  'ap.par.avail_before',
  During:  'ap.par.avail_during',
  After:   'ap.par.avail_after',
  Partial: 'ap.par.avail_partial',
};

// Show-reviewed toggle state (default OFF — admins see only fresh
// requests on load, can flip the checkbox to show all).
let _showReviewed = false;

// In-memory cache of the most recently loaded list so we can re-render
// when the toggle changes without a refetch.
let _lastList = [];

// ── INTEREST ─────────────────────────────────────────────────
export async function loadInterestAll() {
  const d = await apiGet('interest.listAll');
  if (!d || !d.success) return;
  DB.interest = d.data || [];
  _lastList = DB.interest;
  renderInterest(applyVisibilityFilter(_lastList));
  updateIntStats(DB.interest);
  populateNewSelects();
}

export async function loadInterest(pid) {
  const d = pid
    ? await api('interest.list', { project_id: pid })
    : await apiGet('interest.listAll');
  if (!d) return;
  _lastList = d.data || [];
  renderInterest(applyVisibilityFilter(_lastList));
  updateIntStats(_lastList);
}

// Show-reviewed toggle handler (wired via data-action in admin/main.js).
export function toggleReviewedVisibility(el) {
  _showReviewed = !!el.checked;
  renderInterest(applyVisibilityFilter(_lastList));
}

function applyVisibilityFilter(list) {
  return _showReviewed ? list : list.filter(i => !i.reviewed_at);
}

export function updateIntStats(list) {
  const yes = list.filter(i => i.interested === true || i.interested === 'TRUE' || i.interested === 'true').length;
  const no  = list.length - yes;
  const pct = list.length ? Math.round(yes / list.length * 100) : 0;
  setEl('int-total', list.length);
  setEl('int-yes',   yes);
  setEl('int-no',    no);
  setEl('int-pct',   list.length ? pct + '%' : '—');
  const bar = document.getElementById('int-bar-vis');
  if (bar) {
    bar.querySelector('.int-yes').style.width = pct + '%';
  }
}

export function renderInterest(list) {
  const tb = document.getElementById('tb-interest');
  if (!tb) return;
  if (!list.length) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.int.empty'))}</td></tr>`;
    return;
  }
  const yesLabel       = t('ap.int.yes');
  const noLabel        = t('ap.int.no');
  const reviewedBadge  = t('ap.int.row_reviewed_badge');
  const unreviewTitle  = t('ap.int.row_unreview_title');
  const assignBtnLabel = t('ap.int.row_assign_btn');
  const reviewBtnTitle = t('ap.int.row_review_btn_title');
  // interest.listAll JOINs members + projects, so the API rows already
  // carry full_name, preferred_name, and project_name. Use them
  // directly; DB lookups remain as a fallback for the rare row missing
  // the joined data.
  tb.innerHTML = list.map(i => {
    const name = i.preferred_name || i.full_name
              || DB.members.find(mb => mb.member_id === i.member_id)?.full_name
              || i.member_id;
    const proj = i.project_name
              || DB.projects.find(pr => pr.project_id === i.project_id)?.project_name
              || i.project_id;
    const yn = i.interested === true || i.interested === 'TRUE' || i.interested === 'true';
    const reviewed = !!i.reviewed_at;
    const availLabel = i.availability_type && AVAIL_KEY[i.availability_type]
      ? t(AVAIL_KEY[i.availability_type])
      : (i.availability_type || '—');
    // Encode the row payload in data-attrs so the dispatcher handlers can
    // open the assign-modal / toggle reviewed without re-fetching the row
    // server-side. Comment is escaped + carried as the role hint.
    const rowAttrs = `data-id="${i.id}" data-project="${esc(i.project_id)}" data-member="${esc(i.member_id)}" data-name="${esc(name)}" data-projname="${esc(proj)}" data-comment="${esc(i.comment || '')}"`;
    return `<tr class="${reviewed ? 'int-row-reviewed' : ''}">
      <td><strong>${esc(name)}</strong></td>
      <td style="font-size:.76rem">${esc(proj)}</td>
      <td>${tag(yn ? yesLabel : noLabel, yn ? 't-g' : 't-r')}</td>
      <td>${tag(availLabel, 't-b')}</td>
      <td style="font-size:.76rem;max-width:130px">${esc(i.comment) || '—'}</td>
      <td style="font-size:.71rem;color:var(--tm)">${String(i.submitted_at || '').split('T')[0] || '—'}</td>
      <td style="white-space:nowrap">
        ${reviewed
          ? `<span class="hs-badge hs-finalapproved" style="font-size:.66rem">${esc(reviewedBadge)}</span>
             <button class="btn-icon" title="${esc(unreviewTitle)}" data-action="interestMarkReviewed" ${rowAttrs} data-reviewed="false">↺</button>`
          : `<button class="btn btn-g btn-sm" data-action="openInterestAssign" ${rowAttrs} style="font-size:.7rem;padding:.3rem .55rem">${esc(assignBtnLabel)}</button>
             <button class="btn-icon" title="${esc(reviewBtnTitle)}" data-action="interestMarkReviewed" ${rowAttrs} data-reviewed="true">✓</button>`}
      </td>
    </tr>`;
  }).join('');
}

export async function saveInterest() {
  const body = {
    project_id:        gv('int-prj-sel'),
    member_id:         gv('int-mbr-sel'),
    interested:        gv('int-yn') === 'true',
    availability_type: gv('int-av'),
    comment:           gv('int-cm'),
  };
  if (!body.project_id || !body.member_id) { toast(t('ap.int.err_required'), 'twarn'); return; }
  const r = await api('interest.submit', body);
  if (r) {
    toast(t('ap.int.success_save'));
    closeModal('interest');
    clearIntForm();
    loadInterestAll();
  }
}

export function clearIntForm() {
  ['int-prj-sel','int-mbr-sel','int-cm'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
}

// ─── Assign-from-interest workflow ──────────────────────────────────

// Stash for the assign modal — the in-flight interest row's full payload
// so confirmInterestAssign() knows what to do without re-reading the DOM.
let _activeInterest = null;

// Opens #ov-int-assign with the row's details and the project's
// opportunities loaded into the dropdown. Auto-selects the opportunity
// matching the role hint in the comment ("مهتم بدور: <role>"); if no
// match, leaves the dropdown unselected for the admin to pick.
export async function openInterestAssign(el) {
  _activeInterest = {
    id:         Number(el.dataset.id),
    project_id: el.dataset.project,
    member_id:  el.dataset.member,
    name:       el.dataset.name,
    projname:   el.dataset.projname,
    comment:    el.dataset.comment || '',
  };
  setEl('ia-member',  _activeInterest.name);
  setEl('ia-project', _activeInterest.projname);
  setEl('ia-comment', _activeInterest.comment || '—');
  // Trailing "will mark reviewed" hint carries inline <strong> markup —
  // load it via innerHTML so the tag survives. The static fallback in
  // admin.html keeps the same shape so the AR-only render before JS
  // runs still looks right.
  const hintEl = document.getElementById('ia-will-review-hint');
  if (hintEl) hintEl.innerHTML = t('ap.int.assign_will_review_hint');
  const sel = document.getElementById('ia-opp-sel');
  sel.innerHTML = `<option value="">${esc(t('ap.int.assign_opp_loading'))}</option>`;
  document.getElementById('ia-opp-note').style.display = 'none';
  openModal('int-assign');

  // Load opportunities for this project (uses the existing endpoint).
  const res = await api('opportunities.list', { project_id: _activeInterest.project_id });
  if (!res || !res.success) {
    sel.innerHTML = `<option value="">${esc(t('ap.int.assign_opp_load_failed'))}</option>`;
    return;
  }
  const opps = (res.data || []).filter(o => o.status !== 'Done' && o.status !== 'Cancelled');
  if (!opps.length) {
    sel.innerHTML = `<option value="">${esc(t('ap.int.assign_opp_none_available'))}</option>`;
    return;
  }
  sel.innerHTML = `<option value="">${esc(t('ap.int.assign_opp_pick'))}</option>` +
    opps.map(o => `<option value="${esc(o.opportunity_id)}">${esc(o.role_name)} (${o.assigned_count || 0}/${o.headcount_needed || 1})</option>`).join('');

  // Auto-select if the comment hints at a specific role. Comment format
  // from the member portal is "مهتم بدور: <role_name>" — extract the
  // tail and case-insensitive match against opportunity.role_name.
  // English-language hint variant ("interested in role:") is matched
  // too so the portal can localize the comment without breaking
  // auto-select.
  const comment = _activeInterest.comment || '';
  const hint = comment.match(/مهتم بدور:\s*(.+)/)
            || comment.match(/interested in role:\s*(.+)/i);
  if (hint) {
    const wanted = hint[1].trim();
    const match  = opps.find(o => (o.role_name || '').trim() === wanted);
    if (match) {
      sel.value = match.opportunity_id;
      document.getElementById('ia-opp-note').style.display = '';
    }
  }
}

export async function confirmInterestAssign() {
  if (!_activeInterest) return;
  const oppId = gv('ia-opp-sel');
  if (!oppId) { toast(t('ap.int.assign_err_pick_opp'), 'twarn'); return; }
  const btn = document.getElementById('ia-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('ap.int.assign_confirming_btn'); }
  try {
    const r1 = await api('assignments.add', {
      data: { opportunity_id: oppId, member_id: _activeInterest.member_id },
    });
    if (!r1 || !r1.success) {
      toast(r1?.error || t('ap.int.assign_err_fail'), 'twarn');
      return;
    }
    // Auto-mark reviewed on success — the typical case. If the
    // markReviewed call fails (network blip), the assignment still
    // landed, so we don't roll back; just surface a warning.
    const r2 = await api('interest.markReviewed', { id: _activeInterest.id, reviewed: true });
    if (!r2 || !r2.success) {
      toast(t('ap.int.assign_success_partial'), 'twarn');
    } else {
      toast(t('ap.int.assign_success_full'), 'tok');
    }
    closeModal('int-assign');
    _activeInterest = null;
    loadInterestAll();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('ap.int.assign_confirm_btn'); }
  }
}

// Standalone "mark reviewed" toggle (no assignment) — used for the per-row
// ✓ button and the ↺ unmark button on reviewed rows.
export async function interestMarkReviewed(el) {
  const id       = Number(el.dataset.id);
  const reviewed = el.dataset.reviewed === 'true';
  const r = await api('interest.markReviewed', { id, reviewed });
  if (!r || !r.success) return;
  toast(reviewed ? t('ap.int.mark_reviewed_set') : t('ap.int.mark_reviewed_clear'), 'tok');
  loadInterestAll();
}
