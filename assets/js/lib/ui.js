// Cross-tab UI plumbing shared by every per-tab module.
//
// Lives in lib/ so tabs don't import from main.js (which would create cycles
// — main.js imports every tab). Three groups:
//
//   1. `api` / `apiGet` — thin wrappers around lib/api.js's callApi that also
//      surface server-side errors via the toast + the connection-status pill.
//   2. Toast + connection-status pill + modal open/close — UI primitives.
//   3. Select-population helpers + clearForm + refreshData + confirmDelete —
//      generic page/modal helpers used from many tabs.
//
// Behaviour is identical to the previous in-file copies — this module is a
// pure structural relocation; no logic was changed during the split.

import { callApi as _callApi } from './api.js';
import { DB } from './state.js';
import { esc, gv, sv } from './format.js';

// Drop-in for the original local callApi — same signature, same envelope
// flattening (lib/api.js does it). Keeps every call site below unchanged.
export async function callApi(action, params = {}) { return _callApi(action, params); }

// ══════════════════════════════════════════
// API
// ══════════════════════════════════════════
export async function api(action, body = {}) {
  try {
    const data = await callApi(action, body);
    if (data && !data.success && data.error) throw new Error(data.error);
    return data;
  } catch (err) {
    toast('خطأ في الاتصال: ' + err.message, 'terr');
    setApiStatus('err', err.message);
    return null;
  }
}

export async function apiGet(action, params = {}) {
  try {
    return await callApi(action, params);
  } catch (err) {
    toast('خطأ: ' + err.message, 'terr');
    return null;
  }
}

// ══════════════════════════════════════════
// TOAST + STATUS PILL
// ══════════════════════════════════════════
let _toastTimer;
export function toast(msg, cls = 'tok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + cls;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.className = '', 3200);
}

export function setApiStatus(state, text) {
  const el = document.getElementById('api-status');
  const tx = document.getElementById('api-status-text');
  el.className = 'api-status ' + state;
  tx.textContent = text;
}

// ══════════════════════════════════════════
// MODALS
// ══════════════════════════════════════════
// Modal open populates whichever selects + date defaults the form needs.
// The per-tab populate hooks (populateHrsOpportunitySelect, populateRolePresets)
// are passed in via setModalHooks() at init time so this module doesn't have
// to know about hours/opportunities specifically.
let _populateHrsOpportunitySelect = () => {};
let _populateRolePresets          = () => {};
export function setModalHooks({ populateHrsOpportunitySelect, populateRolePresets }) {
  if (populateHrsOpportunitySelect) _populateHrsOpportunitySelect = populateHrsOpportunitySelect;
  if (populateRolePresets)          _populateRolePresets          = populateRolePresets;
}

export function openModal(type) {
  document.getElementById('ov-' + type).classList.add('open');
  // Pre-populate selects. `bulk-att` added — the modal's project
  // picker (batt-prj) needs to be refreshed when the modal opens so
  // that newly-created projects appear without a full page reload.
  if (['member','participant','project','attendance','hours','opportunity','bulk-att'].includes(type)) {
    populateMemberSelects();
    populateProjectSelects();
    populateCommitteeSelects();
  }
  if (type === 'committee') populateMemberSelects();
  if (type === 'opportunity') _populateRolePresets();
  if (type === 'hours') { _populateHrsOpportunitySelect(); populateAdvisorSelects(); }
  // Set today's date defaults
  if (type === 'attendance') sv('att-date', new Date().toISOString().split('T')[0]);
  if (type === 'member' && !gv('m-join-date')) sv('m-join-date', new Date().toISOString().split('T')[0]);
}
export function closeModal(type) {
  document.getElementById('ov-' + type).classList.remove('open');
}

// ══════════════════════════════════════════
// SELECT POPULATORS
// ══════════════════════════════════════════
// populateMemberSelects fills every <select> that wants a "pick a member"
// dropdown. populateProfileSelect is a member-picker on the profile page —
// kept here (rather than in tabs/profile.js) because populateMemberSelects
// needs to call it without importing profile.js, which would create a cycle
// (profile.js → ui.js → profile.js).
export function populateProfileSelect() {
  const sel = document.getElementById('profile-member-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">اختر عضواً</option>' +
    DB.members.map(m => `<option value="${m.member_id}">${esc(m.preferred_name || m.full_name)}</option>`).join('');
}

export function populateMemberSelects() {
  const options = DB.members.map(m =>
    `<option value="${m.member_id}">${esc(m.preferred_name || m.full_name)}</option>`
  ).join('');

  ['com-head','com-vice','prj-created-by','prj-manager','prj-event-mgr',
   'par-member','att-member','att-checker','hrs-member','hrs-recorder'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const hasEmpty = id.includes('head') || id.includes('vice') || id.includes('manager') || id.includes('event-mgr') || id.includes('checker') || id.includes('recorder');
      el.innerHTML = (hasEmpty ? '<option value="">— اختر —</option>' : '') + options;
    }
  });
  populateProfileSelect();
}

