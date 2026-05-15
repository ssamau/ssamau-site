// User accounts tab — superadmin-managed; heads get a narrowed read-only
// reset-only view of their committee's accounts.
//
// Two password-reset variants depending on auth_user_id:
//   migrated account (Supabase Auth, auth_user_id present) → 📧 sends a
//     Supabase recovery email; admin doesn't see the new password.
//   legacy account (auth_user_id null) → 🔑 mints a temp password
//     server-side and shows it once to the admin via the pw-shown modal.
//
// The "no account yet" row state happens for heads viewing a member who's
// never had an account created — the admin needs to use the ➕ shortcut
// (which opens the create-account modal with that member pre-selected) to
// bootstrap one.

import { DB } from '../../lib/state.js';
import { esc, gv, sv, tag, attrJson, fmtDate, fmtDateTime } from '../../lib/format.js';
import { api, toast, openModal, closeModal } from '../../lib/ui.js';
import { RBAC } from '../../lib/rbac.js';
import { t } from '../../lib/i18n.js';

// ══════════════════════════════════════════
// USER ACCOUNTS (superadmin only)
// ══════════════════════════════════════════
// Access-level enum (canonical English from DB) → translation key. Tag
// colors stay in this module because they don't depend on language.
// Role-system refactor 2026-05-15 added the `admin` tier between `head`
// and `superadmin`. superadmin is now dev-only; admin is the presidency
// tier (President + VPs + DVPs). Both render with warm/red-ish tags so
// they read as "high privilege" at a glance.
export const ACCESS_KEY = {
  superadmin: 'ap.role.superadmin',
  admin:      'ap.role.admin',
  head:       'ap.role.head',
  member:     'ap.role.member',
  volunteer:  'ap.role.volunteer',
};
export const ACCESS_COLOR = {
  superadmin: 't-r',   // dev — red so it pops, only one row
  admin:      't-o',   // presidency — orange/warm
  head:       't-g',   // committee head — green
  member:     't-b',   // member — blue
  volunteer:  't-p',   // volunteer — purple
};

export async function loadAccounts() {
  // Adapt the UI to the caller's role:
  //   admin/superadmin → full management (Add button + every account)
  //   head             → reset-only view scoped to their committee
  // (Role split landed 2026-05-15 — presidency now operates as
  // `admin` while `superadmin` is dev-only. RBAC.isAdmin() handles
  // both for "see everything" decisions.)
  const isAdmin = RBAC.isAdmin();
  const title = document.getElementById('accounts-head-title');
  const addBtn = document.getElementById('accounts-add-btn');
  if (title) title.textContent = isAdmin
    ? t('ap.acc.card_title_admin')
    : t('ap.acc.card_title_head');
  if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';

  // Ensure members + committees are loaded for the linking dropdown + rendering.
  if (!DB.members.length) {
    const m = await api('getMembers', {});
    DB.members = (m && m.success ? m.data : []) || [];
  }
  if (!DB.committees.length) {
    const c = await api('getCommittees', {});
    DB.committees = (c && c.success ? c.data : []) || [];
  }
  const data = await api('users.list', {});
  if (!data || !data.success) return;
  const items = data.data || [];
  DB._accounts = items;
  const tbody = document.getElementById('accounts-tbody');
  if (!items.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.acc.empty'))}</td></tr>`;
  } else {
    tbody.innerHTML = items.map(a => renderAccountRow(a)).join('');
  }
  const badge = document.getElementById('b-accounts');
  if (badge) badge.textContent = items.length;
}

