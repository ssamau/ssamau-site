// Committees tab.
//
// Render reads from DB.committees (refreshed via loadCommittees), and joins
// against DB.members for head/vice-head + per-committee member counts.
//
// RBAC quirk preserved verbatim: filterCommittees() returns only the head's
// own committee, but the render loop iterates DB.committees (unfiltered). The
// `comToRender` local is built but never used — same as the original. Keeping
// the dead variable so the diff is mechanically faithful.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag, attrJson } from '../../lib/format.js';
import { api, apiGet, toast, openModal, closeModal, clearForm } from '../../lib/ui.js';
import { RBAC } from '../../lib/rbac.js';

// ══════════════════════════════════════════
// COMMITTEES
// ══════════════════════════════════════════
export async function loadCommittees() {
  const data = await apiGet('getCommittees');
  if (!data || !data.success) return;
  DB.committees = data.data || [];
  // فلتر: رئيس اللجنة يشوف لجنته فقط
  const comToRender = RBAC.filterCommittees(DB.committees);
  const tbody = document.getElementById('committees-tbody');
  if (!DB.committees.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">لا توجد لجان</td></tr>';
    return;
  }
  tbody.innerHTML = DB.committees.map(c => {
    const head   = DB.members.find(m => m.member_id === c.committee_head_member_id);
    const vice   = DB.members.find(m => m.member_id === c.committee_vice_head_member_id);
    const count  = DB.members.filter(m => m.committee_id === c.committee_id).length;
    return `<tr>
      <td><strong>${esc(c.committee_name)}</strong></td>
      <td>${head ? esc(head.preferred_name || head.full_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td>${vice ? esc(vice.preferred_name || vice.full_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td><span class="tag t-b">${count} عضو</span></td>
      <td>${tag(c.status, STATUS_COLORS[c.status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" data-action="editCommittee" data-id="${c.committee_id}">✏️</button>
        <button class="btn-icon del" data-action="confirmDelete" data-type="committee" data-id="${c.committee_id}" data-name=${attrJson(c.committee_name)}>🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

export async function saveCommittee() {
  const id = gv('com-edit-id');
  const body = {
    committee_name:               gv('com-name'),
    committee_description:        gv('com-desc'),
    committee_head_member_id:     gv('com-head'),
    committee_vice_head_member_id:gv('com-vice'),
    status:                       gv('com-status'),
  };
  if (!body.committee_name) { toast('اسم اللجنة مطلوب', 'twarn'); return; }
  let res;
  if (id) res = await api('updateCommittee', { id, data: body });
  else     res = await api('createCommittee', body);
  if (res) { toast('✅ تم الحفظ'); closeModal('committee'); clearForm('committee'); loadCommittees(); }
}

export function editCommittee(id) {
  const c = DB.committees.find(x => x.committee_id === id);
  if (!c) return;
  sv('com-edit-id', id);
  sv('com-name', c.committee_name); sv('com-desc', c.committee_description);
  sv('com-head', c.committee_head_member_id);
  sv('com-vice', c.committee_vice_head_member_id);
  sv('com-status', c.status);
  document.getElementById('committee-modal-title').textContent = '✏️ تعديل اللجنة';
  openModal('committee');
}
