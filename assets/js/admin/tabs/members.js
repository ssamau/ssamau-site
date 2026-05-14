// Members tab — the main roster.
//
// RBAC scopes the rendered list (heads see their committee + themselves).
// The row template embeds inline action handlers that resolve via window.*
// to functions exposed from main.js — editMember (this file), confirmDelete
// (lib/ui.js), and viewProfile (profile.js). filterMembersByRole/Status
// re-render the filtered subset without re-fetching.
//
// Portal-invite UI (Branch 4): each row also exposes a small invite
// indicator + action button driven by the account_* fields the
// getMembers query joins from public.users:
//   - account_id NULL                              → "not invited" → 📩 button
//   - account_signup_completed_at IS NOT NULL OR
//     account_auth_user_id IS NOT NULL             → "joined" badge, no button
//   - else (pending invite, or limbo legacy row)   → "pending" badge + 🔄 resend + ❌ revoke

import { DB, ROLE_COLORS, STATUS_COLORS } from '../../lib/state.js';
import { esc, gv, sv, tag, attrJson } from '../../lib/format.js';
import {
  api, apiGet, toast, openModal, closeModal, clearForm,
  populateMemberSelects,
} from '../../lib/ui.js';
import { RBAC } from '../../lib/rbac.js';

// Module-level state for the invite modal — `openInviteModal()` writes
// this, and the per-action handlers (sendInviteByEmail / sendInviteByPin
// / copyShownPin) read it. Cleared whenever the modal closes.
let _currentInviteMember = null;

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
    // Portal-account state buttons. Three branches keyed off the
    // account_* fields joined from public.users by getMembers:
    const joined  = !!(m.account_signup_completed_at || m.account_auth_user_id);
    const pending = !joined && (m.account_signup_token_set || m.account_signup_pin_set);
    const noAccount = !m.account_id;
    let inviteBtns = '';
    if (joined) {
      // Already signed up — show a small green tag for at-a-glance status.
      inviteBtns = '<span class="t-g" style="font-size:.66rem;padding:.15rem .4rem;border-radius:6px;background:var(--gl);color:var(--g);font-weight:600" title="انضم إلى لوحة الأعضاء">✓ منضم</span>';
    } else if (pending) {
      // Invite outstanding — let admin resend (same modal) or revoke.
      inviteBtns =
        `<button class="btn-icon" data-action="openInviteModal" data-id="${m.member_id}" title="إعادة إرسال الدعوة">🔄</button>` +
        `<button class="btn-icon del" data-action="confirmRevokeInvite" data-id="${m.member_id}" data-name=${attrJson(m.full_name)} title="إلغاء الدعوة">❌</button>`;
    } else if (noAccount) {
      // Never invited — offer the first invite.
      inviteBtns = `<button class="btn-icon" data-action="openInviteModal" data-id="${m.member_id}" title="دعوة إلى لوحة الأعضاء">📩</button>`;
    }
    // else: account_id is set but no signup_* and no signup_completed_at
    //       and no auth_user_id — legacy admin account in limbo. We
    //       deliberately render nothing in the invite column; managing
    //       these is the Accounts tab's job, not Members.

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
        ${inviteBtns}
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

