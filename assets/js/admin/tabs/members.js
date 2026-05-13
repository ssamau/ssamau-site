// Members tab — the main roster.
//
// RBAC scopes the rendered list (heads see their committee + themselves).
// The row template embeds inline action handlers that resolve via window.*
// to functions exposed from main.js — editMember (this file), confirmDelete
// (lib/ui.js), and viewProfile (profile.js). filterMembersByRole/Status
// re-render the filtered subset without re-fetching.

import { DB, ROLE_COLORS, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag, attrJson } from '../../lib/format.js';
import {
  api, apiGet, toast, openModal, closeModal, clearForm,
  populateMemberSelects,
} from '../../lib/ui.js';
import { RBAC } from '../../lib/rbac.js';

// ══════════════════════════════════════════
// MEMBERS
// ══════════════════════════════════════════
export async function loadMembers() {
  const data = await apiGet('getMembers');
  if (!data || !data.success) return;
  DB.members = data.data || [];
  // تطبيق فلتر الصلاحيات
  const filtered = RBAC.filterMembers(DB.members);
  renderMembers(filtered);
  populateMemberSelects();
  RBAC.injectMyTeamBadge();
}

export function renderMembers(members) {
  const tbody = document.getElementById('members-tbody');
  if (!members.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">لا يوجد أعضاء</td></tr>';
    return;
  }
  tbody.innerHTML = members.map(m => {
    const com = DB.committees.find(c => c.committee_id === m.committee_id);
    const nid = m.national_id
      ? `<span dir="ltr" style="font-family:Menlo,Consolas,monospace;font-size:.78rem">${esc(m.national_id)}</span>`
      : '<span style="color:var(--tm)">—</span>';
    // Contact cell — stacks email + 📱 phone + 💬 whatsapp so admins see every
    // way to reach a member without opening the edit modal. Phone and WhatsApp
    // are intentionally separate (some members use a Saudi number for WhatsApp
    // and an Australian number for calls — or vice versa).
    const contactLines = [];
    if (m.email)    contactLines.push(`<div style="direction:ltr;text-align:left">${esc(m.email)}</div>`);
    if (m.phone)    contactLines.push(`<div style="direction:ltr;text-align:left;font-size:.74rem;color:var(--tm)">📱 ${esc(m.phone)}</div>`);
    if (m.whatsapp) contactLines.push(`<div style="direction:ltr;text-align:left;font-size:.74rem;color:var(--tm)">💬 ${esc(m.whatsapp)}</div>`);
    const contact = contactLines.length
      ? contactLines.join('')
      : '<span style="color:var(--tm)">—</span>';
    return `<tr>
      <td>
        <div style="font-weight:700">${esc(m.preferred_name || m.full_name)}</div>
        <div style="font-size:.72rem;color:var(--tm)">${esc(m.full_name)}</div>
      </td>
      <td>${nid}</td>
      <td style="font-size:.78rem">${contact}</td>
      <td>${tag(m.club_role, ROLE_COLORS[m.club_role] || 't-gr')}</td>
      <td>${com ? tag(com.committee_name, 't-b') : '<span style="color:var(--tm)">—</span>'}</td>
      <td><strong style="color:var(--g)">${m.total_hours || 0}</strong></td>
      <td>${tag(m.status, STATUS_COLORS[m.status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" data-action="editMember" data-id="${m.member_id}" title="تعديل">✏️</button>
        <button class="btn-icon del" data-action="confirmDelete" data-type="member" data-id="${m.member_id}" data-name=${attrJson(m.full_name)} title="حذف">🗑️</button>
        <button class="btn-icon" data-action="viewProfile" data-id="${m.member_id}" title="ملف العضو">👤</button>
      </td>
    </tr>`;
  }).join('');
}

export function filterMembersByRole(role) {
  const filtered = role ? DB.members.filter(m => m.club_role === role) : DB.members;
  renderMembers(filtered);
}
export function filterMembersByStatus(status) {
  const filtered = status ? DB.members.filter(m => m.status === status) : DB.members;
  renderMembers(filtered);
}

export async function saveMember() {
  const id = gv('m-edit-id');
  const body = {
    full_name:        gv('m-full-name'),
    preferred_name:   gv('m-preferred-name'),
    national_id:      gv('m-national-id'),
    email:            gv('m-email'),
    phone:            gv('m-phone'),
    whatsapp:         gv('m-whatsapp'),
    date_of_birth:    gv('m-dob'),
    gender:           gv('m-gender'),
    profile_photo_url:gv('m-photo'),
    committee_id:     gv('m-committee-id'),
    club_role:        gv('m-club-role'),
    status:           gv('m-status'),
    join_date:        gv('m-join-date'),
  };
  if (!body.full_name || !body.email || !body.club_role) {
    toast('الحقول المطلوبة: الاسم، البريد، الدور', 'twarn'); return;
  }
  let res;
  if (id) {
    res = await api('updateMember', { id, data: body });
  } else {
    res = await api('createMember', body);
  }
  if (res) {
    toast(id ? '✅ تم تعديل العضو' : '✅ تم إضافة العضو');
    closeModal('member'); clearForm('member');
    loadMembers();
  }
}

export function editMember(id) {
  const m = DB.members.find(x => x.member_id === id);
  if (!m) return;
  sv('m-edit-id', id);
  sv('m-full-name', m.full_name);
  sv('m-preferred-name', m.preferred_name);
  sv('m-national-id', m.national_id || '');
  sv('m-email', m.email);
  sv('m-phone', m.phone);
  sv('m-whatsapp', m.whatsapp || '');
  sv('m-dob', m.date_of_birth ? String(m.date_of_birth).slice(0, 10) : '');
  sv('m-gender', m.gender);
  sv('m-photo', m.profile_photo_url);
  sv('m-committee-id', m.committee_id);
  sv('m-club-role', m.club_role);
  sv('m-status', m.status);
  sv('m-join-date', m.join_date ? String(m.join_date).slice(0, 10) : '');
  document.getElementById('member-modal-title').textContent = '✏️ تعديل العضو';
  openModal('member');
}
