// Advisors tab — superadmin-only by RBAC. Plain CRUD over `advisors`.
//
// The renderer reads from DB.advisors (overwritten on every load) and writes
// the table out with inline action handlers that resolve to the editAdvisor
// and confirmDelete functions exposed on window by main.js.

import { DB, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag, attrJson } from '../../lib/format.js';
import { api, apiGet, toast, openModal, closeModal, clearForm } from '../../lib/ui.js';

// ══════════════════════════════════════════
// ADVISORS
// ══════════════════════════════════════════
export async function loadAdvisors() {
  const data = await apiGet('getAdvisors');
  if (!data || !data.success) return;
  DB.advisors = data.data || [];
  const tbody = document.getElementById('advisors-tbody');
  if (!DB.advisors.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">لا يوجد مستشارون</td></tr>';
    return;
  }
  tbody.innerHTML = DB.advisors.map(a => `<tr>
    <td><strong>${esc(a.full_name)}</strong></td>
    <td>${esc(a.advisory_role) || '—'}</td>
    <td style="direction:ltr;font-size:.78rem">${esc(a.email) || '—'}</td>
    <td style="direction:ltr;font-size:.78rem">${esc(a.phone) || '—'}</td>
    <td>${tag(a.status, STATUS_COLORS[a.status] || 't-gr')}</td>
    <td>
      <button class="btn-icon edit" onclick="editAdvisor('${a.advisor_id}')">✏️</button>
      <button class="btn-icon del" onclick="confirmDelete('advisor','${a.advisor_id}',${attrJson(a.full_name)})">🗑️</button>
    </td>
  </tr>`).join('');
}

export async function saveAdvisor() {
  const id = gv('adv-edit-id');
  const body = {
    full_name:    gv('adv-full-name'),
    advisory_role:gv('adv-role'),
    email:        gv('adv-email'),
    phone:        gv('adv-phone'),
    notes:        gv('adv-notes'),
    status:       gv('adv-status'),
  };
  if (!body.full_name) { toast('الاسم مطلوب', 'twarn'); return; }
  let res;
  if (id) res = await api('updateAdvisor', { id, data: body });
  else     res = await api('createAdvisor', body);
  if (res) { toast('✅ تم الحفظ'); closeModal('advisor'); clearForm('advisor'); loadAdvisors(); }
}

export function editAdvisor(id) {
  const a = DB.advisors.find(x => x.advisor_id === id);
  if (!a) return;
  sv('adv-edit-id', id);
  sv('adv-full-name', a.full_name); sv('adv-role', a.advisory_role);
  sv('adv-email', a.email); sv('adv-phone', a.phone);
  sv('adv-notes', a.notes); sv('adv-status', a.status);
  document.getElementById('advisor-modal-title').textContent = '✏️ تعديل المستشار';
  openModal('advisor');
}