export function renderAccountRow(a) {
  // For heads, some rows are members WITHOUT an account yet — `a.id` is null
  // and we show a "no account yet" state with no actions (admin needs to
  // create the account first via the create-account modal).
  const hasAccount = !!a.id;
  const isSelf    = hasAccount && window.CURRENT_USER && a.id === window.CURRENT_USER.id;
  const isAdmin   = RBAC.isAdmin();

  const memberCell = a.member_id
    ? `<div style="font-weight:600">${esc(a.member_preferred_name || a.member_full_name || a.member_id)}</div>
       <div style="font-size:.7rem;color:var(--tm)">${esc(a.member_club_role || '')} · <span dir="ltr">${esc(a.member_id)}</span></div>`
    : `<span style="color:var(--tm)">${esc(t('ap.acc.member_not_linked'))}</span>`;

  const usernameCell = hasAccount
    ? `<span dir="ltr" style="font-weight:700;font-family:Menlo,Consolas,monospace;font-size:.85rem">${esc(a.username)}</span>${isSelf ? ` <span style="font-size:.7rem;color:var(--g)">${esc(t('ap.acc.row_self'))}</span>` : ''}`
    : `<span style="color:var(--tm);font-size:.78rem">${esc(t('ap.acc.no_account_yet'))}</span>`;

  const accessLabel = ACCESS_KEY[a.access_level] ? t(ACCESS_KEY[a.access_level]) : a.access_level;
  const accessCell = hasAccount
    ? tag(accessLabel, ACCESS_COLOR[a.access_level] || 't-gr')
    : `<span style="font-size:.7rem;color:var(--tm)">${esc(isAdmin ? t('ap.acc.no_account') : t('ap.acc.ask_admin_create'))}</span>`;

  const lastLoginCell = hasAccount
    ? (a.last_login_at ? fmtDateTime(a.last_login_at) : `<span style="color:var(--tm)">${esc(t('ap.acc.no_login_yet'))}</span>`)
    : '<span style="color:var(--tm)">—</span>';

  const createdCell = hasAccount ? (fmtDate(a.created_at) || '—') : '<span style="color:var(--tm)">—</span>';

  // Action buttons by role + state:
  //   account exists + superadmin → edit, reset, delete (except self-delete)
  //   account exists + head      → reset only (and not on heads/superadmins)
  //   no account + superadmin    → ➕ quick-create account for this member
  //   no account + head          → no actions; head asks admin to create
  //
  // Two password-reset variants depending on auth_user_id:
  //   migrated account (Supabase Auth, auth_user_id present) → 📧 sends
  //     a Supabase recovery email; admin doesn't see the new password.
  //   legacy account (auth_user_id null) → 🔑 mints a temp password
  //     server-side and shows it once to the admin (existing flow).
  const actions = [];
  if (hasAccount) {
    if (isAdmin) {
      actions.push(`<button class="btn-icon edit" title="${esc(t('ap.acc.row_edit'))}" data-action="editAccount" data-id="${a.id}">✏️</button>`);
    }
    if (isAdmin || (a.access_level !== 'superadmin' && a.access_level !== 'head')) {
      if (a.auth_user_id) {
        actions.push(`<button class="btn-icon" title="${esc(t('ap.acc.row_reset_email'))}" data-action="sendPasswordResetEmail" data-id="${a.id}" data-username=${attrJson(a.username)} data-email=${attrJson(a.auth_email || '')}>📧</button>`);
      } else {
        actions.push(`<button class="btn-icon" title="${esc(t('ap.acc.row_reset_legacy'))}" data-action="resetAccountPassword" data-id="${a.id}" data-username=${attrJson(a.username)}>🔑</button>`);
      }
    }
    if (isAdmin && !isSelf) {
      actions.push(`<button class="btn-icon del" title="${esc(t('ap.acc.row_delete'))}" data-action="confirmDeleteAccount" data-id="${a.id}" data-username=${attrJson(a.username)}>🗑️</button>`);
    }
  } else if (isAdmin) {
    actions.push(`<button class="btn-icon" title="${esc(t('ap.acc.row_create'))}" data-action="openAccountModalForMember" data-id=${attrJson(a.member_id)}>➕</button>`);
  }

  // Slightly fade no-account rows so the eye lands on the actionable ones.
  const rowStyle = hasAccount ? '' : ' style="opacity:.65"';

  return `<tr${rowStyle}>
    <td>${usernameCell}</td>
    <td>${accessCell}</td>
    <td>${memberCell}</td>
    <td style="font-size:.78rem">${esc(a.member_committee_name) || '<span style="color:var(--tm)">—</span>'}</td>
    <td style="font-size:.78rem">${lastLoginCell}</td>
    <td style="font-size:.78rem">${createdCell}</td>
    <td>${actions.join('') || '<span style="color:var(--tm)">—</span>'}</td>
  </tr>`;
}

// Shortcut: admin clicks ➕ on a no-account member row → opens create-account
// modal pre-populated with that member selected + a freshly generated password.
export function openAccountModalForMember(memberId) {
  openAccountModal();
  setTimeout(() => {
    sv('acc-member', memberId);
    // If the member has an NID, auto-suggest it as username (per agreed convention).
    const m = DB.members.find(x => x.member_id === memberId);
    if (m && m.national_id && !gv('acc-username')) sv('acc-username', m.national_id);
    if (!gv('acc-password')) generateAccountPw();
  }, 50);
}

