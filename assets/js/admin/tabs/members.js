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
  populateMemberSelects, filterTable,
} from '../../lib/ui.js';
import { RBAC } from '../../lib/rbac.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Club-role enum (canonical English) → translation key. Also drives the
// localized label inside the row's role tag. ROLE_COLORS still keys off
// the same English value.
const CLUB_ROLE_KEY = {
  'President':           'ap.role.president',
  'Vice President':      'ap.role.vice_president',
  'Deputy Vice Head':    'ap.role.deputy_vice_head',
  'Committee Head':      'ap.role.committee_head',
  'Committee Vice Head': 'ap.role.committee_vice_head',
  'Project Manager':     'ap.role.project_manager',
  'Event Manager':       'ap.role.event_manager',
  'Member':              'ap.role.member',
  'Volunteer':           'ap.role.volunteer',
};
const STATUS_KEY = {
  Active:   'ap.status.active',
  Inactive: 'ap.status.inactive',
};

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
  // Apply RBAC + whatever filter selections are currently in the UI so
  // a refresh doesn't blow away the user's filter selections.
  applyMemberFilters();
  populateMemberSelects();
  RBAC.injectMyTeamBadge();
}

export function renderMembers(members) {
  const tbody = document.getElementById('members-tbody');
  if (!members.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${esc(t('ap.members.empty'))}</td></tr>`;
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
      inviteBtns = `<span class="t-g" style="font-size:.66rem;padding:.15rem .4rem;border-radius:6px;background:var(--gl);color:var(--g);font-weight:600" title="${esc(t('ap.members.invite_joined_title'))}">${esc(t('ap.members.invite_joined_tag'))}</span>`;
    } else if (pending) {
      // Invite outstanding — let admin resend (same modal) or revoke.
      inviteBtns =
        `<button class="btn-icon" data-action="openInviteModal" data-id="${m.member_id}" title="${esc(t('ap.members.invite_resend_title'))}">🔄</button>` +
        `<button class="btn-icon del" data-action="confirmRevokeInvite" data-id="${m.member_id}" data-name=${attrJson(m.full_name)} title="${esc(t('ap.members.invite_revoke_title'))}">❌</button>`;
    } else if (noAccount) {
      // Never invited — offer the first invite.
      inviteBtns = `<button class="btn-icon" data-action="openInviteModal" data-id="${m.member_id}" title="${esc(t('ap.members.invite_first_title'))}">📩</button>`;
    }
    // else: account_id is set but no signup_* and no signup_completed_at
    //       and no auth_user_id — legacy admin account in limbo. We
    //       deliberately render nothing in the invite column; managing
    //       these is the Accounts tab's job, not Members.

    // Per-row file indicators (Phase A — storage uploads). Show a
    // small clickable icon only when the member has uploaded the
    // file; clicking fetches a 1h signed URL on demand and opens
    // it in a new tab. Rendering the actual image inline would be
    // N+1 signed URLs per page load — too slow. Indicators are
    // enough at the listing level.
    const fileIcons = [
      m.profile_photo_url ? `<button class="btn-icon" data-action="openMemberFile" data-id="${esc(m.member_id)}" data-kind="photo" title="${esc(t('ap.members.row_photo'))}">🖼</button>` : '',
      m.cv_url            ? `<button class="btn-icon" data-action="openMemberFile" data-id="${esc(m.member_id)}" data-kind="cv"    title="${esc(t('ap.members.row_cv'))}">📄</button>` : '',
    ].filter(Boolean).join('');

    const roleLabel   = CLUB_ROLE_KEY[m.club_role] ? t(CLUB_ROLE_KEY[m.club_role]) : (m.club_role || '—');
    const statusLabel = STATUS_KEY[m.status]       ? t(STATUS_KEY[m.status])       : (m.status     || '—');

    return `<tr>
      <td>
        <div style="font-weight:700;display:flex;align-items:center;gap:.3rem;flex-wrap:wrap">
          ${esc(m.preferred_name || m.full_name)}
          ${fileIcons}
        </div>
        <div style="font-size:.72rem;color:var(--tm)">${esc(m.full_name)}</div>
      </td>
      <td>${nid}</td>
      <td style="font-size:.78rem">${contact}</td>
      <td>${tag(roleLabel, ROLE_COLORS[m.club_role] || 't-gr')}</td>
      <td>${com ? tag(com.committee_name, 't-b') : '<span style="color:var(--tm)">—</span>'}</td>
      <td><strong style="color:var(--g)">${m.total_hours || 0}</strong></td>
      <td>${tag(statusLabel, STATUS_COLORS[m.status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" data-action="editMember" data-id="${m.member_id}" title="${esc(t('ap.members.row_edit'))}">✏️</button>
        <button class="btn-icon del" data-action="confirmDelete" data-type="member" data-id="${m.member_id}" data-name=${attrJson(m.full_name)} title="${esc(t('ap.members.row_delete'))}">🗑️</button>
        <button class="btn-icon" data-action="viewProfile" data-id="${m.member_id}" title="${esc(t('ap.members.row_view'))}">👤</button>
        ${inviteBtns}
      </td>
    </tr>`;
  }).join('');
}

// Both filter selects + the text search must compose, not overwrite
// each other. Reading the current value of every control from the DOM
// (rather than tracking state in a module variable) keeps the source
// of truth in the form itself and survives outside resets cleanly.
function _currentMembersFilters() {
  const role   = document.querySelector('[data-action="filterMembersByRole"]')?.value   || '';
  const status = document.querySelector('[data-action="filterMembersByStatus"]')?.value || '';
  const query  = document.getElementById('members-search')?.value?.trim() || '';
  return { role, status, query };
}

function applyMemberFilters() {
  const { role, status, query } = _currentMembersFilters();
  let filtered = RBAC.filterMembers(DB.members);
  if (role)   filtered = filtered.filter(m => m.club_role === role);
  if (status) filtered = filtered.filter(m => m.status     === status);
  renderMembers(filtered);
  // Re-apply the text-search query on the freshly-rendered rows. The
  // select-driven re-render replaces tbody, which would otherwise wipe
  // whatever filterTable() had hidden.
  if (query) filterTable('members-tbody', query);
}

// Public-facing handlers — the dispatcher in main.js calls these with
// `el.value`. We accept and ignore the arg (the current value comes
// from re-reading the DOM via _currentMembersFilters) so the function
// signature stays backwards-compatible with any direct callers.
export function filterMembersByRole(_role)     { applyMemberFilters(); }
export function filterMembersByStatus(_status) { applyMemberFilters(); }

// Phase-A file viewer — fetches a 1h signed URL for the target member's
// uploaded file (CV or photo) and opens it in a new tab. Admin scope is
// enforced server-side by storage.getMemberFile, so the click can
// happen on any row in the table.
export async function openMemberFile(memberId, kind) {
  const res = await api('storage.getMemberFile', { data: { member_id: memberId, kind } });
  if (!res || !res.success || !res.data?.url) {
    // `missing:true` means the object was deleted out-of-band — say so
    // explicitly instead of the generic "couldn't open" so the admin
    // knows to ask the member to re-upload rather than retry.
    const friendly = res?.data?.missing
      ? t('ap.members.file_missing')
      : (localizeError(res?.error, res?.errorParams) || t('ap.members.file_failed'));
    toast(friendly, 'twarn');
    return;
  }
  window.open(res.data.url, '_blank', 'noopener');
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
    toast(t('ap.members.err_required'), 'twarn'); return;
  }
  let res;
  if (id) {
    res = await api('updateMember', { id, data: body });
  } else {
    res = await api('createMember', body);
  }
  if (res) {
    toast(id ? t('ap.members.success_update') : t('ap.members.success_create'));
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
  document.getElementById('member-modal-title').textContent = t('ap.members.modal_edit');
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
    toast(t('ap.invite.member_not_found'), 'twarn');
    return;
  }
  _currentInviteMember = m;

  // Populate the member context block at the top of the modal. The
  // fields are <div>s (display-only), not <input>s, so sv() is wrong
  // here — sv() sets el.value which is meaningless on a div. We use
  // textContent directly. Same pattern below for the PIN value and
  // email-target display fields.
  document.getElementById('invite-member-name').textContent  = m.preferred_name || m.full_name;
  document.getElementById('invite-member-email').textContent = m.email || t('ap.invite.no_email_placeholder');

  // The email button is unusable if the member has no email on file —
  // disable it so the admin can't trigger a 400 from the server.
  const emailBtn  = document.getElementById('invite-email-btn');
  const emailHelp = document.getElementById('invite-email-help');
  if (m.email) {
    emailBtn.disabled = false;
    emailBtn.style.opacity = '';
    emailHelp.textContent = t('ap.invite.email_help');
  } else {
    emailBtn.disabled = true;
    emailBtn.style.opacity = '.4';
    emailHelp.textContent = t('ap.invite.email_help_no_email');
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
    toast(t('ap.invite.email_partial_fail'), 'twarn');
    closeModal('member-invite');
    loadMembers();
    return;
  }
  // Toggle modal to "email sent" state.
  document.getElementById('invite-choose').style.display = 'none';
  document.getElementById('invite-email-result-target').textContent = m.email;
  document.getElementById('invite-email-result').style.display = '';
  toast(t('ap.invite.email_success_toast'), 'tok');
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
  toast(t('ap.invite.pin_success_toast'), 'tok');
  loadMembers();
}

export async function copyShownPin() {
  const pin = document.getElementById('invite-pin-value').textContent;
  try {
    await navigator.clipboard.writeText(pin);
    toast(t('ap.invite.copy_success'), 'tok');
  } catch (err) {
    console.warn('[clipboard] write failed:', err);
    toast(t('ap.invite.copy_failed'), 'twarn');
  }
}

// Two-step revoke: small confirm prompt before calling the server, so a
// stray click doesn't nuke a pending invite the admin still wants. No
// modal for this — toast-driven for speed.
export async function confirmRevokeInvite(memberId, memberName) {
  if (!confirm(t('ap.invite.revoke_confirm', { name: memberName }))) return;
  const res = await api('auth.invite.revoke', { member_id: memberId });
  if (!res || !res.success) return;
  toast(t('ap.invite.revoke_success'), 'tok');
  loadMembers();
}
