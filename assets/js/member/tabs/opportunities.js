// Opportunities tab — member portal (Phase 5c of Branch 4).
//
// Browses open opportunities the member can sign up for. Client-side
// filters the full list returned by `opportunities.list` to:
//   - status === 'Open' (no point showing Filled/Done/Cancelled to a
//     member who'd be wasting time clicking interested)
//   - owning_committee_id === member's committee  OR  IS NULL (the
//     "open to all" case). Members from other committees never see
//     opportunities they couldn't help with anyway.
//
// "Express interest" submits via `interest.submit`, which is per-PROJECT
// (the interest_requests table is keyed by project_id + member_id, not
// opportunity). So a member tapping interested on a specific role gets
// recorded as interested in the parent event; the head reviewing
// interest then assigns them to the right opportunity. We pass the
// opportunity role_name as the comment so the head knows which role
// caught the member's eye.

import { api } from '../../lib/ui.js';
import { esc, fmtDate } from '../../lib/format.js';
import { getSession } from '../../lib/auth.js';

// Cache of project_ids the member has already expressed interest in.
// We don't fetch the interest_requests table separately — we infer from
// "did the user click the button this session" because the listAll
// action is admin-only. Reloading the tab re-enables the button; the
// server's upsert (ON CONFLICT) makes a re-submit a no-op. The pill on
// the row stays sticky for the rest of the session.
const _interestedProjects = new Set();

export async function loadOpportunities() {
  const tbody = document.getElementById('opps-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">جاري التحميل...</td></tr>';

  const res = await api('opportunities.list');
  if (!res || !res.success) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6" style="color:var(--dn)">تعذّر التحميل</td></tr>';
    return;
  }
  const all = res.data || [];
  const session = getSession();
  const myCom = session?.committee_id || null;

  const rows = all.filter(o => {
    if (o.status !== 'Open') return false;
    // Own committee OR open-to-all (null committee = available to any member)
    return !o.owning_committee_id || o.owning_committee_id === myCom;
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6" style="color:var(--tm)">لا توجد فرص مفتوحة حالياً تناسبك</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(o => {
    const expressed = _interestedProjects.has(o.project_id);
    return `
      <tr>
        <td><strong>${esc(o.role_name) || '—'}</strong></td>
        <td>${esc(o.project_name) || '—'}</td>
        <td>${esc(o.owning_committee_name) || '<span style="color:var(--tm)">للجميع</span>'}</td>
        <td>${fmtDate(o.event_date) || '—'}</td>
        <td>${o.estimated_hours || 0} ساعة</td>
        <td>
          <button class="btn btn-g btn-sm btn-interest ${expressed ? 'expressed' : ''}"
                  data-action="expressInterest"
                  data-opportunity="${esc(o.opportunity_id)}"
                  data-project="${esc(o.project_id)}"
                  data-label="${esc(o.role_name)}"
                  ${expressed ? 'disabled' : ''}>
            ${expressed ? '✓ مُسجّل' : '🙋 اهتمام'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// data-action="expressInterest" wiring. main.js's handler extracts
// opportunity_id (we pass project + label through the dataset on the
// button element itself so we have everything we need without a second
// fetch). Submits to interest.submit and updates the per-session cache.
export async function expressInterest(_opportunityId, _label, el) {
  // The caller in main.js passes (opportunity_id, label) but the row's
  // dataset also holds project_id which we need for interest.submit.
  // Re-resolve from the clicked button instead of plumbing it through
  // a third arg — keeps the dispatcher map signature stable.
  // (main.js passes el as the third argument-equivalent via lookup.)
  const btn = el || document.querySelector(`button[data-opportunity="${_opportunityId}"]`);
  if (!btn) return;
  const projectId = btn.dataset.project;
  const label     = btn.dataset.label || _label || '';
  const session = getSession();
  if (!session?.member_id) {
    const { toast } = await import('../../lib/ui.js');
    toast('يجب تسجيل الدخول كعضو لإبداء الاهتمام.', 'twarn');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'جاري التسجيل...';
  try {
    const res = await api('interest.submit', {
      data: {
        project_id: projectId,
        member_id:  session.member_id,
        interested: true,
        comment:    `مهتم بدور: ${label}`,
      },
    });
    const { toast } = await import('../../lib/ui.js');
    if (!res || !res.success) {
      toast(res?.error || 'فشل تسجيل الاهتمام.', 'twarn');
      btn.disabled = false;
      btn.textContent = '🙋 اهتمام';
      return;
    }
    _interestedProjects.add(projectId);
    toast('تم تسجيل اهتمامك. سيتواصل معك رئيس اللجنة.', 'tok');
    btn.classList.add('expressed');
    btn.textContent = '✓ مُسجّل';
  } catch (err) {
    console.error('[expressInterest]', err);
    btn.disabled = false;
    btn.textContent = '🙋 اهتمام';
  }
}