export function populateProjectSelects() {
  const options = DB.projects.map(p =>
    `<option value="${p.project_id}">${esc(p.project_name)}</option>`
  ).join('');
  // batt-prj = bulk attendance modal's project picker. Missing it
  // here was why the modal opened with empty options — flagged as the
  // "group attendance doesn't show projects" bug.
  ['participants-project-filter','attendance-project-filter','hours-project-filter',
   'opportunities-project-filter',
   'par-project','att-project','hrs-project','opp-project',
   'batt-prj'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const prev = el.value;
      const isFilter = id.includes('filter');
      el.innerHTML = (isFilter ? '<option value="">كل المشاريع</option>' : '<option value="">— اختر —</option>') + options;
      if (prev) el.value = prev;
    }
  });
}

export function populateCommitteeSelects() {
  // Per-select placeholder: member rows can legitimately have no
  // committee, but for an opportunity an empty value means "open to
  // every committee" (broadcast). President flagged on 2026-05-15 that
  // the "— بدون لجنة —" wording was confusing for opportunities — he
  // expected an explicit "all committees" choice.
  const PLACEHOLDERS = {
    'm-committee-id': '— بدون لجنة —',
    'opp-committee':  '🌍 كل اللجان (للجميع)',
  };
  const committeeOpts = DB.committees
    .map(c => `<option value="${c.committee_id}">${esc(c.committee_name)}</option>`)
    .join('');
  for (const [id, placeholder] of Object.entries(PLACEHOLDERS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const prev = el.value;
    el.innerHTML = `<option value="">${placeholder}</option>${committeeOpts}`;
    if (prev) el.value = prev;
  }
}

// Phase D — populate advisor pickers from DB.advisors. Only one site
// today (hours modal); kept as its own helper so future admin tabs
// that need an advisor picker can call it without duplicating the
// option-building loop.
export function populateAdvisorSelects() {
  const opts = '<option value="">— اختر —</option>' +
    (DB.advisors || [])
      .filter(a => a.status === 'Active')
      .map(a => `<option value="${a.id}">${esc(a.full_name)}</option>`)
      .join('');
  ['hrs-advisor'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const prev = el.value; el.innerHTML = opts; if (prev) el.value = prev; }
  });
}

// ── populateNewSelects: للصفحات الجديدة ─────────────────────
export function populateNewSelects() {
  const mOpts = DB.members.map(m =>
    `<option value="${m.member_id}">${esc(m.preferred_name || m.full_name)}</option>`
  ).join('');
  const pOpts = DB.projects.map(p =>
    `<option value="${p.project_id}">${esc(p.project_name)}</option>`
  ).join('');

  // Project selects
  ['flt-thx-prj','flt-cert-prj','flt-int-prj','batt-prj',
   'thx-prj','bthx-prj','bcert-prj','int-prj-sel','cert-proj-sel'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    const blank = id.startsWith('flt') ? '<option value="">كل المشاريع</option>' : '<option value="">— اختر —</option>';
    el.innerHTML = blank + pOpts;
  });
  // Member selects
  ['thx-mbr','int-mbr-sel','cert-mbr-sel'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.innerHTML = '<option value="">— اختر —</option>' + mOpts;
  });
}

// ══════════════════════════════════════════
// FORM CLEAR (per modal type)
// ══════════════════════════════════════════
export function clearForm(type) {
  const fields = {
    member:      ['m-edit-id','m-full-name','m-preferred-name','m-email','m-phone','m-photo','m-join-date'],
    advisor:     ['adv-edit-id','adv-full-name','adv-role','adv-email','adv-phone','adv-notes'],
    committee:   ['com-edit-id','com-name','com-desc'],
    project:     ['prj-edit-id','prj-name','prj-desc','prj-date','prj-start','prj-end','prj-location','prj-proposal','prj-notes'],
    participant: ['par-vol-name','par-vol-email','par-vol-phone','par-notes'],
    attendance:  ['att-vol-email','att-notes'],
    hours:       ['hrs-vol-email','hrs-notes'],
    opportunity: ['opp-edit-id','opp-role-name','opp-notes'],
  };
  (fields[type] || []).forEach(id => sv(id, ''));
  // Reset number inputs
  ['hrs-before','hrs-during','hrs-after'].forEach(id => sv(id, '0'));
  if (type === 'hours') document.getElementById('hrs-total').textContent = '0';
  if (type === 'participant') document.getElementById('par-outstanding').checked = false;
  if (type === 'opportunity') {
    const notify = document.getElementById('opp-notify-after-save');
    if (notify) notify.checked = false;
  }
  // Reset modal titles
  const titles = {
    member: '➕ إضافة عضو', advisor: '➕ إضافة مستشار',
    committee: '➕ إضافة لجنة', project: '➕ إضافة مشروع / فعالية',
  };
  if (titles[type]) {
    const el = document.getElementById(type + '-modal-title');
    if (el) el.textContent = titles[type];
  }
}

