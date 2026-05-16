// Head's "أعضاء اللجنة" tab — committee roster with admin-like
// affordances scoped to the head's own committee.
//
// What heads can do here:
//   - See each member's contact channels (email / phone / WhatsApp)
//     stacked + LTR'd so the dialer can be tapped on mobile.
//   - View a member's profile + uploaded CV/photo (read-only modal).
//   - Send a portal invite (email link or 6-digit PIN) using the
//     same auth.invite.* endpoints admin uses — server already accepts
//     "head OR superadmin" with a committee_id check.
//
// What heads can NOT do (deliberately):
//   - Edit member details (admin-only — heads can't change roles,
//     committees, or status).
//   - Delete members.
//   - See national_id (privacy — heads see the same data any teammate
//     would see, except the contact channels).

import { esc, fmtDate, tag, attrJson } from '../../lib/format.js';
import { api, apiGet, toast, openModal, closeModal } from '../../lib/ui.js';
import { t, getLang } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Module-level state.
// _members      — full unscoped getMembers payload (we filter on render
//                 so language toggles can re-render without refetching).
// _currentInvite — the member object the invite modal is currently
//                  operating on. Cleared when the modal closes.
let _members = [];
let _currentInvite = null;

const CLUB_ROLE_KEY = {
  'President':           'hp.role.president_full',
  'Vice President':      'hp.role.vice_president',
  'Committee Head':      'hp.role.committee_head',
  'Committee Vice Head': 'hp.role.committee_vice_head',
  'Deputy Vice Head':    'hp.role.deputy_vice_head',
  'Project Manager':     'ap.role.project_manager',
  'Event Manager':       'ap.role.event_manager',
  'Member':              'hp.role.member',
  'Volunteer':           'ap.role.volunteer',
};
const ROLE_COLOR = {
  'Committee Head':      't-g',
  'Committee Vice Head': 't-g',
  'Deputy Vice Head':    't-b',
  'Member':              't-gr',
  'Volunteer':           't-gr',
};
const STATUS_COLOR = { Active: 't-g', Inactive: 't-gr' };


// ════════════════════════════════════════════
// LOAD
// ════════════════════════════════════════════
export async function loadHeadMembers() {
  const res = await apiGet('getMembers');
  const tbody = document.getElementById('hd-members-tbody');
  if (!tbody) return;
  if (!res || !res.success) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.members.err_load'))}</td></tr>`;
    return;
  }
  _members = res.data || [];
  _renderMembers();
}

function _scopedMembers() {
  const myCommittee = window.CURRENT_USER?.committee_id;
  return _members
    .filter(m => m.status !== 'Inactive')
    .filter(m => myCommittee ? m.committee_id === myCommittee : true);
}