export function openAccountModal(forEditId) {
  // Reset form
  sv('acc-edit-id', forEditId || '');
  sv('acc-username', '');
  sv('acc-password', '');
  sv('acc-access', 'member');
  document.getElementById('account-modal-title').textContent =
    forEditId ? t('ap.acc.modal_edit') : t('ap.acc.modal_add');
  document.getElementById('acc-pw-required').style.display = forEditId ? 'none' : '';
  document.getElementById('acc-pw-hint').textContent = forEditId
    ? t('ap.acc.hint_password_edit')
    : t('ap.acc.hint_password');

  // Populate the member dropdown — only members without an account
  // (or the current account's own member when editing).
  const sel = document.getElementById('acc-member');
  const usedMemberIds = new Set((DB._accounts || []).map(a => a.member_id).filter(Boolean));
  const current = forEditId ? (DB._accounts || []).find(a => a.id === forEditId) : null;
  if (current && current.member_id) usedMemberIds.delete(current.member_id);
  const linkableMembers = DB.members.filter(m => !usedMemberIds.has(m.member_id));
  sel.innerHTML = `<option value="">${esc(t('ap.acc.link_member_none_admin'))}</option>` +
    linkableMembers.map(m =>
      `<option value="${m.member_id}">${esc(m.preferred_name || m.full_name)}${m.club_role ? ' · ' + esc(m.club_role) : ''}</option>`
    ).join('');

  if (current) {
    sv('acc-username', current.username);
    sv('acc-access', current.access_level);
    sv('acc-member', current.member_id || '');
  }
  openModal('account');
}

export function editAccount(id) { openAccountModal(id); }

export function generateAccountPw() {
  // 9-char URL-safe random. Matches the server-side helper used by resetPassword.
  const arr = new Uint8Array(7);
  crypto.getRandomValues(arr);
  const pw = btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  sv('acc-password', pw);
}

export async function saveAccount() {
  const id = gv('acc-edit-id');
  const body = {
    username:     gv('acc-username'),
    password:     gv('acc-password'),
    member_id:    gv('acc-member') || null,
    access_level: gv('acc-access'),
  };
  if (!body.username) { toast(t('ap.acc.err_username_required'), 'twarn'); return; }
  if (!id && !body.password) { toast(t('ap.acc.err_password_required'), 'twarn'); return; }

  let res;
  if (id) {
    // Don't send password if the input was left blank — preserves the existing one.
    const updateBody = { id: parseInt(id, 10), username: body.username,
                         member_id: body.member_id, access_level: body.access_level };
    res = await api('users.update', { data: updateBody });
  } else {
    res = await api('users.create', body);
  }
  if (res && res.success) {
    toast(id ? t('ap.acc.success_update') : t('ap.acc.success_create'));
    closeModal('account');
    loadAccounts();
  }
}

export async function resetAccountPassword(id, username) {
  if (!confirm(t('ap.acc.reset_confirm', { username }))) return;
  const res = await api('users.resetPassword', { id });
  if (res && res.success) {
    document.getElementById('pw-shown-value').textContent = res.data.temp_password;
    document.getElementById('pw-shown-username').textContent = res.data.username;
    openModal('pw-shown');
  }
}

// Supabase Auth-side password reset. Distinct from resetAccountPassword
// (above) which mints a temp password the admin reads off the screen
// and communicates manually. This one tells Supabase Auth to email the
// user a recovery link; the user clicks it, lands on reset-password.html,
// and sets their own password. Admin never sees the new password.
//
// The button is only shown for migrated users (auth_user_id present);
// renderAccountRow above branches on that.
export async function sendPasswordResetEmail(id, username, email) {
  if (!email) { toast(t('ap.acc.err_no_email'), 'twarn'); return; }
  const ok = confirm(t('ap.acc.reset_email_confirm', { username, email }));
  if (!ok) return;
  // Tell the Edge Function which origin the reset email's link should
  // come back to — important so that a reset triggered from the
  // deploy preview routes the user back to the preview, not prod.
  // Supabase still validates this against the project's Redirect URLs
  // allowlist before honoring it.
  const redirectTo = window.location.origin + '/reset-password.html';
  const res = await api('users.sendPasswordReset', { id, redirectTo });
  if (res && res.success) {
    toast(t('ap.acc.reset_email_sent', { email }));
  }
}

export function copyShownPw() {
  const v = document.getElementById('pw-shown-value').textContent;
  navigator.clipboard.writeText(v).then(
    () => toast(t('ap.acc.pwshown_copy_success')),
    () => toast(t('ap.acc.pwshown_copy_failed'), 'twarn')
  );
}

export function confirmDeleteAccount(id, username) {
  if (!confirm(t('ap.acc.delete_confirm', { username }))) return;
  api('users.delete', { id }).then(res => {
    if (res && res.success) { toast(t('ap.acc.delete_success')); loadAccounts(); }
  });
}