// ══════════════════════════════════════════
// PORTAL INVITES (Branch 4 Phase 2b)
// ══════════════════════════════════════════
// Opens the invite modal in "pick a method" state. Stashes the target
// member in a module-level variable so the chosen-method handlers can
// pick it up without re-walking the DB.members array.
export function openInviteModal(memberId) {
  const m = DB.members.find(x => x.member_id === memberId);
  if (!m) {
    toast('العضو غير موجود', 'twarn');
    return;
  }
  _currentInviteMember = m;

  // Populate the member context block at the top of the modal. The
  // fields are <div>s (display-only), not <input>s, so sv() is wrong
  // here — sv() sets el.value which is meaningless on a div. We use
  // textContent directly. Same pattern below for the PIN value and
  // email-target display fields.
  document.getElementById('invite-member-name').textContent  = m.preferred_name || m.full_name;
  document.getElementById('invite-member-email').textContent = m.email || '— لا يوجد بريد، استخدم رمز PIN —';

  // The email button is unusable if the member has no email on file —
  // disable it so the admin can't trigger a 400 from the server.
  const emailBtn  = document.getElementById('invite-email-btn');
  const emailHelp = document.getElementById('invite-email-help');
  if (m.email) {
    emailBtn.disabled = false;
    emailBtn.style.opacity = '';
    emailHelp.textContent = 'يستلم العضو رابطاً صالحاً 7 أيام لاختيار كلمة المرور بنفسه.';
  } else {
    emailBtn.disabled = true;
    emailBtn.style.opacity = '.4';
    emailHelp.textContent = '⚠️ لا يوجد بريد للعضو — استخدم PIN، أو أضف بريداً عبر "تعديل" أولاً.';
  }

  // Reset the modal to "choose method" state (the previous open might
  // have left it in "PIN result" or "email success" view).
  document.getElementById('invite-choose').style.display = '';
  document.getElementById('invite-pin-result').style.display = 'none';
  document.getElementById('invite-email-result').style.display = 'none';

  openModal('member-invite');
}

export async function sendInviteByEmail() {
  const m = _currentInviteMember;
  if (!m) return;
  const res = await api('auth.invite.byEmail', {
    member_id: m.member_id,
    redirectTo: window.location.origin + '/signup.html',
  });
  if (!res || !res.success) return;  // api() already toasted the error
  // The DB-side invite landed even if the SMTP send failed. Distinguish
  // the two so the admin isn't told "sent" when it wasn't.
  if (res.data && res.data.sent === false) {
    toast('⚠️ تم إنشاء الدعوة لكن فشل إرسال البريد. حاول مرة أخرى لاحقاً.', 'twarn');
    closeModal('member-invite');
    loadMembers();
    return;
  }
  // Toggle modal to "email sent" state.
  document.getElementById('invite-choose').style.display = 'none';
  document.getElementById('invite-email-result-target').textContent = m.email;
  document.getElementById('invite-email-result').style.display = '';
  toast('📧 تم إرسال الدعوة', 'tok');
  // Refresh the table so the row's state flips from "📩" to "🔄 ❌".
  loadMembers();
}

export async function sendInviteByPin() {
  const m = _currentInviteMember;
  if (!m) return;
  const res = await api('auth.invite.byPin', { member_id: m.member_id });
  if (!res || !res.success) return;
  // The plaintext PIN comes back in res.data.pin — we display it once.
  document.getElementById('invite-choose').style.display = 'none';
  document.getElementById('invite-pin-value').textContent = res.data.pin;
  document.getElementById('invite-pin-result').style.display = '';
  toast('🔢 تم إنشاء رمز PIN', 'tok');
  loadMembers();
}

export async function copyShownPin() {
  const pin = document.getElementById('invite-pin-value').textContent;
  try {
    await navigator.clipboard.writeText(pin);
    toast('📋 نُسخ الرمز', 'tok');
  } catch (err) {
    console.warn('[clipboard] write failed:', err);
    toast('تعذّر النسخ — انسخ الرمز يدوياً', 'twarn');
  }
}

// Two-step revoke: small confirm prompt before calling the server, so a
// stray click doesn't nuke a pending invite the admin still wants. No
// modal for this — toast-driven for speed.
export async function confirmRevokeInvite(memberId, memberName) {
  if (!confirm(`إلغاء الدعوة المعلّقة للعضو "${memberName}"؟ سيُحذف رمز التفعيل ولن يستطيع العضو إكمال التسجيل حتى تُرسل له دعوة جديدة.`)) return;
  const res = await api('auth.invite.revoke', { member_id: memberId });
  if (!res || !res.success) return;
  toast('❌ تم إلغاء الدعوة', 'tok');
  loadMembers();
}