function _renderMembers() {
  const tbody = document.getElementById('hd-members-tbody');
  if (!tbody) return;
  const members = _scopedMembers();
  if (!members.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${esc(t('hp.members.empty'))}</td></tr>`;
    return;
  }
  // Sort: leadership first, then by name in the active language so
  // English/Arabic interleave correctly when the user toggles.
  const sortLang = getLang() === 'en' ? 'en' : 'ar';
  members.sort((a, b) => {
    const rank = r => ({
      'Committee Head': 0,
      'Committee Vice Head': 1,
      'Deputy Vice Head': 2,
      'Member': 3,
    }[r] ?? 4);
    const ra = rank(a.club_role), rb = rank(b.club_role);
    return ra !== rb ? ra - rb : (a.full_name || '').localeCompare(b.full_name || '', sortLang);
  });
  tbody.innerHTML = members.map(_renderRow).join('');
}

function _renderRow(m) {
  // Contact cell — email / 📱 phone / 💬 whatsapp stacked + LTR'd so
  // phone numbers render correctly inside an RTL row. Mirrors admin's
  // contact-cell layout exactly so the mobile mental model is the same.
  const contactLines = [];
  if (m.email)    contactLines.push(`<div style="direction:ltr;text-align:left">${esc(m.email)}</div>`);
  if (m.phone)    contactLines.push(`<div style="direction:ltr;text-align:left;font-size:.74rem;color:var(--tm)">📱 ${esc(m.phone)}</div>`);
  if (m.whatsapp) contactLines.push(`<div style="direction:ltr;text-align:left;font-size:.74rem;color:var(--tm)">💬 ${esc(m.whatsapp)}</div>`);
  const contact = contactLines.length
    ? contactLines.join('')
    : '<span style="color:var(--tm)">—</span>';

  // Per-row file indicators — same pattern as admin. Click fetches a
  // 1h signed URL via storage.getMemberFile (heads are scope-checked
  // server-side) and opens it in a new tab.
  const fileIcons = [
    m.profile_photo_url ? `<button class="btn-icon" data-action="hd.members.openFile" data-id="${esc(m.member_id)}" data-kind="photo" title="${esc(t('hp.members.row_photo'))}">🖼</button>` : '',
    m.cv_url            ? `<button class="btn-icon" data-action="hd.members.openFile" data-id="${esc(m.member_id)}" data-kind="cv"    title="${esc(t('hp.members.row_cv'))}">📄</button>` : '',
  ].filter(Boolean).join('');

  // Portal-invite state — three branches keyed off account_* joins.
  const joined  = !!(m.account_signup_completed_at || m.account_auth_user_id);
  const pending = !joined && (m.account_signup_token_set || m.account_signup_pin_set);
  const noAccount = !m.account_id;
  let inviteBtns = '';
  if (joined) {
    inviteBtns = `<span class="t-g" style="font-size:.66rem;padding:.15rem .4rem;border-radius:6px;background:var(--gl);color:var(--g);font-weight:600" title="${esc(t('hp.invite.joined_title'))}">${esc(t('hp.invite.joined_tag'))}</span>`;
  } else if (pending) {
    inviteBtns =
      `<button class="btn-icon" data-action="hd.members.invite.open"   data-id="${m.member_id}" title="${esc(t('hp.invite.resend_title'))}">🔄</button>` +
      `<button class="btn-icon del" data-action="hd.members.invite.revoke" data-id="${m.member_id}" data-name=${attrJson(m.full_name)} title="${esc(t('hp.invite.revoke_title'))}">❌</button>`;
  } else if (noAccount) {
    inviteBtns = `<button class="btn-icon" data-action="hd.members.invite.open" data-id="${m.member_id}" title="${esc(t('hp.invite.first_title'))}">📩</button>`;
  }
  // else: account in limbo (no signup, no auth) — render nothing.
  // Admin's Accounts tab is the canonical place to fix these rows.

  const roleLabel   = CLUB_ROLE_KEY[m.club_role] ? t(CLUB_ROLE_KEY[m.club_role]) : (m.club_role || '—');
  const statusLabel = m.status === 'Active'
    ? t('hp.members.status_active')
    : (m.status || '—');

  return `<tr>
    <td>
      <div style="font-weight:700;display:flex;align-items:center;gap:.3rem;flex-wrap:wrap">
        ${esc(m.preferred_name || m.full_name)}
        ${fileIcons}
      </div>
      <div style="font-size:.72rem;color:var(--tm)">${esc(m.full_name)}</div>
    </td>
    <td style="font-size:.78rem">${contact}</td>
    <td>${tag(roleLabel, ROLE_COLOR[m.club_role] || 't-gr')}</td>
    <td><strong style="color:var(--g)">${m.total_hours || 0}</strong></td>
    <td>${tag(statusLabel, STATUS_COLOR[m.status] || 't-gr')}</td>
    <td>
      <button class="btn-icon" data-action="hd.members.viewProfile" data-id="${m.member_id}" title="${esc(t('hp.members.row_view'))}">👤</button>
      ${inviteBtns}
    </td>
  </tr>`;
}


// ════════════════════════════════════════════
// FILE VIEWER (CV / photo)
// ════════════════════════════════════════════
export async function openHeadMemberFile(memberId, kind) {
  const res = await api('storage.getMemberFile', { data: { member_id: memberId, kind } });
  if (!res || !res.success || !res.data?.url) {
    const friendly = res?.data?.missing
      ? t('hp.members.file_missing')
      : (localizeError(res?.error, res?.errorParams) || t('hp.members.file_failed'));
    toast(friendly, 'twarn');
    return;
  }
  window.open(res.data.url, '_blank', 'noopener');
}


// ════════════════════════════════════════════
// PROFILE MODAL
// ════════════════════════════════════════════
export async function openHeadMemberProfile(memberId) {
  const m = _members.find(x => x.member_id === memberId);
  if (!m) return;

  // Open modal early in "loading" state so the user sees something
  // while we fetch hours. The body is rewritten when the data lands.
  const body = document.getElementById('hd-prof-content');
  if (body) {
    body.innerHTML = `<div style="text-align:center;color:var(--tm);padding:2rem">${esc(t('common.loading'))}</div>`;
  }
  openModal('hd-profile');

  const hoursRes = await api('getMemberHours', { member_id: memberId });
  const hours = hoursRes?.data || [];
  const totalHours = hours.reduce((s, h) => s + (parseFloat(h.total_hours) || 0), 0);
  const projectsCount = new Set(hours.map(h => h.project_id)).size;

  const roleLabel   = CLUB_ROLE_KEY[m.club_role] ? t(CLUB_ROLE_KEY[m.club_role]) : (m.club_role || '');
  const statusLabel = m.status === 'Active' ? t('hp.members.status_active') : (m.status || '—');

  if (!body) return;
  body.innerHTML = `
    <div class="profile-hero">
      <div class="profile-avatar">${esc((m.preferred_name || m.full_name || '?').charAt(0))}</div>
      <div>
        <div class="profile-name">${esc(m.preferred_name || m.full_name)}</div>
        <div style="font-size:.78rem;color:rgba(255,255,255,.7);margin-top:.15rem">${esc(m.full_name)}</div>
        <div class="profile-role">${esc(roleLabel)}</div>
        ${m.email ? `<div style="font-size:.72rem;color:rgba(255,255,255,.5);direction:ltr;margin-top:.2rem">${esc(m.email)}</div>` : ''}
      </div>
    </div>
    <div class="profile-stats">
      <div class="profile-stat"><div class="pn">${totalHours.toFixed(1)}</div><div class="pl">${esc(t('hp.members.stat_hours'))}</div></div>
      <div class="profile-stat"><div class="pn">${projectsCount}</div><div class="pl">${esc(t('hp.members.stat_projects'))}</div></div>
      <div class="profile-stat"><div class="pn">${tag(statusLabel, STATUS_COLOR[m.status] || 't-gr')}</div><div class="pl">${esc(t('hp.members.stat_status'))}</div></div>
      <div class="profile-stat"><div class="pn" style="font-size:1rem">${fmtDate(m.join_date) || '—'}</div><div class="pl">${esc(t('hp.members.stat_join_date'))}</div></div>
    </div>
    ${hours.length ? `
      <div class="card" style="margin-top:1rem">
        <div class="card-head"><h3>${esc(t('hp.members.hours_history'))}</h3></div>
        <div class="table-wrap"><table>
          <thead><tr>
            <th>${esc(t('hp.members.prf_col_project'))}</th>
            <th>${esc(t('hp.members.prf_col_total'))}</th>
            <th>${esc(t('hp.members.prf_col_notes'))}</th>
          </tr></thead>
          <tbody>${hours.map(h => `<tr>
            <td>${esc(h.project_name || h.project_id || '—')}</td>
            <td><strong style="color:var(--g)">${h.total_hours || 0}</strong></td>
            <td style="font-size:.76rem">${esc(h.notes) || '—'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : `<div style="color:var(--tm);text-align:center;padding:1.5rem">${esc(t('hp.members.prf_empty_hours'))}</div>`}
  `;
}


// ════════════════════════════════════════════
// PORTAL INVITES (mirrors admin/tabs/members.js)
// ════════════════════════════════════════════
export function openHeadInviteModal(memberId) {
  const m = _members.find(x => x.member_id === memberId);
  if (!m) {
    toast(t('hp.invite.member_not_found'), 'twarn');
    return;
  }
  _currentInvite = m;

  document.getElementById('invite-member-name').textContent  = m.preferred_name || m.full_name;
  document.getElementById('invite-member-email').textContent = m.email || t('hp.invite.no_email_placeholder');

  // Disable the email button when there's no email on file so the
  // head doesn't trigger a 400 from the server.
  const emailBtn  = document.getElementById('invite-email-btn');
  const emailHelp = document.getElementById('invite-email-help');
  if (m.email) {
    emailBtn.disabled = false;
    emailBtn.style.opacity = '';
    emailHelp.textContent = t('hp.invite.email_help');
  } else {
    emailBtn.disabled = true;
    emailBtn.style.opacity = '.4';
    emailHelp.textContent = t('hp.invite.email_help_no_email');
  }

  // Reset to "choose method" state.
  document.getElementById('invite-choose').style.display = '';
  document.getElementById('invite-pin-result').style.display = 'none';
  document.getElementById('invite-email-result').style.display = 'none';

  openModal('member-invite');
}

export async function headSendInviteByEmail() {
  const m = _currentInvite;
  if (!m) return;
  const res = await api('auth.invite.byEmail', {
    member_id: m.member_id,
    redirectTo: window.location.origin + '/signup.html',
  });
  if (!res || !res.success) return;
  // DB insert may have landed even if SMTP failed — distinguish so we
  // don't lie about the email being sent.
  if (res.data && res.data.sent === false) {
    toast(t('hp.invite.email_partial_fail'), 'twarn');
    closeModal('member-invite');
    loadHeadMembers();
    return;
  }
  document.getElementById('invite-choose').style.display = 'none';
  document.getElementById('invite-email-result-target').textContent = m.email;
  document.getElementById('invite-email-result').style.display = '';
  toast(t('hp.invite.email_success_toast'), 'tok');
  loadHeadMembers();
}

export async function headSendInviteByPin() {
  const m = _currentInvite;
  if (!m) return;
  const res = await api('auth.invite.byPin', { member_id: m.member_id });
  if (!res || !res.success) return;
  document.getElementById('invite-choose').style.display = 'none';
  document.getElementById('invite-pin-value').textContent = res.data.pin;
  document.getElementById('invite-pin-result').style.display = '';
  toast(t('hp.invite.pin_success_toast'), 'tok');
  loadHeadMembers();
}

export async function headCopyShownPin() {
  const pin = document.getElementById('invite-pin-value').textContent;
  try {
    await navigator.clipboard.writeText(pin);
    toast(t('hp.invite.copy_success'), 'tok');
  } catch (err) {
    console.warn('[clipboard] write failed:', err);
    toast(t('hp.invite.copy_failed'), 'twarn');
  }
}

export async function headConfirmRevokeInvite(memberId, memberName) {
  if (!confirm(t('hp.invite.revoke_confirm', { name: memberName }))) return;
  const res = await api('auth.invite.revoke', { member_id: memberId });
  if (!res || !res.success) return;
  toast(t('hp.invite.revoke_success'), 'tok');
  loadHeadMembers();
}