// ══════════════════════════════════════════
// REFRESH-CURRENT-PAGE
// ══════════════════════════════════════════
// `refreshData` re-runs the current page's loader on the active page.
// Two cross-module dependencies are injected at init time to avoid an
// import cycle (router.js → tabs → ui.js):
//   - showPage from admin/router.js
//   - loaderMap from main.js — the same {dashboard: loadDashboard, ...}
//     dispatch table that router.js receives via setLoaders, mirrored
//     here so we can await the loader's promise directly and pair the
//     button-spin animation with the actual fetch lifetime.
//
// Visual feedback (added to fix a "did I click it?" UX bug):
//   - 🔄 icon spins while fetching (via the .refreshing CSS class on
//     the button + .refresh-icon span inside it)
//   - button is disabled so a panicky double-tap can't fire two
//     parallel API calls
//   - toast pops at the end: ✅ success or ❌ + error message
let _showPage = () => {};
let _loaderMap = {};
export function setRouter({ showPage }) { if (showPage) _showPage = showPage; }
export function setRefreshLoaders(loaders) { _loaderMap = loaders || {}; }

export async function refreshData() {
  const active = document.querySelector('.page.active');
  if (!active) return;
  const page = active.id.replace('page-', '');
  const btn = document.getElementById('refresh-btn');

  btn?.classList.add('refreshing');
  if (btn) btn.disabled = true;

  try {
    // Awaiting the loader directly (rather than _showPage which is
    // sync) gives us a real promise to pair with the spinner. The
    // loaderMap is the same one the router uses, injected by main.js
    // — see setRefreshLoaders below.
    const loader = _loaderMap[page];
    if (loader) await loader();
    toast('✅ تم التحديث');
  } catch (e) {
    toast('فشل التحديث: ' + (e?.message || 'unknown'), 'terr');
  } finally {
    btn?.classList.remove('refreshing');
    if (btn) btn.disabled = false;
  }
}

// ══════════════════════════════════════════
// DELETE (generic confirm-and-call)
// ══════════════════════════════════════════
export function confirmDelete(type, id, name) {
  document.getElementById('confirm-msg').textContent = `هل تريد حذف "${name}"؟ لا يمكن التراجع.`;
  document.getElementById('confirm-btn').onclick = async () => {
    const actionMap = {
      member: 'deleteMember', advisor: 'deleteAdvisor', committee: 'deleteCommittee',
      project: 'deleteProject', participant: 'removeParticipant',
      attendance: 'updateAttendance', hours: 'updateHours',
    };
    const deleteActions = {
      member: () => api('deleteMember', { id }),
      advisor: () => api('deleteAdvisor', { id }),
      committee: () => api('deleteCommittee', { id }),
      project: () => api('deleteProject', { id }),
      participant: () => api('removeParticipant', { id }),
      attendance: () => api('updateAttendance', { id, data: { attendance_status: 'Deleted' } }),
      hours: () => api('updateHours', { id, data: { notes: 'Deleted' } }),
    };
    const fn = deleteActions[type];
    if (!fn) return;
    const res = await fn();
    if (res) {
      toast('🗑️ تم الحذف');
      closeModal('confirm');
      refreshData();
    }
  };
  openModal('confirm');
}

// ══════════════════════════════════════════
// MISC GENERIC HELPERS
// ══════════════════════════════════════════
export function filterTable(tbodyId, q) {
  document.getElementById(tbodyId).querySelectorAll('tr:not(.empty-row)').forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  });
}

// ══════════════════════════════════════════
// MOBILE TABLE-TO-CARD AUTO-LABELLER
// ══════════════════════════════════════════
// At <640px wide the admin tables collapse to a card stack (see the
// @media block at the bottom of assets/css/admin.css). The CSS uses
// `content: attr(data-label)` to render each cell's column header as
// a label above its value. This function walks every .table-wrap
// table, reads <thead><th> text, and stamps it onto each <tbody><td>
// as data-label — without modifying any of the renderXxxRow() string
// builders in tabs/*.js.
//
// Runs on DOM-ready + via a MutationObserver so dynamically-
// rendered tables (every API load) get re-labelled automatically.
// Cells with a `colspan` (e.g. the "loading…" empty-row) are
// skipped so they don't get a misleading label.
export function applyTableLabels(root = document) {
  root.querySelectorAll('.table-wrap table').forEach(table => {
    const headers = Array.from(table.querySelectorAll('thead th'))
      .map(th => th.textContent.trim());
    if (!headers.length) return;
    table.querySelectorAll('tbody tr').forEach(tr => {
      Array.from(tr.children).forEach((td, i) => {
        if (td.hasAttribute('colspan')) return;
        if (headers[i]) td.setAttribute('data-label', headers[i]);
      });
    });
  });
}
const _tableLabelObserver = new MutationObserver(() => applyTableLabels());
export function watchTableLabels() {
  applyTableLabels();
  // Observe every tbody for changes; renderXxxRow functions generally
  // do one big tbody.innerHTML swap per load, so we fire once per
  // render not once per row.
  document.querySelectorAll('.table-wrap table tbody').forEach(tbody => {
    _tableLabelObserver.observe(tbody, { childList: true, subtree: false });
  });
}
