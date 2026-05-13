// SSAM Admin — main entry module.
//
// Structurally: the union of every inline <script> that used to live in
// admin.html, moved to a real module. Behaviour identical. The local
// `callApi`/`getAuthToken` definitions are replaced with imports from
// lib/api.js + lib/auth.js so all four HTML pages share the same auth path.
//
// Local DOM helpers (esc, sv, gv, fmtDate, fmtDateTime, tag, attrJson) stay
// here intentionally — they're a few lines each and the page renders dozens
// of inline-handler-bearing tables that reference them by short names. The
// lib/dom.js exports are the same functions and will be wired in when this
// module is split per-tab in the SPA branch.
//
// The bottom of this file re-exposes every handler that an inline onclick="..."
// in admin.html references, via Object.assign(window, {...}). That gluing
// stays in place until the strict-CSP commit converts inline handlers to
// addEventListener bindings; at that point the re-export block is removed.

import { callApi as _callApi } from '../lib/api.js';
import { getSession, clearSession, isLoggedIn, signOut } from '../lib/auth.js';

// Drop-in for the original local callApi — same signature, same envelope
// flattening (lib/api.js does it). Keeps every call site below unchanged.
async function callApi(action, params = {}) { return _callApi(action, params); }


// ================================================================
//  AUTH GUARD — checks login session before loading dashboard
// ================================================================
// Goes through lib/auth.js so both halves of "is this user logged in" stay
// in lockstep. Earlier this guard only looked at `ssam_session` and the
// logout helper only cleared `ssam_session`, leaving `ssam_token` behind —
// login.html's isLoggedIn() reads the token, so logout caused a redirect
// loop (login.html sees token → bounce to admin → admin sees no session →
// bounce to login → …). Mobile users couldn't escape it without closing
// the tab. clearSession() now wipes both keys atomically.
//
// We also re-run this on `pageshow` to catch the browser's back/forward
// cache: after logout the user is on /login.html, but pressing Back
// restores the admin page from bfcache WITHOUT re-executing this script,
// so the page renders even though the session is cleared. The pageshow
// handler fires on bfcache restore (event.persisted === true), kicks the
// user back to login, and stops the "ghost admin" state where a logged-
// out user sees stale data until they touch something that 401s.
function _requireAuthOrRedirect() {
  const user = getSession();
  if (!user || !isLoggedIn()) {
    clearSession();
    window.location.replace('login.html');  // replace, not href, so back
                                            // doesn't reopen admin again
    return false;
  }
  window.CURRENT_USER = user;
  return true;
}
_requireAuthOrRedirect();
window.addEventListener('pageshow', _requireAuthOrRedirect);

async function logout() {
  if (!confirm('هل تريد تسجيل الخروج؟')) return;
  // signOut() handles both auth paths: Supabase users get their
  // refresh token revoked server-side; legacy users just have their
  // local state cleared (HS256 tokens can't be revoked). Either way
  // clearSession runs at the end so we always exit to a clean state.
  await signOut();
  window.location.href = 'login.html';
}


'use strict';


const DB = {
  members:      [],
  advisors:     [],
  committees:   [],
  projects:     [],
  participants: [],
  attendance:   [],
  hours:        [],
  opportunities:[],
};

const ROLE_COLORS = {
  'President':             't-o',
  'Vice President':        't-o',
  'Deputy Vice President': 't-o',
  'Committee Head':        't-g',
  'Committee Vice Head':   't-g',
  'Project Manager':       't-b',
  'Event Manager':         't-b',
  'Member':                't-gr',
  'Volunteer':             't-p',
  'Advisor':               't-y',
};

const STATUS_COLORS = {
  'Active':    't-g',
  'Inactive':  't-r',
  'Planning':  't-y',
  'Completed': 't-g',
  'Cancelled': 't-r',
  'Present':   't-g',
  'Absent':    't-r',
  'Late':      't-y',
  'Excused':   't-b',
  'Confirmed': 't-g',
  'Pending':   't-y',
  // Opportunity statuses
  'Open':           't-b',
  'Filled':         't-g',
  'NeedsHelp':      't-r',
  'Done':           't-gr',
  // Hours approval (§7)
  'Draft':            't-y',
  'PrimaryApproved':  't-b',
  'FinalApproved':    't-g',
  'Rejected':         't-r',
  // Attendance on assignments
  'Attended':         't-g',
};

// 14 standard roles from the requirements doc §12. The UI offers them as a
// dropdown; the user can also type a custom role_name. role_key is canonical
// (used by reports later); estimated_hours is the *default* — editable per row.
const STANDARD_ROLES = [
  { key: 'reception_coordinator', name: 'منسق استقبال',          hours: 2.5 },
  { key: 'food_lead',             name: 'مسؤول طعام',            hours: 3.5 },
  { key: 'photographer',          name: 'مصوّر',                 hours: 3.5 },
  { key: 'logistics_coordinator', name: 'منسق لوجستي',           hours: 6.5 },
  { key: 'pre_event_setup',       name: 'تحضير قبلي',            hours: 3 },
  { key: 'cleanup',               name: 'تنظيف وإقفال',          hours: 2 },
  { key: 'general_supervisor',    name: 'مشرف عام',              hours: 9 },
  { key: 'mc',                    name: 'مقدّم برنامج',          hours: 4 },
  { key: 'registration',          name: 'مسؤول تسجيل',           hours: 3 },
  { key: 'av_support',            name: 'دعم فني (صوت وإضاءة)',  hours: 5 },
  { key: 'heritage_display',      name: 'مسؤول عرض تراثي',       hours: 4 },
  { key: 'academy_teacher',       name: 'معلم بالأكاديمية',      hours: 0 },
  { key: 'academy_coordinator',   name: 'منسق أكاديمية',         hours: 0 },
  { key: 'design_media',          name: 'تصميم وإعلام',          hours: 0 },
];

// ══════════════════════════════════════════
// API
// ══════════════════════════════════════════
async function api(action, body = {}) {
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

async function apiGet(action, params = {}) {
  try {
    return await callApi(action, params);
  } catch (err) {
    toast('خطأ: ' + err.message, 'terr');
    return null;
  }
}

// ══════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════
const PAGE_TITLES = {
  dashboard:       'Dashboard',
  members:         'الأعضاء',
  advisors:        'المستشارون',
  committees:      'اللجان',
  projects:        'المشاريع والفعاليات',
  participants:    'المشاركون',
  attendance:      'سجل الحضور',
  hours:           'الساعات التطوعية',
  profile:         'ملف العضو',
  'project-detail':'📋 تفاصيل المشروع',
  interest:        '🙋 طلبات المشاركة',
  emails:          '💌 الإيميلات والشكر',
  certificates:    '🏅 الشهادات',
  opportunities:   '🎯 الفرص التطوعية',
  applications:    '📥 طلبات العضوية',
  accounts:        '🔑 حسابات المستخدمين',
};

function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  const el = document.getElementById('page-' + page);
  if (el) el.classList.add('active');
  const si = document.querySelector(`[data-page="${page}"]`);
  if (si) si.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;

  // Load data on navigation
  // تحقق من صلاحية الصفحة
  if (!RBAC.canSeePage(page)) {
    toast('ليس لديك صلاحية للوصول لهذه الصفحة', 'twarn');
    return;
  }

  const loaders = {
    dashboard:        loadDashboard,
    members:          loadMembers,
    applications:     loadApplications,
    accounts:         loadAccounts,
    advisors:         loadAdvisors,
    committees:       loadCommittees,
    projects:         loadProjects,
    participants:     () => { populateProjectSelects(); loadParticipants(); },
    opportunities:    () => { populateProjectSelects(); loadOpportunities(); },
    attendance:       () => { populateProjectSelects(); loadAttendance(); },
    hours:            loadHours,
    profile:          loadProfileSelect,
    'project-detail': () => {},
    interest:         loadInterestAll,
    emails:           () => { loadThanks(''); },
    certificates:     () => { loadCerts(''); },
  };
  if (loaders[page]) loaders[page]();

  // Mobile: auto-close the sidebar after a navigation so the user isn't
  // looking at the menu they just tapped. No-op on desktop (toggle hidden).
  closeSidebar();
}

// ── Mobile sidebar toggle ──────────────────────────────────────────────────
// Desktop (>900px width) keeps the sidebar permanently visible via CSS — these
// helpers only do anything on small screens, where .sidebar.open + .sb-backdrop.open
// slide it in over a dim backdrop.
function openSidebar() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('sb-backdrop')?.classList.add('open');
  document.getElementById('sb-toggle')?.setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sb-backdrop')?.classList.remove('open');
  document.getElementById('sb-toggle')?.setAttribute('aria-expanded', 'false');
}
function toggleSidebar() {
  const open = document.getElementById('sidebar')?.classList.contains('open');
  if (open) closeSidebar(); else openSidebar();
}

function refreshData() {
  const active = document.querySelector('.page.active');
  if (active) {
    const page = active.id.replace('page-', '');
    showPage(page);
  }
}

// ── populateNewSelects: للصفحات الجديدة ─────────────────────
function populateNewSelects() {
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

function setApiStatus(state, text) {
  const el = document.getElementById('api-status');
  const tx = document.getElementById('api-status-text');
  el.className = 'api-status ' + state;
  tx.textContent = text;
}

// ══════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════
async function loadDashboard() {
  const data = await apiGet('getDashboardStats');
  if (!data || !data.success) return;

  const s = data.stats;
  document.getElementById('s-members').textContent    = s.active_members   || 0;
  document.getElementById('s-projects').textContent   = s.total_projects   || 0;
  document.getElementById('s-hours').textContent      = s.total_hours      || 0;
  document.getElementById('s-committees').textContent = s.total_committees || 0;
  document.getElementById('b-members').textContent    = s.total_members    || 0;
  document.getElementById('b-projects').textContent   = s.total_projects   || 0;

  setApiStatus('ok', 'متصل');

  // Top volunteers
  const volEl = document.getElementById('dash-top-volunteers');
  if (data.top_volunteers && data.top_volunteers.length) {
    volEl.innerHTML = data.top_volunteers.map((v, i) => `
      <div class="vol-rank">
        <div class="rank-badge ${i < 3 ? 'rk' + (i+1) : 'rkx'}">${i+1}</div>
        <div class="vol-name">${v.name}</div>
        <div class="vol-hours">${v.hours} ساعة</div>
      </div>`).join('');
  } else {
    volEl.innerHTML = '<p style="color:var(--tm);font-size:.84rem">لا توجد بيانات بعد</p>';
  }

  // Committee chart
  const comEl = document.getElementById('dash-committee-chart');
  if (data.committee_stats && data.committee_stats.length) {
    const maxH = Math.max(...data.committee_stats.map(c => c.total_hours), 1);
    comEl.innerHTML = data.committee_stats.map(c => `
      <div class="committee-bar">
        <div class="cb-name" title="${c.committee_name}">${c.committee_name}</div>
        <div class="cb-bar">
          <div class="cb-fill" style="width:${Math.round(c.total_hours / maxH * 100)}%">
            <span>${c.total_hours}h</span>
          </div>
        </div>
        <div style="font-size:.72rem;color:var(--tm);flex-shrink:0">${c.member_count}م</div>
      </div>`).join('');
  } else {
    comEl.innerHTML = '<p style="color:var(--tm);font-size:.84rem">لا توجد بيانات بعد</p>';
  }

  // Recent projects
  const prjTbody = document.getElementById('dash-recent-projects');
  if (data.recent_projects && data.recent_projects.length) {
    prjTbody.innerHTML = data.recent_projects.map(p => `<tr>
      <td><strong>${esc(p.project_name)}</strong></td>
      <td>${tag(p.project_type, p.project_type === 'Project' ? 't-b' : 't-p')}</td>
      <td>${fmtDate(p.event_date) || '—'}</td>
      <td>${tag(p.project_status, STATUS_COLORS[p.project_status] || 't-gr')}</td>
    </tr>`).join('');
  } else {
    prjTbody.innerHTML = '<tr class="empty-row"><td colspan="4">لا توجد مشاريع بعد</td></tr>';
  }
}

// ══════════════════════════════════════════
// MEMBERS
// ══════════════════════════════════════════
async function loadMembers() {
  const data = await apiGet('getMembers');
  if (!data || !data.success) return;
  DB.members = data.data || [];
  // تطبيق فلتر الصلاحيات
  const filtered = RBAC.filterMembers(DB.members);
  renderMembers(filtered);
  populateMemberSelects();
  RBAC.injectMyTeamBadge();
}

function renderMembers(members) {
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
        <button class="btn-icon edit" onclick="editMember('${m.member_id}')" title="تعديل">✏️</button>
        <button class="btn-icon del" onclick="confirmDelete('member','${m.member_id}',${attrJson(m.full_name)})" title="حذف">🗑️</button>
        <button class="btn-icon" onclick="viewProfile('${m.member_id}')" title="ملف العضو">👤</button>
      </td>
    </tr>`;
  }).join('');
}

function filterTable(tbodyId, q) {
  document.getElementById(tbodyId).querySelectorAll('tr:not(.empty-row)').forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(q.toLowerCase()) ? '' : 'none';
  });
}
function filterMembersByRole(role) {
  const filtered = role ? DB.members.filter(m => m.club_role === role) : DB.members;
  renderMembers(filtered);
}
function filterMembersByStatus(status) {
  const filtered = status ? DB.members.filter(m => m.status === status) : DB.members;
  renderMembers(filtered);
}
function filterProjectsByStatus(status) {
  const filtered = status ? DB.projects.filter(p => p.project_status === status) : DB.projects;
  renderProjects(filtered);
}

async function saveMember() {
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

function editMember(id) {
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
// ADVISORS
// ══════════════════════════════════════════
async function loadAdvisors() {
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

async function saveAdvisor() {
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

function editAdvisor(id) {
  const a = DB.advisors.find(x => x.advisor_id === id);
  if (!a) return;
  sv('adv-edit-id', id);
  sv('adv-full-name', a.full_name); sv('adv-role', a.advisory_role);
  sv('adv-email', a.email); sv('adv-phone', a.phone);
  sv('adv-notes', a.notes); sv('adv-status', a.status);
  document.getElementById('advisor-modal-title').textContent = '✏️ تعديل المستشار';
  openModal('advisor');
}

// ══════════════════════════════════════════
// COMMITTEES
// ══════════════════════════════════════════
async function loadCommittees() {
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
        <button class="btn-icon edit" onclick="editCommittee('${c.committee_id}')">✏️</button>
        <button class="btn-icon del" onclick="confirmDelete('committee','${c.committee_id}',${attrJson(c.committee_name)})">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

async function saveCommittee() {
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

function editCommittee(id) {
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

// ══════════════════════════════════════════
// PROJECTS
// ══════════════════════════════════════════
async function loadProjects() {
  const data = await apiGet('getProjects');
  if (!data || !data.success) return;
  DB.projects = data.data || [];
  renderProjects(DB.projects);
  populateProjectSelects();
}

function renderProjects(projects) {
  const tbody = document.getElementById('projects-tbody');
  if (!projects.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">لا توجد مشاريع</td></tr>';
    return;
  }
  tbody.innerHTML = projects.map(p => {
    const mgr = DB.members.find(m =>
      m.member_id === p.assigned_project_manager_member_id ||
      m.member_id === p.assigned_event_manager_member_id
    );
    return `<tr>
      <td><strong>${esc(p.project_name)}</strong></td>
      <td>${tag(p.project_type, p.project_type === 'Project' ? 't-b' : 't-p')}</td>
      <td>${fmtDate(p.event_date) || '—'}</td>
      <td style="font-size:.78rem">${esc(p.location) || '—'}</td>
      <td>${mgr ? esc(mgr.preferred_name || mgr.full_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td>${tag(p.project_status, STATUS_COLORS[p.project_status] || 't-gr')}</td>
      <td>
        <button class="btn-icon edit" onclick="editProject('${p.project_id}')">✏️</button>
        <button class="btn-icon del" onclick="confirmDelete('project','${p.project_id}',${attrJson(p.project_name)})">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

async function saveProject() {
  const id = gv('prj-edit-id');
  const body = {
    project_name:                         gv('prj-name'),
    project_type:                         gv('prj-type'),
    project_description:                  gv('prj-desc'),
    event_date:                           gv('prj-date'),
    start_time:                           gv('prj-start'),
    end_time:                             gv('prj-end'),
    location:                             gv('prj-location'),
    proposal_file_url:                    gv('prj-proposal'),
    created_by_member_id:                 gv('prj-created-by'),
    assigned_project_manager_member_id:   gv('prj-manager'),
    assigned_event_manager_member_id:     gv('prj-event-mgr'),
    project_status:                       gv('prj-status'),
    notes:                                gv('prj-notes'),
  };
  if (!body.project_name || !body.created_by_member_id) {
    toast('الاسم ومنشئ المشروع مطلوبان', 'twarn'); return;
  }
  let res;
  if (id) res = await api('updateProject', { id, data: body });
  else     res = await api('createProject', body);
  if (res) { toast('✅ تم الحفظ'); closeModal('project'); clearForm('project'); loadProjects(); }
}

function editProject(id) {
  const p = DB.projects.find(x => x.project_id === id);
  if (!p) return;
  sv('prj-edit-id', id);
  sv('prj-name', p.project_name); sv('prj-type', p.project_type);
  sv('prj-desc', p.project_description);
  // <input type="date"> needs YYYY-MM-DD; <input type="time"> needs HH:MM.
  // Postgres returns event_date as ISO with time, and start/end_time as 'HH:MM:SS'.
  sv('prj-date',  p.event_date  ? String(p.event_date).slice(0, 10) : '');
  sv('prj-start', p.start_time  ? String(p.start_time).slice(0, 5)  : '');
  sv('prj-end',   p.end_time    ? String(p.end_time).slice(0, 5)    : '');
  sv('prj-location', p.location); sv('prj-proposal', p.proposal_file_url);
  sv('prj-created-by', p.created_by_member_id);
  sv('prj-manager', p.assigned_project_manager_member_id);
  sv('prj-event-mgr', p.assigned_event_manager_member_id);
  sv('prj-status', p.project_status); sv('prj-notes', p.notes);
  document.getElementById('project-modal-title').textContent = '✏️ تعديل المشروع';
  openModal('project');
}

// ══════════════════════════════════════════
// PARTICIPANTS
// ══════════════════════════════════════════
async function loadParticipants(projectId) {
  const params = projectId ? { project_id: projectId } : {};
  const data = await api('getParticipants', params);
  if (!data || !data.success) return;
  const tbody = document.getElementById('participants-tbody');
  const items = data.data || [];
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">لا يوجد مشاركون بعد</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(p => {
    const member  = DB.members.find(m  => m.member_id  === p.member_id);
    const project = DB.projects.find(x => x.project_id === p.project_id);
    const name = p.participant_type === 'Member'
      ? (member ? esc(member.preferred_name || member.full_name) : p.member_id)
      : esc(p.volunteer_name);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${tag(project.project_type, project.project_type === 'Project' ? 't-b' : 't-p')}</div>`
      : `<span style="color:var(--tm)">${esc(p.project_id)}</span>`;
    return `<tr>
      <td>
        <div style="font-weight:700">${name}</div>
        ${p.participant_type === 'Volunteer' ? `<div style="font-size:.72rem;color:var(--tm);direction:ltr">${esc(p.volunteer_email)}</div>` : ''}
      </td>
      <td>${projectCell}</td>
      <td>${tag(p.participant_type, p.participant_type === 'Member' ? 't-b' : 't-p')}</td>
      <td>${tag(p.participation_status, STATUS_COLORS[p.participation_status] || 't-gr')}</td>
      <td><span class="tag t-gr">${esc(p.availability_type)}</span></td>
      <td>${p.outstanding_flag === 'true' || p.outstanding_flag === true ? '⭐' : '—'}</td>
      <td>
        <button class="btn-icon del" onclick="confirmDelete('participant','${p.participant_id}','هذا المشارك')">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

async function saveParticipant() {
  const body = {
    project_id:         gv('par-project'),
    participant_type:   gv('par-type'),
    member_id:          gv('par-member'),
    volunteer_name:     gv('par-vol-name'),
    volunteer_email:    gv('par-vol-email'),
    volunteer_phone:    gv('par-vol-phone'),
    participation_status: gv('par-status'),
    availability_type:  gv('par-avail'),
    manager_notes:      gv('par-notes'),
    outstanding_flag:   document.getElementById('par-outstanding').checked,
  };
  if (!body.project_id) { toast('اختر مشروعاً', 'twarn'); return; }
  const res = await api('addParticipant', body);
  if (res) {
    toast('✅ تم إضافة المشارك');
    closeModal('participant');
    if (document.getElementById('participants-project-filter').value === body.project_id) {
      loadParticipants(body.project_id);
    }
  }
}

function toggleParticipantFields() {
  const type = gv('par-type');
  document.getElementById('par-member-section').style.display   = type === 'Member' ? '' : 'none';
  document.getElementById('par-volunteer-section').style.display = type === 'Volunteer' ? '' : 'none';
}

// ══════════════════════════════════════════
// USER ACCOUNTS (superadmin only)
// ══════════════════════════════════════════
const ACCESS_LABEL_AR = {
  superadmin: 'مدير عام',
  head:       'رئيس لجنة',
  member:     'عضو',
  volunteer:  'متطوع',
};
const ACCESS_COLOR = {
  superadmin: 't-o',
  head:       't-g',
  member:     't-b',
  volunteer:  't-p',
};

async function loadAccounts() {
  // Adapt the UI to the caller's role:
  //   superadmin → full management ("حسابات المستخدمين" + Add button)
  //   head       → reset-only view scoped to their committee
  const isAdmin = RBAC.isSuperAdmin();
  const title = document.getElementById('accounts-head-title');
  const addBtn = document.getElementById('accounts-add-btn');
  if (title) title.textContent = isAdmin
    ? '🔑 حسابات المستخدمين'
    : '🔑 حسابات أعضاء لجنتي — إعادة تعيين كلمات المرور';
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
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">لا توجد حسابات بعد</td></tr>';
  } else {
    tbody.innerHTML = items.map(a => renderAccountRow(a)).join('');
  }
  const badge = document.getElementById('b-accounts');
  if (badge) badge.textContent = items.length;
}

function renderAccountRow(a) {
  // For heads, some rows are members WITHOUT an account yet — `a.id` is null
  // and we show a "no account yet" state with no actions (admin needs to
  // create the account first via the create-account modal).
  const hasAccount = !!a.id;
  const isSelf    = hasAccount && window.CURRENT_USER && a.id === window.CURRENT_USER.id;
  const isAdmin   = RBAC.isSuperAdmin();

  const memberCell = a.member_id
    ? `<div style="font-weight:600">${esc(a.member_preferred_name || a.member_full_name || a.member_id)}</div>
       <div style="font-size:.7rem;color:var(--tm)">${esc(a.member_club_role || '')} · <span dir="ltr">${esc(a.member_id)}</span></div>`
    : '<span style="color:var(--tm)">— (حساب مدير غير مرتبط) —</span>';

  const usernameCell = hasAccount
    ? `<span dir="ltr" style="font-weight:700;font-family:Menlo,Consolas,monospace;font-size:.85rem">${esc(a.username)}</span>${isSelf ? ' <span style="font-size:.7rem;color:var(--g)">(أنت)</span>' : ''}`
    : `<span style="color:var(--tm);font-size:.78rem">— لم يُنشأ حساب بعد —</span>`;

  const accessCell = hasAccount
    ? tag(ACCESS_LABEL_AR[a.access_level] || a.access_level, ACCESS_COLOR[a.access_level] || 't-gr')
    : `<span style="font-size:.7rem;color:var(--tm)">${isAdmin ? 'لا يوجد حساب' : 'اطلب من المدير إنشاء حساب'}</span>`;

  const lastLoginCell = hasAccount
    ? (a.last_login_at ? fmtDateTime(a.last_login_at) : '<span style="color:var(--tm)">لم يدخل بعد</span>')
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
      actions.push(`<button class="btn-icon edit" title="تعديل" onclick="editAccount(${a.id})">✏️</button>`);
    }
    if (isAdmin || (a.access_level !== 'superadmin' && a.access_level !== 'head')) {
      if (a.auth_user_id) {
        actions.push(`<button class="btn-icon" title="إرسال رابط إعادة تعيين كلمة المرور" onclick="sendPasswordResetEmail(${a.id}, ${attrJson(a.username)}, ${attrJson(a.auth_email || '')})">📧</button>`);
      } else {
        actions.push(`<button class="btn-icon" title="إعادة تعيين كلمة المرور (إنشاء كلمة مؤقتة)" onclick="resetAccountPassword(${a.id}, ${attrJson(a.username)})">🔑</button>`);
      }
    }
    if (isAdmin && !isSelf) {
      actions.push(`<button class="btn-icon del" title="حذف" onclick="confirmDeleteAccount(${a.id}, ${attrJson(a.username)})">🗑️</button>`);
    }
  } else if (isAdmin) {
    actions.push(`<button class="btn-icon" title="إنشاء حساب لهذا العضو" onclick="openAccountModalForMember(${attrJson(a.member_id)})">➕</button>`);
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
function openAccountModalForMember(memberId) {
  openAccountModal();
  setTimeout(() => {
    sv('acc-member', memberId);
    // If the member has an NID, auto-suggest it as username (per agreed convention).
    const m = DB.members.find(x => x.member_id === memberId);
    if (m && m.national_id && !gv('acc-username')) sv('acc-username', m.national_id);
    if (!gv('acc-password')) generateAccountPw();
  }, 50);
}

function openAccountModal(forEditId) {
  // Reset form
  sv('acc-edit-id', forEditId || '');
  sv('acc-username', '');
  sv('acc-password', '');
  sv('acc-access', 'member');
  document.getElementById('account-modal-title').textContent =
    forEditId ? '✏️ تعديل حساب' : '🔑 إضافة حساب';
  document.getElementById('acc-pw-required').style.display = forEditId ? 'none' : '';
  document.getElementById('acc-pw-hint').textContent = forEditId
    ? 'اتركها فارغة للاحتفاظ بكلمة المرور الحالية. لإعادة التعيين استخدم زر 🔑 في الجدول.'
    : 'على الأقل 6 أحرف.';

  // Populate the member dropdown — only members without an account
  // (or the current account's own member when editing).
  const sel = document.getElementById('acc-member');
  const usedMemberIds = new Set((DB._accounts || []).map(a => a.member_id).filter(Boolean));
  const current = forEditId ? (DB._accounts || []).find(a => a.id === forEditId) : null;
  if (current && current.member_id) usedMemberIds.delete(current.member_id);
  const linkableMembers = DB.members.filter(m => !usedMemberIds.has(m.member_id));
  sel.innerHTML = '<option value="">— حساب مدير غير مرتبط بعضو —</option>' +
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

function editAccount(id) { openAccountModal(id); }

function generateAccountPw() {
  // 9-char URL-safe random. Matches the server-side helper used by resetPassword.
  const arr = new Uint8Array(7);
  crypto.getRandomValues(arr);
  const pw = btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  sv('acc-password', pw);
}

async function saveAccount() {
  const id = gv('acc-edit-id');
  const body = {
    username:     gv('acc-username'),
    password:     gv('acc-password'),
    member_id:    gv('acc-member') || null,
    access_level: gv('acc-access'),
  };
  if (!body.username) { toast('اسم المستخدم مطلوب', 'twarn'); return; }
  if (!id && !body.password) { toast('كلمة المرور مطلوبة للحساب الجديد', 'twarn'); return; }

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
    toast(id ? '✅ تم تعديل الحساب' : '✅ تم إنشاء الحساب');
    closeModal('account');
    loadAccounts();
  }
}

async function resetAccountPassword(id, username) {
  if (!confirm(`إعادة تعيين كلمة مرور ${username}؟\nسيتم توليد كلمة مرور جديدة وإلغاء كلمة المرور الحالية فوراً.`)) return;
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
async function sendPasswordResetEmail(id, username, email) {
  if (!email) { toast('لا يوجد بريد إلكتروني مرتبط بهذا الحساب', 'twarn'); return; }
  const ok = confirm(
    `إرسال رابط إعادة تعيين كلمة المرور إلى:\n${email}\n\n` +
    `سيتلقى ${username} رسالة بريد فيها رابط؛ بالضغط عليه يقوم بتعيين كلمة مرور جديدة بنفسه.`
  );
  if (!ok) return;
  // Tell the Edge Function which origin the reset email's link should
  // come back to — important so that a reset triggered from the
  // deploy preview routes the user back to the preview, not prod.
  // Supabase still validates this against the project's Redirect URLs
  // allowlist before honoring it.
  const redirectTo = window.location.origin + '/reset-password.html';
  const res = await api('users.sendPasswordReset', { id, redirectTo });
  if (res && res.success) {
    toast(`📧 تم إرسال الرابط إلى ${email}`);
  }
}

function copyShownPw() {
  const v = document.getElementById('pw-shown-value').textContent;
  navigator.clipboard.writeText(v).then(
    () => toast('📋 تم النسخ'),
    () => toast('تعذّر النسخ — انسخها يدوياً', 'twarn')
  );
}

function confirmDeleteAccount(id, username) {
  if (!confirm(`حذف حساب ${username}؟ سيخسر المستخدم القدرة على تسجيل الدخول.`)) return;
  api('users.delete', { id }).then(res => {
    if (res && res.success) { toast('🗑️ تم الحذف'); loadAccounts(); }
  });
}

// ══════════════════════════════════════════
// MEMBERSHIP APPLICATIONS (§6)
// ══════════════════════════════════════════
const APP_STATUS_AR = {
  PendingTriage:       'قيد الفرز',
  AssignedToCommittee: 'معيّنة للجنة',
  InterviewRequested:  'مقابلة مطلوبة',
  Accepted:            'مقبولة',
  Rejected:            'مرفوضة',
};

// Canonical-value → Arabic label maps for the expanded apply-form-v2 fields.
// Keep the canonical-value strings in sync with apply.html and migration 0005.
const SCHOLARSHIP_LABELS = {
  khadem_alharamain:    'برنامج خادم الحرمين الشريفين',
  job_sponsored:        'ابتعاث وظيفي (حكومي/عسكري)',
  private_sector:       'الشركات والقطاع الخاص',
  cultural_tourism:     'الابتعاث الثقافي والسياحي',
  companion_student:    'مرافق دارس',
  self_funded:          'دارس على الحساب الخاص',
  companion_non_student: 'مرافق غير دارس',
};
const UNIVERSITY_LABELS = {
  melbourne:  'Melbourne University',
  monash:     'Monash University',
  rmit:       'RMIT',
  deakin:     'Deakin University',
  latrobe:    'La Trobe University',
  swinburne:  'Swinburne University',
  victoria:   'Victoria University',
  acu:        'Australian Catholic University',
};
const STUDY_LEVEL_LABELS = {
  PhD:       'دكتوراه',
  Masters:   'ماجستير',
  Bachelor:  'بكالوريوس',
  Diploma:   'دبلوم',
  Language:  'دراسة لغة',
};
const STUDY_START_LABELS = {
  '<6mo':   'أقل من 6 أشهر',
  '6mo-1y': '6 أشهر إلى سنة',
  '>1y':    'أكثر من سنة',
};
const GRADUATION_LABELS = {
  Jul2027: 'يوليو 2027',
  Dec2027: 'ديسمبر 2027',
  '2028+': '2028 أو لاحقاً',
};
const REFERRAL_LABELS = {
  twitter:   'منصة إكس (تويتر)',
  snapchat:  'سناب شات',
  instagram: 'انستقرام',
  whatsapp:  'واتس اب',
  website:   'الموقع الإلكتروني',
  friend:    'صديق / زميل',
};
const APP_STATUS_COLOR = {
  PendingTriage:       't-y',
  AssignedToCommittee: 't-b',
  InterviewRequested:  't-o',
  Accepted:            't-g',
  Rejected:            't-r',
};
let _activeApplication = null;

async function loadApplications() {
  // Ensure committees are loaded — needed for the triage dropdown and
  // for resolving committee_id → name in the row + detail rendering.
  if (!DB.committees.length) {
    const c = await api('getCommittees', {});
    DB.committees = (c && c.success ? c.data : []) || [];
  }
  const params = {};
  const st = gv('applications-status-filter'); if (st) params.status = st;
  const data = await api('applications.list', params);
  if (!data || !data.success) return;
  const items = data.data || [];
  const tbody = document.getElementById('applications-tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">لا توجد طلبات</td></tr>';
  } else {
    tbody.innerHTML = items.map(a => renderApplicationRow(a)).join('');
  }
  // Sidebar badge: count of items still needing a decision (everything pre-final).
  const pending = items.filter(a => a.status !== 'Accepted' && a.status !== 'Rejected').length;
  const badge = document.getElementById('b-applications');
  if (badge) badge.textContent = pending;
  // Cache for the modal lookups.
  DB._applications = items;
}

function renderApplicationRow(a) {
  const contact = [a.email, a.phone].filter(Boolean).join(' · ') || '—';
  const uniMajor = [a.university, a.major].filter(Boolean).join(' / ') || '—';
  const interests = (a.interests && a.interests.length)
    ? a.interests.map(id => {
        const c = DB.committees.find(cc => cc.committee_id === id);
        return c ? c.committee_name : id;
      }).join('، ')
    : '<span style="color:var(--tm)">—</span>';
  const assigned = a.assigned_committee_name
    ? esc(a.assigned_committee_name)
    : '<span style="color:var(--tm)">—</span>';
  const statusLabel = APP_STATUS_AR[a.status] || a.status;
  const isFinal = a.status === 'Accepted' || a.status === 'Rejected';
  return `<tr>
    <td>
      <div style="font-weight:700">${esc(a.preferred_name || a.full_name)}</div>
      ${a.preferred_name ? `<div style="font-size:.7rem;color:var(--tm)">${esc(a.full_name)}</div>` : ''}
    </td>
    <td style="font-size:.78rem;direction:ltr;text-align:right">${esc(contact)}</td>
    <td style="font-size:.78rem">${esc(uniMajor)}</td>
    <td style="font-size:.78rem;max-width:160px">${interests}</td>
    <td>${assigned}</td>
    <td>${tag(statusLabel, APP_STATUS_COLOR[a.status] || 't-gr')}</td>
    <td>${fmtDate(a.created_at)}</td>
    <td>
      <button class="btn-icon" title="${isFinal ? 'عرض' : 'مراجعة'}" onclick="openApplicationReview('${esc(a.application_id)}')">${isFinal ? '👁️' : '✏️'}</button>
    </td>
  </tr>`;
}

function openApplicationReview(applicationId) {
  const a = (DB._applications || []).find(x => x.application_id === applicationId);
  if (!a) return;
  _activeApplication = a;
  sv('app-edit-id', a.application_id);
  sv('app-decision-note', a.decision_reason || '');

  // Detail panel — every field captured by apply.html, grouped the same way
  // the form groups them so reviewers can scan top-down.
  const interests = (a.interests && a.interests.length)
    ? a.interests.map(id => {
        const c = DB.committees.find(cc => cc.committee_id === id);
        return c ? c.committee_name : id;
      }).join('، ')
    : '—';
  const phone = a.phone ? `${a.phone_country_code || ''} ${a.phone}`.trim() : '—';
  const whatsapp = a.whatsapp ? `${a.whatsapp_country_code || ''} ${a.whatsapp}`.trim() : '';
  const scholarship = a.scholarship_entity === 'other'
    ? (a.scholarship_entity_other || 'أخرى')
    : (SCHOLARSHIP_LABELS[a.scholarship_entity] || a.scholarship_entity || '—');
  const university = a.university === 'other'
    ? (a.university_other || 'أخرى')
    : (UNIVERSITY_LABELS[a.university] || a.university || '—');
  const studyLevel = STUDY_LEVEL_LABELS[a.study_level] || a.study_level || '—';
  const studyStarted = STUDY_START_LABELS[a.study_started_window] || a.study_started_window || '—';
  const expectedGrad = GRADUATION_LABELS[a.expected_graduation_window] || a.expected_graduation_window || '—';
  const referral = a.referral_source === 'other'
    ? (a.referral_source_other || 'أخرى')
    : (REFERRAL_LABELS[a.referral_source] || a.referral_source || '—');

  const block = (title, rows) => {
    const visible = rows.filter(([, v]) => v && v !== '—');
    if (!visible.length) return '';
    return `<div style="margin-top:.75rem;padding-top:.6rem;border-top:1px solid #e5e7eb">
      <div style="font-size:.74rem;color:var(--tm);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.4rem">${title}</div>
      ${visible.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join('')}
    </div>`;
  };

  document.getElementById('app-detail').innerHTML = `
    <div style="font-size:.95rem;font-weight:700;color:var(--g)">${esc(a.name_ar || a.full_name)}${a.preferred_name ? ` <span style="color:var(--tm);font-size:.78rem">(${esc(a.preferred_name)})</span>` : ''}</div>
    ${a.name_en ? `<div dir="ltr" style="font-size:.78rem;color:var(--tm);margin-top:.1rem">${esc(a.name_en)}</div>` : ''}

    ${block('الهوية', [
      ['رقم الهوية',   a.national_id ? `<span dir="ltr">${esc(a.national_id)}</span>` : ''],
      ['الجنس',        esc(a.gender)],
      ['تاريخ الميلاد', fmtDate(a.date_of_birth)],
    ])}

    ${block('التواصل', [
      ['البريد',     a.email    ? `<span dir="ltr">${esc(a.email)}</span>` : ''],
      ['الجوال',    a.phone    ? `<span dir="ltr">📱 ${esc(phone)}</span>` : ''],
      ['واتس اب',  a.whatsapp ? `<span dir="ltr">💬 ${esc(whatsapp)}</span>` : ''],
      ['العنوان',   esc(a.address_melbourne)],
    ])}

    ${block('الابتعاث والدراسة', [
      ['جهة الابتعاث',         esc(scholarship)],
      ['المرحلة',              esc(studyLevel)],
      ['التخصص',               esc(a.degree_field || a.major)],
      ['الجامعة',              esc(university)],
      ['بدء الدراسة',          esc(studyStarted)],
      ['التخرج المتوقع',       esc(expectedGrad)],
    ])}

    ${block('عنه', [
      ['اللجان المهتم بها', interests],
      ['المهارات والهوايات', a.skills_hobbies ? esc(a.skills_hobbies).replace(/\n/g, '<br>') : ''],
      ['عن نفسه',           (a.about_self || a.pitch) ? esc(a.about_self || a.pitch).replace(/\n/g, '<br>') : ''],
      ['السيرة الذاتية',    a.cv_url ? `<a href="${esc(a.cv_url)}" target="_blank" rel="noopener" dir="ltr" style="color:var(--g);text-decoration:underline">فتح الرابط ↗</a>` : ''],
    ])}

    ${block('إضافات', [
      ['كيف علم بالنادي', esc(referral)],
      ['اقتراحات',       a.suggestions ? esc(a.suggestions).replace(/\n/g, '<br>') : ''],
    ])}

    <div style="margin-top:.7rem;padding-top:.6rem;border-top:1px solid #e5e7eb;font-size:.74rem;color:var(--tm)">
      رقم الطلب: <span dir="ltr">${esc(a.application_id)}</span> · تاريخ الطلب: ${fmtDate(a.created_at)}
      ${a.decided_at ? ` · قرار في ${fmtDate(a.decided_at)}` : ''}
      ${a.created_member_id ? ` · العضو: <span dir="ltr">${esc(a.created_member_id)}</span>` : ''}
    </div>
  `;

  // Show the right action panel for this status.
  ['triage', 'decide', 'final'].forEach(k =>
    document.getElementById('app-action-' + k).style.display = 'none'
  );
  if (a.status === 'PendingTriage') {
    document.getElementById('app-action-triage').style.display = '';
    // Populate committee dropdown — show full set, suggest the first interest if any.
    const sel = document.getElementById('app-assign-committee');
    sel.innerHTML = '<option value="">— اختر لجنة —</option>' + DB.committees.map(c =>
      `<option value="${c.committee_id}">${esc(c.committee_name)}</option>`
    ).join('');
    if (a.interests && a.interests.length) sel.value = a.interests[0];
  } else if (a.status === 'AssignedToCommittee' || a.status === 'InterviewRequested') {
    document.getElementById('app-action-decide').style.display = '';
  } else {
    document.getElementById('app-action-final').style.display = '';
  }
  openModal('application');
}

async function appAssignCommittee() {
  if (!_activeApplication) return;
  const committeeId = gv('app-assign-committee');
  if (!committeeId) { toast('اختر لجنة', 'twarn'); return; }
  const res = await api('applications.assignCommittee', {
    id: _activeApplication.application_id, committee_id: committeeId,
  });
  if (res && res.success) {
    toast('📤 تم الإسناد لرئيس اللجنة');
    closeModal('application');
    loadApplications();
  }
}

async function appAccept() {
  if (!_activeApplication) return;
  const note = gv('app-decision-note');
  const res = await api('applications.accept', { id: _activeApplication.application_id, note });
  if (res && res.success) {
    toast(`✅ تم قبول العضو (${res.data ? res.data.member_id : ''})`);
    closeModal('application');
    loadApplications();
    // Also refresh members so the new row appears immediately if the user navigates there.
    loadMembers();
  }
}

async function appRequestInterview() {
  if (!_activeApplication) return;
  const note = gv('app-decision-note');
  const res = await api('applications.requestInterview', { id: _activeApplication.application_id, note });
  if (res && res.success) {
    toast('💬 تم طلب مقابلة');
    closeModal('application');
    loadApplications();
  }
}

async function appReject() {
  if (!_activeApplication) return;
  const reason = prompt('سبب الرفض (اختياري):', gv('app-decision-note') || '');
  if (reason === null) return;
  const res = await api('applications.reject', { id: _activeApplication.application_id, reason });
  if (res && res.success) {
    toast('❌ تم الرفض');
    closeModal('application');
    loadApplications();
  }
}

// ══════════════════════════════════════════
// OPPORTUNITIES (§4, §12) + ASSIGNMENTS
// ══════════════════════════════════════════
const ATTENDANCE_OPTIONS = ['Pending', 'Attended', 'Absent', 'Excused'];
const ATTENDANCE_LABEL_AR = {
  Pending: 'قيد الانتظار', Attended: 'حضر', Absent: 'غاب', Excused: 'معذور',
};
const OPP_STATUS_AR = {
  Open: 'مفتوحة', Filled: 'مكتملة', NeedsHelp: 'تحتاج مساعدة',
  Cancelled: 'ملغاة', Done: 'منتهية',
};

let _activeOpportunity = null; // currently-open opportunity in the assignments modal

async function loadOpportunities() {
  const params = {};
  const pid = gv('opportunities-project-filter'); if (pid) params.project_id = pid;
  const st  = gv('opportunities-status-filter');  if (st)  params.status     = st;
  const data = await api('opportunities.list', params);
  if (!data || !data.success) return;
  DB.opportunities = data.data || [];
  renderOpportunities(DB.opportunities);
  const badge = document.getElementById('b-opportunities');
  if (badge) badge.textContent = DB.opportunities.length;
}

function renderOpportunities(items) {
  const tbody = document.getElementById('opportunities-tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">لا توجد فرص بعد</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(o => {
    const project = DB.projects.find(p => p.project_id === o.project_id);
    const com = DB.committees.find(c => c.committee_id === o.owning_committee_id);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${fmtDate(project.event_date)}</div>`
      : esc(o.project_id);
    const filled = (o.assigned_count || 0);
    const need   = o.headcount_needed || 1;
    const fillBar = `${filled} / ${need}` + (filled >= need ? ' ✅' : '');
    const att = `${o.attended_count || 0} حضر`;
    const statusLabel = OPP_STATUS_AR[o.status] || o.status;
    return `<tr>
      <td>${projectCell}</td>
      <td><strong>${esc(o.role_name)}</strong></td>
      <td>${com ? esc(com.committee_name) : '<span style="color:var(--tm)">—</span>'}</td>
      <td>${o.estimated_hours} س</td>
      <td>${fillBar}</td>
      <td style="font-size:.8rem">${att}</td>
      <td>${tag(statusLabel, STATUS_COLORS[o.status] || 't-gr')}</td>
      <td>
        <button class="btn-icon" title="إدارة المسندين" onclick="openOpportunityAssignments('${o.opportunity_id}')">👥</button>
        <button class="btn-icon edit" onclick="editOpportunity('${o.opportunity_id}')">✏️</button>
        <button class="btn-icon del" onclick="confirmDeleteOpportunity('${o.opportunity_id}','${esc(o.role_name).replace(/'/g, "\\'")}')">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

function populateRolePresets() {
  const sel = document.getElementById('opp-role-key');
  if (!sel || sel.options.length > 1) return;
  for (const r of STANDARD_ROLES) {
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = `${r.name} (${r.hours || '—'} س)`;
    sel.appendChild(opt);
  }
}

function onOppRolePreset() {
  const key = gv('opp-role-key');
  if (!key) return;
  const r = STANDARD_ROLES.find(x => x.key === key);
  if (!r) return;
  // Only fill when the user hasn't typed anything custom yet — don't clobber.
  if (!gv('opp-role-name')) sv('opp-role-name', r.name);
  if (r.hours && parseFloat(gv('opp-est-hours') || 0) === 2) sv('opp-est-hours', r.hours);
}

async function saveOpportunity() {
  const id = gv('opp-edit-id');
  const body = {
    project_id:          gv('opp-project'),
    role_name:           gv('opp-role-name'),
    role_key:            gv('opp-role-key') || null,
    estimated_hours:     parseFloat(gv('opp-est-hours')) || 0,
    headcount_needed:    parseInt(gv('opp-headcount'), 10) || 1,
    owning_committee_id: gv('opp-committee') || null,
    status:              gv('opp-status'),
    notes:               gv('opp-notes'),
  };
  if (!body.project_id || !body.role_name) {
    toast('المشروع واسم الدور مطلوبان', 'twarn'); return;
  }
  const res = id
    ? await api('opportunities.update', { id, data: body })
    : await api('opportunities.create', body);
  if (res && res.success) {
    toast('✅ تم الحفظ');
    closeModal('opportunity');
    clearForm('opportunity');
    loadOpportunities();
  }
}

function editOpportunity(id) {
  const o = DB.opportunities.find(x => x.opportunity_id === id);
  if (!o) return;
  sv('opp-edit-id', id);
  sv('opp-project', o.project_id);
  sv('opp-role-key', o.role_key || '');
  sv('opp-role-name', o.role_name || '');
  sv('opp-est-hours', o.estimated_hours || 0);
  sv('opp-headcount', o.headcount_needed || 1);
  sv('opp-committee', o.owning_committee_id || '');
  sv('opp-status', o.status || 'Open');
  sv('opp-notes', o.notes || '');
  openModal('opportunity');
}

function confirmDeleteOpportunity(id, name) {
  document.getElementById('confirm-msg').textContent = `هل تريد حذف الفرصة "${name}"؟ سيتم حذف جميع المسندين عليها.`;
  document.getElementById('confirm-btn').onclick = async () => {
    const res = await api('opportunities.delete', { id });
    if (res && res.success) {
      toast('🗑️ تم الحذف');
      closeModal('confirm');
      loadOpportunities();
    }
  };
  openModal('confirm');
}

// ─── ASSIGNMENTS MODAL ───────────────────────────────────────────────
async function openOpportunityAssignments(opportunityId) {
  _activeOpportunity = DB.opportunities.find(o => o.opportunity_id === opportunityId);
  if (!_activeOpportunity) return;
  const o = _activeOpportunity;
  const project = DB.projects.find(p => p.project_id === o.project_id);
  const com = DB.committees.find(c => c.committee_id === o.owning_committee_id);
  document.getElementById('opp-assign-header').innerHTML = `
    <div style="font-weight:700">${esc(o.role_name)}</div>
    <div style="font-size:.78rem;color:var(--tm);margin-top:.25rem">
      ${project ? esc(project.project_name) : ''} · ${o.estimated_hours} س ·
      ${com ? esc(com.committee_name) : '—'}
    </div>`;

  // Fill member-picker with members not yet assigned to this opportunity
  const memberSel = document.getElementById('opp-assign-member');
  memberSel.innerHTML = '<option value="">— اختر —</option>';
  const r = await api('assignments.list', { opportunity_id: opportunityId });
  const assigned = (r && r.success ? r.data : []) || [];
  const assignedMemberIds = new Set(assigned.map(a => a.member_id).filter(Boolean));
  for (const m of DB.members) {
    if (assignedMemberIds.has(m.member_id)) continue;
    const opt = document.createElement('option');
    opt.value = m.member_id;
    opt.textContent = m.preferred_name || m.full_name;
    memberSel.appendChild(opt);
  }
  renderAssignments(assigned);
  openModal('opp-assign');
}

function renderAssignments(items) {
  const tbody = document.getElementById('opp-assign-tbody');
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">لا يوجد مسندون بعد</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(a => {
    const member = DB.members.find(m => m.member_id === a.member_id);
    const name = a.member_id
      ? (member ? esc(member.preferred_name || member.full_name) : a.member_id)
      : `${esc(a.volunteer_name)}${a.volunteer_email ? ` <span style="color:var(--tm);font-size:.72rem;direction:ltr">(${esc(a.volunteer_email)})</span>` : ''}`;
    const opts = ATTENDANCE_OPTIONS.map(s =>
      `<option value="${s}" ${a.attendance_status === s ? 'selected' : ''}>${ATTENDANCE_LABEL_AR[s]}</option>`
    ).join('');
    return `<tr>
      <td>${name}</td>
      <td><select onchange="markAttendance(${a.assignment_id}, this.value)">${opts}</select></td>
      <td><button class="btn-icon del" onclick="removeAssignment(${a.assignment_id})">🗑️</button></td>
    </tr>`;
  }).join('');
}

async function addAssignmentMember() {
  const memberId = gv('opp-assign-member');
  if (!memberId || !_activeOpportunity) return;
  const res = await api('assignments.add', {
    opportunity_id: _activeOpportunity.opportunity_id,
    member_id:      memberId,
  });
  if (res && res.success) {
    toast('✅ تم الإسناد');
    openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}

async function addAssignmentVolunteer() {
  const name  = gv('opp-assign-vol-name');
  const email = gv('opp-assign-vol-email');
  if (!name || !_activeOpportunity) { toast('اسم المتطوع مطلوب', 'twarn'); return; }
  const res = await api('assignments.add', {
    opportunity_id:  _activeOpportunity.opportunity_id,
    volunteer_name:  name,
    volunteer_email: email || null,
  });
  if (res && res.success) {
    toast('✅ تم الإسناد');
    sv('opp-assign-vol-name', '');
    sv('opp-assign-vol-email', '');
    openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}

async function markAttendance(assignmentId, status) {
  const res = await api('assignments.markAttendance', {
    assignment_id: assignmentId, attendance_status: status,
  });
  if (res && res.success) {
    toast('✅ تم التحديث');
    if (_activeOpportunity) loadOpportunities();
  }
}

async function removeAssignment(assignmentId) {
  if (!confirm('إزالة هذا الشخص من الفرصة؟')) return;
  const res = await api('assignments.remove', { id: assignmentId });
  if (res && res.success) {
    toast('🗑️ تمت الإزالة');
    if (_activeOpportunity) openOpportunityAssignments(_activeOpportunity.opportunity_id);
    loadOpportunities();
  }
}

// ══════════════════════════════════════════
// ATTENDANCE
// ══════════════════════════════════════════
async function loadAttendance(projectId) {
  const params = projectId ? { project_id: projectId } : {};
  const data = await api('getAttendance', params);
  if (!data || !data.success) return;
  const tbody = document.getElementById('attendance-tbody');
  const items = data.data || [];
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">لا يوجد حضور مسجّل بعد</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(a => {
    const member  = DB.members.find(m  => m.member_id  === a.member_id);
    const project = DB.projects.find(x => x.project_id === a.project_id);
    const name = a.participant_type === 'Member'
      ? (member ? esc(member.preferred_name || member.full_name) : a.member_id)
      : esc(a.volunteer_email);
    const checker = DB.members.find(m => m.member_id === a.checked_by_member_id);
    const projectCell = project
      ? `<div style="font-weight:600">${esc(project.project_name)}</div>
         <div style="font-size:.7rem;color:var(--tm)">${fmtDate(project.event_date)}</div>`
      : `<span style="color:var(--tm)">${esc(a.project_id)}</span>`;
    return `<tr>
      <td><strong>${name}</strong></td>
      <td>${projectCell}</td>
      <td>${tag(a.participant_type, a.participant_type === 'Member' ? 't-b' : 't-p')}</td>
      <td>${tag(a.attendance_status, STATUS_COLORS[a.attendance_status] || 't-gr')}</td>
      <td>${fmtDate(a.attendance_date) || '—'}</td>
      <td>${checker ? esc(checker.preferred_name || checker.full_name) : '—'}</td>
      <td>
        <button class="btn-icon del" onclick="confirmDelete('attendance','${a.attendance_id}','سجل الحضور هذا')">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

async function saveAttendance() {
  const body = {
    project_id:         gv('att-project'),
    participant_type:   gv('att-type'),
    member_id:          gv('att-member'),
    volunteer_email:    gv('att-vol-email'),
    attendance_status:  gv('att-status'),
    attendance_date:    gv('att-date'),
    checked_by_member_id: gv('att-checker'),
    notes:              gv('att-notes'),
  };
  if (!body.project_id || !body.attendance_status) { toast('المشروع وحالة الحضور مطلوبان', 'twarn'); return; }
  const res = await api('recordAttendance', body);
  if (res) {
    toast('✅ تم تسجيل الحضور');
    closeModal('attendance');
    if (document.getElementById('attendance-project-filter').value === body.project_id) {
      loadAttendance(body.project_id);
    }
  }
}

function toggleAttFields() {
  const t = gv('att-type');
  document.getElementById('att-member-section').style.display = t === 'Member' ? '' : 'none';
  document.getElementById('att-vol-section').style.display    = t === 'Volunteer' ? '' : 'none';
}

// ══════════════════════════════════════════
// VOLUNTEER HOURS
// ══════════════════════════════════════════
async function loadHours(projectId) {
  const params = projectId ? { project_id: projectId } : {};
  const data = await api('getMemberHours', params);
  if (!data || !data.success) return;
  const tbody = document.getElementById('hours-tbody');
  const items = data.data || [];
  if (!items.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">لا توجد ساعات مسجّلة</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(h => renderHoursRow(h)).join('');
}

// Renders one hours row with the right approval-stage badge and action buttons
// (per §7). Visibility of approve/reject buttons is controlled by the caller's
// access level — the server still re-checks every action.
function renderHoursRow(h) {
  const member  = DB.members.find(m => m.member_id === h.member_id);
  const project = DB.projects.find(p => p.project_id === h.project_id);
  const name = h.participant_type === 'Member'
    ? (member ? esc(member.preferred_name || member.full_name) : h.member_id)
    : esc(h.volunteer_email);
  const projectCell = project
    ? `<div style="font-weight:600">${esc(project.project_name)}</div>
       ${h.opportunity_role_name ? `<div style="font-size:.7rem;color:var(--tm)">${esc(h.opportunity_role_name)}</div>` : ''}`
    : esc(h.project_id);
  const status = h.approval_status || 'Draft';
  const statusLabelAR = {
    Draft: 'مسودة', PrimaryApproved: 'اعتماد أولي',
    FinalApproved: 'اعتماد نهائي', Rejected: 'مرفوض',
  }[status] || status;

  const access = (window.CURRENT_USER || {}).access;
  const isHead = access === 'head';
  const isAdmin = access === 'superadmin';
  const ownsCommittee = isAdmin
    || (isHead && h.opportunity_committee_id === window.CURRENT_USER.committee_id);

  const actions = [];
  if (status === 'Draft' && ownsCommittee) {
    actions.push(`<button class="btn-icon" title="اعتماد أولي" onclick="primaryApproveHours(${h.hours_id})">✅</button>`);
    actions.push(`<button class="btn-icon" title="رفض" onclick="rejectHours(${h.hours_id})">❌</button>`);
  } else if (status === 'PrimaryApproved' && isAdmin) {
    actions.push(`<button class="btn-icon" title="اعتماد نهائي" onclick="finalApproveHours(${h.hours_id})">✅</button>`);
    actions.push(`<button class="btn-icon" title="رفض" onclick="rejectHours(${h.hours_id})">❌</button>`);
  } else if (status === 'FinalApproved' && isAdmin) {
    actions.push(`<button class="btn-icon" title="رفض / استرجاع" onclick="rejectHours(${h.hours_id})">↩️</button>`);
  }
  actions.push(`<button class="btn-icon del" onclick="confirmDelete('hours','${h.hours_id}','هذا السجل')">🗑️</button>`);

  const approverHint = h.primary_approver_name
    ? `<div style="font-size:.65rem;color:var(--tm);margin-top:.15rem">أولي: ${esc(h.primary_approver_name)}${h.final_approver_name ? ` · نهائي: ${esc(h.final_approver_name)}` : ''}</div>`
    : '';
  const rejectHint = h.rejected_reason
    ? `<div style="font-size:.65rem;color:var(--rd);margin-top:.15rem">سبب: ${esc(h.rejected_reason)}</div>`
    : '';

  return `<tr>
    <td><strong>${name}</strong></td>
    <td style="font-size:.78rem">${projectCell}</td>
    <td>${h.hours_before || 0}</td>
    <td>${h.hours_during || 0}</td>
    <td>${h.hours_after || 0}</td>
    <td><strong style="color:var(--g)">${h.total_hours || 0}</strong></td>
    <td>${tag(statusLabelAR, STATUS_COLORS[status] || 't-gr')}${approverHint}${rejectHint}</td>
    <td>${actions.join('')}</td>
  </tr>`;
}

async function primaryApproveHours(id) {
  const res = await api('hours.primaryApprove', { id });
  if (res && res.success) { toast('✅ اعتماد أولي'); loadHours(gv('hours-project-filter') || ''); }
}
async function finalApproveHours(id) {
  const res = await api('hours.finalApprove', { id });
  if (res && res.success) { toast('✅ اعتماد نهائي'); loadHours(gv('hours-project-filter') || ''); loadDashboard(); }
}
async function rejectHours(id) {
  const reason = prompt('سبب الرفض (اختياري):');
  if (reason === null) return;
  const res = await api('hours.reject', { id, reason });
  if (res && res.success) { toast('❌ تم الرفض'); loadHours(gv('hours-project-filter') || ''); loadDashboard(); }
}

async function saveHours() {
  const before = parseFloat(gv('hrs-before') || 0);
  const during = parseFloat(gv('hrs-during') || 0);
  const after  = parseFloat(gv('hrs-after')  || 0);
  const assignmentId = gv('hrs-assignment-id');
  const body = {
    assignment_id:        assignmentId ? parseInt(assignmentId, 10) : null,
    project_id:           gv('hrs-project'),
    participant_type:     gv('hrs-type'),
    member_id:            gv('hrs-member'),
    volunteer_email:      gv('hrs-vol-email'),
    hours_before:         before,
    hours_during:         during,
    hours_after:          after,
    recorded_by_member_id:gv('hrs-recorder'),
    notes:                gv('hrs-notes'),
  };
  if (!body.project_id) { toast('اختر مشروعاً', 'twarn'); return; }
  if (before + during + after <= 0) { toast('أدخل عدد الساعات', 'twarn'); return; }
  const res = await api('recordHours', body);
  if (res && res.success) {
    toast(`✅ تم تسجيل ${res.total_hours} ساعة`);
    closeModal('hours'); clearForm('hours');
    loadHours(gv('hours-project-filter') || '');
  }
}

// ─── Hours via Opportunity (Principle 2) ─────────────────────────────
let _hrsOpportunityCache = null;
let _hrsAssignmentsCache = [];

async function populateHrsOpportunitySelect() {
  const sel = document.getElementById('hrs-opportunity');
  if (!sel) return;
  sv('hrs-assignment-id', '');
  // Use the cache from the Opportunities tab if it's already loaded; otherwise fetch.
  if (DB.opportunities && DB.opportunities.length) {
    _hrsOpportunityCache = DB.opportunities;
  } else {
    const r = await api('opportunities.list', {});
    _hrsOpportunityCache = (r && r.success ? r.data : []) || [];
  }
  sel.innerHTML = '<option value="">— تسجيل مباشر بدون فرصة —</option>'
    + _hrsOpportunityCache.map(o => {
        const proj = DB.projects.find(p => p.project_id === o.project_id);
        const projName = proj ? proj.project_name : o.project_id;
        return `<option value="${o.opportunity_id}">${esc(projName)} — ${esc(o.role_name)}</option>`;
      }).join('');
  // Reset assignment select
  document.getElementById('hrs-assignment').innerHTML =
    '<option value="">— اختر بعد اختيار الفرصة —</option>';
}

async function onHrsOpportunityChange() {
  sv('hrs-assignment-id', '');
  const oid = gv('hrs-opportunity');
  const assignSel = document.getElementById('hrs-assignment');
  if (!oid) {
    assignSel.innerHTML = '<option value="">— اختر بعد اختيار الفرصة —</option>';
    _hrsAssignmentsCache = [];
    return;
  }
  const r = await api('assignments.list', { opportunity_id: oid });
  _hrsAssignmentsCache = (r && r.success ? r.data : []) || [];
  // Only show assignments marked Attended — Principle 2.
  const attended = _hrsAssignmentsCache.filter(a => a.attendance_status === 'Attended');
  if (!attended.length) {
    assignSel.innerHTML = '<option value="">لا يوجد حضور مؤكَّد لهذه الفرصة</option>';
    return;
  }
  assignSel.innerHTML = '<option value="">— اختر —</option>' + attended.map(a => {
    const member = DB.members.find(m => m.member_id === a.member_id);
    const name = a.member_id
      ? (member ? (member.preferred_name || member.full_name) : a.member_id)
      : (a.volunteer_name + (a.volunteer_email ? ` — ${a.volunteer_email}` : ''));
    return `<option value="${a.assignment_id}">${esc(name)}</option>`;
  }).join('');
}

function onHrsAssignmentChange() {
  const aid = gv('hrs-assignment');
  if (!aid) { sv('hrs-assignment-id', ''); return; }
  sv('hrs-assignment-id', aid);
  const a = _hrsAssignmentsCache.find(x => String(x.assignment_id) === String(aid));
  if (!a) return;
  // Auto-fill project, participant type, and member from the assignment.
  sv('hrs-project', a.project_id || '');
  if (a.member_id) {
    sv('hrs-type', 'Member'); toggleHrsFields(); sv('hrs-member', a.member_id);
  } else {
    sv('hrs-type', 'Volunteer'); toggleHrsFields(); sv('hrs-vol-email', a.volunteer_email || '');
  }
  // Default during-hours to the opportunity's estimated_hours if currently zero.
  if (parseFloat(gv('hrs-during') || 0) === 0 && a.estimated_hours) {
    sv('hrs-during', a.estimated_hours);
    document.getElementById('hrs-total').textContent = a.estimated_hours;
  }
}

function toggleHrsFields() {
  const t = gv('hrs-type');
  document.getElementById('hrs-member-section').style.display = t === 'Member' ? '' : 'none';
  document.getElementById('hrs-vol-section').style.display    = t === 'Volunteer' ? '' : 'none';
}

// Live hours total preview
['hrs-before','hrs-during','hrs-after'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => {
    const b = parseFloat(gv('hrs-before')||0);
    const d = parseFloat(gv('hrs-during')||0);
    const a = parseFloat(gv('hrs-after') ||0);
    document.getElementById('hrs-total').textContent = (b+d+a).toFixed(1);
  });
});

// ══════════════════════════════════════════
// MEMBER PROFILE
// ══════════════════════════════════════════
function loadProfileSelect() {
  if (!DB.members.length) loadMembers().then(populateProfileSelect);
  else populateProfileSelect();
}

function populateProfileSelect() {
  const sel = document.getElementById('profile-member-select');
  sel.innerHTML = '<option value="">اختر عضواً</option>' +
    DB.members.map(m => `<option value="${m.member_id}">${esc(m.preferred_name || m.full_name)}</option>`).join('');
}

async function loadMemberProfile(memberId) {
  if (!memberId) return;
  const member = DB.members.find(m => m.member_id === memberId);
  if (!member) return;
  const com = DB.committees.find(c => c.committee_id === member.committee_id);

  // Load this member's hours
  const hoursData = await api('getMemberHours', { member_id: memberId });
  const hours = hoursData?.data || [];
  const totalHours = hours.reduce((s, h) => s + (parseFloat(h.total_hours) || 0), 0);
  const projectsParticipated = new Set(hours.map(h => h.project_id)).size;

  const content = document.getElementById('profile-content');
  content.innerHTML = `
    <div class="profile-hero">
      <div class="profile-avatar">${(member.preferred_name || member.full_name).charAt(0)}</div>
      <div>
        <div class="profile-name">${esc(member.preferred_name || member.full_name)}</div>
        <div style="font-size:.78rem;color:rgba(255,255,255,.7);margin-top:.15rem">${esc(member.full_name)}</div>
        <div class="profile-role">${esc(member.club_role)} ${com ? '· ' + esc(com.committee_name) : ''}</div>
        <div style="font-size:.72rem;color:rgba(255,255,255,.5);direction:ltr;margin-top:.2rem">${esc(member.email)}</div>
      </div>
    </div>
    <div class="profile-stats">
      <div class="profile-stat"><div class="pn">${totalHours.toFixed(1)}</div><div class="pl">ساعة تطوعية</div></div>
      <div class="profile-stat"><div class="pn">${projectsParticipated}</div><div class="pl">مشروع شارك</div></div>
      <div class="profile-stat"><div class="pn">${tag(member.status, STATUS_COLORS[member.status] || 't-gr')}</div><div class="pl">الحالة</div></div>
      <div class="profile-stat"><div class="pn" style="font-size:1rem">${fmtDate(member.join_date) || '—'}</div><div class="pl">تاريخ الانضمام</div></div>
    </div>
    ${hours.length ? `
    <div class="card">
      <div class="card-head"><h3>⏱️ سجل الساعات التطوعية</h3></div>
      <div class="table-wrap"><table>
        <thead><tr><th>المشروع</th><th>قبل</th><th>خلال</th><th>بعد</th><th>الإجمالي</th><th>ملاحظات</th></tr></thead>
        <tbody>${hours.map(h => {
          const prj = DB.projects.find(p => p.project_id === h.project_id);
          return `<tr>
            <td>${prj ? esc(prj.project_name) : h.project_id}</td>
            <td>${h.hours_before || 0}</td><td>${h.hours_during || 0}</td><td>${h.hours_after || 0}</td>
            <td><strong style="color:var(--g)">${h.total_hours || 0}</strong></td>
            <td style="font-size:.76rem">${esc(h.notes) || '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>` : '<div style="color:var(--tm);text-align:center;padding:2rem">لا توجد ساعات مسجّلة لهذا العضو</div>'}`;
}

function viewProfile(memberId) {
  showPage('profile');
  sv('profile-member-select', memberId);
  loadMemberProfile(memberId);
}

// ══════════════════════════════════════════
// POPULATE SELECTS
// ══════════════════════════════════════════
function populateMemberSelects() {
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

function populateProjectSelects() {
  const options = DB.projects.map(p =>
    `<option value="${p.project_id}">${esc(p.project_name)}</option>`
  ).join('');
  ['participants-project-filter','attendance-project-filter','hours-project-filter',
   'opportunities-project-filter',
   'par-project','att-project','hrs-project','opp-project'
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

function populateCommitteeSelects() {
  const opts = '<option value="">— بدون لجنة —</option>' +
    DB.committees.map(c => `<option value="${c.committee_id}">${esc(c.committee_name)}</option>`).join('');
  ['m-committee-id','opp-committee'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const prev = el.value; el.innerHTML = opts; if (prev) el.value = prev; }
  });
}

// ══════════════════════════════════════════
// DELETE
// ══════════════════════════════════════════
let _deleteAction = null;
function confirmDelete(type, id, name) {
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
// MODALS
// ══════════════════════════════════════════
function openModal(type) {
  document.getElementById('ov-' + type).classList.add('open');
  // Pre-populate selects
  if (['member','participant','project','attendance','hours','opportunity'].includes(type)) {
    populateMemberSelects();
    populateProjectSelects();
    populateCommitteeSelects();
  }
  if (type === 'committee') populateMemberSelects();
  if (type === 'opportunity') populateRolePresets();
  if (type === 'hours') populateHrsOpportunitySelect();
  // Set today's date defaults
  if (type === 'attendance') sv('att-date', new Date().toISOString().split('T')[0]);
  if (type === 'member' && !gv('m-join-date')) sv('m-join-date', new Date().toISOString().split('T')[0]);
}
function closeModal(type) {
  document.getElementById('ov-' + type).classList.remove('open');
}
document.querySelectorAll('.overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); })
);

// Sidebar hamburger + backdrop wiring. Run on next tick so the DOM has the
// elements (init() above defers loaders behind setTimeout — these are
// instant).
document.getElementById('sb-toggle')   ?.addEventListener('click', toggleSidebar);
document.getElementById('sb-backdrop') ?.addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebar();
});

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════
const gv = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
const sv = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Safe JSON for inlining inside an HTML attribute. `JSON.stringify(name)`
// gives `"name"` — the literal double-quotes break onclick="..." parsing and
// silently kill the handler. Replace them with the HTML entity so the
// browser reconstructs the original JSON value when invoking the handler.
const attrJson = v => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// Format any ISO/date string to a short local date. Returns '' for falsy/invalid.
// Wrapped in <span dir="ltr"> so the page's RTL direction doesn't reorder
// "30 May 2026" into "May 2026 30".
function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const s = d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: '2-digit' });
  return `<span dir="ltr" style="display:inline-block">${s}</span>`;
}
function fmtDateTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const s = d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `<span dir="ltr" style="display:inline-block">${s}</span>`;
}
const tag = (text, cls) => `<span class="tag ${cls}">${esc(text)}</span>`;

function clearForm(type) {
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

let _toastTimer;
function toast(msg, cls = 'tok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + cls;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.className = '', 3200);
}

// ══════════════════════════════════════════
// INIT
// ══════════════════════════════════════════

// `<script type="module">` is deferred, so by the time this file executes
// the DOM is already parsed and `DOMContentLoaded` has already fired —
// attaching a listener to it now would silently never run. Trigger the init
// immediately when the DOM is ready, otherwise wait for it (`readyState`
// covers the cold-cache vs. cached-execution race cleanly).
function _initAdmin() {
  setApiStatus('pending', 'جاري الاتصال...');
  setTimeout(async () => {
    await loadCommittees();
    await loadMembers();
    await loadProjects();
    await loadDashboard();
    setApiStatus('ok', 'متصل');
    RBAC.applyUIRestrictions();
    showPage('dashboard');
  }, 300);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initAdmin);
} else {
  _initAdmin();
}



// ================================================================
//  RBAC — Role Based Access Control
//  superadmin = يشوف كل شيء
//  head       = يشوف لجنته فقط + المشاريع + التقارير
// ================================================================

const RBAC = {
  isSuperAdmin() {
    return window.CURRENT_USER?.access === 'superadmin';
  },

  isHead() {
    return window.CURRENT_USER?.access === 'head';
  },

  // committee_id للمستخدم الحالي (لرؤساء اللجان)
  myCommitteeId() {
    if (!window.CURRENT_USER) return null;
    // نبحث عن العضو في DB للحصول على committee_id
    const m = DB.members.find(mb => mb.member_id === window.CURRENT_USER.id);
    return m ? m.committee_id : null;
  },

  // هل يمكن رؤية هذه الصفحة؟
  canSeePage(page) {
    if (this.isSuperAdmin()) return true;
    // رؤساء اللجان: يشوفون كل شيء عدا المستشارين. تبويب الحسابات متاح لهم
    // (مع تصفية إلى أعضاء لجنتهم فقط) لإعادة تعيين كلمات المرور.
    const restricted = ['advisors'];
    return !restricted.includes(page);
  },

  // فلترة الأعضاء حسب الصلاحية
  filterMembers(members) {
    if (this.isSuperAdmin()) return members;
    // رئيس اللجنة يرى أعضاء لجنته فقط + نفسه
    const myId  = window.CURRENT_USER?.id;
    const myCom = this.myCommitteeId();
    if (!myCom) return members.filter(m => m.member_id === myId);
    return members.filter(m => m.committee_id === myCom || m.member_id === myId);
  },

  // فلترة اللجان
  filterCommittees(committees) {
    if (this.isSuperAdmin()) return committees;
    const myCom = this.myCommitteeId();
    if (!myCom) return [];
    return committees.filter(c => c.committee_id === myCom);
  },

  // إخفاء العناصر التي لا يملك صلاحيتها
  applyUIRestrictions() {
    if (this.isSuperAdmin()) return; // سوبر أدمن يشوف كل شيء

    // إخفاء بعض خيارات الـ sidebar (المستشارون للسوبر أدمن فقط؛
    // تبويب الحسابات متاح للرؤساء بنطاق لجنتهم)
    const hidePages = ['advisors'];
    hidePages.forEach(page => {
      const el = document.querySelector(`[data-page="${page}"]`);
      if (el) el.style.display = 'none';
    });

    // إخفاء أزرار الحذف لرؤساء اللجان
    document.querySelectorAll('.btn-icon.del, .bic.d').forEach(btn => {
      btn.style.display = 'none';
    });

    // إخفاء أزرار الإضافة/التعديل للعناصر الكبيرة
    const hideBtns = ['#page-committees .btn-g', '#page-projects .btn-g'];
    hideBtns.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    });

    // تغيير نص الترحيب في الـ sidebar
    const role = document.getElementById('sb-role') || document.getElementById('sb-rl');
    if (role) {
      const myCom = this.myCommitteeId();
      const com   = DB.committees.find(c => c.committee_id === myCom);
      if (com) role.textContent = com.committee_name;
    }
  },

  // تطبيق بادج "لجنتي" على صفحة الأعضاء
  injectMyTeamBadge() {
    if (this.isSuperAdmin()) return;
    const pg = document.getElementById('page-members');
    if (!pg || pg.querySelector('.my-team-badge')) return;
    const myCom = this.myCommitteeId();
    const com   = DB.committees.find(c => c.committee_id === myCom);
    if (!com) return;
    const badge = document.createElement('div');
    badge.className = 'my-team-badge';
    badge.style.cssText = 'background:var(--gl);border:1.5px solid var(--g);border-radius:var(--rs);padding:.6rem 1rem;margin-bottom:1rem;font-size:.8rem;font-weight:700;color:var(--gd);display:flex;align-items:center;gap:.5rem;';
    badge.innerHTML = `🏛️ تعرض أعضاء لجنتك فقط: <span style="color:var(--g)">${com.committee_name}</span>`;
    pg.insertBefore(badge, pg.firstChild);
  },
};

// ================================================================
//  NEW MODULES v3
// ================================================================
// ================================================================
//  SSAM v3 — New Modules (مدمجة مع الداشبورد الأصلي)
//  Interest · Emails/Thanks · Certificates · Bulk Attendance · Project Detail
// ================================================================

// ── INTEREST ─────────────────────────────────────────────────
async function loadInterestAll() {
  const d = await apiGet('interest.listAll');
  if (!d || !d.success) return;
  DB.interest = d.data || [];
  renderInterest(DB.interest);
  updateIntStats(DB.interest);
  populateNewSelects();
}

async function loadInterest(pid) {
  const d = pid
    ? await api('interest.list', { project_id: pid })
    : await apiGet('interest.listAll');
  if (!d) return;
  renderInterest(d.data || []);
  updateIntStats(d.data || []);
}

function updateIntStats(list) {
  const yes = list.filter(i => i.interested === true || i.interested === 'TRUE' || i.interested === 'true').length;
  const no  = list.length - yes;
  const pct = list.length ? Math.round(yes / list.length * 100) : 0;
  setEl('int-total', list.length);
  setEl('int-yes',   yes);
  setEl('int-no',    no);
  const bar = document.getElementById('int-bar-vis');
  if (bar) {
    bar.querySelector('.int-yes').style.width = pct + '%';
  }
}

function renderInterest(list) {
  const tb = document.getElementById('tb-interest');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="6">لا توجد طلبات</td></tr>'; return; }
  tb.innerHTML = list.map(i => {
    const m  = DB.members.find(mb => mb.member_id === i.member_id);
    const p  = DB.projects.find(pr => pr.project_id === i.project_id);
    const yn = i.interested === true || i.interested === 'TRUE' || i.interested === 'true';
    return `<tr>
      <td><strong>${esc(m ? (m.preferred_name || m.full_name) : i.member_id)}</strong></td>
      <td style="font-size:.76rem">${esc(p ? p.project_name : i.project_id)}</td>
      <td>${tag(yn ? 'نعم ✓' : 'لا ✗', yn ? 't-g' : 't-r')}</td>
      <td>${tag(i.availability_type || '—', 't-b')}</td>
      <td style="font-size:.76rem;max-width:130px">${esc(i.comment) || '—'}</td>
      <td style="font-size:.71rem;color:var(--tm)">${String(i.submitted_at || '').split('T')[0] || '—'}</td>
    </tr>`;
  }).join('');
}

async function saveInterest() {
  const body = {
    project_id:        gv('int-prj-sel'),
    member_id:         gv('int-mbr-sel'),
    interested:        gv('int-yn') === 'true',
    availability_type: gv('int-av'),
    comment:           gv('int-cm'),
  };
  if (!body.project_id || !body.member_id) { toast('المشروع والعضو مطلوبان', 'twarn'); return; }
  const r = await api('interest.submit', body);
  if (r) {
    toast('✅ تم تسجيل الاهتمام');
    closeModal('interest');
    clearIntForm();
    loadInterestAll();
  }
}

function clearIntForm() {
  ['int-prj-sel','int-mbr-sel','int-cm'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
}

// ── BULK ATTENDANCE ──────────────────────────────────────────
async function loadBulkAttGrid(pid) {
  if (!pid) return;
  const grid = document.getElementById('bulk-att-grid');
  grid.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>جاري التحميل...</div>';
  const [pRes, aRes] = await Promise.all([
    api('participants.list', { project_id: pid }),
    api('attendance.list',   { project_id: pid })
  ]);
  const pars     = pRes?.data || [];
  const existing = aRes?.data || [];
  if (!pars.length) {
    grid.innerHTML = '<p style="color:var(--tm);font-size:.82rem">لا يوجد مشاركون في هذه الفعالية</p>';
    return;
  }
  grid.innerHTML = `<div class="att-grid">${pars.map(p => {
    const m   = DB.members.find(mb => mb.member_id === p.member_id);
    const nm  = p.participant_type === 'Member'
      ? esc(m ? (m.preferred_name || m.full_name) : p.member_id)
      : esc(p.volunteer_name || p.volunteer_email || '—');
    const key = p.participant_type === 'Member' ? p.member_id : p.volunteer_email;
    const cur = existing.find(a => a.member_id === key || a.volunteer_email === key);
    const cs  = cur ? cur.attendance_status : '';
    const cls = cs === 'Present' ? 'present' : cs === 'Absent' ? 'absent' : cs === 'Late' ? 'late' : cs === 'Excused' ? 'excused' : '';
    return `<div class="att-card ${cls}"
      data-mid="${p.member_id || ''}" data-ve="${p.volunteer_email || ''}" data-tp="${p.participant_type}"
      onclick="cycleAttStatus(this)">
      <div class="att-av">${nm.charAt(0)}</div>
      <div><div class="att-nm">${nm}</div><div class="att-st">${cs || '—'}</div></div>
    </div>`;
  }).join('')}</div>`;
}

function cycleAttStatus(card) {
  const cycle = ['Present','Absent','Late','Excused',''];
  const stEl  = card.querySelector('.att-st');
  const curr  = stEl.textContent === '—' ? '' : stEl.textContent;
  const next  = cycle[(cycle.indexOf(curr) + 1) % cycle.length];
  stEl.textContent = next || '—';
  card.className = 'att-card' +
    (next === 'Present' ? ' present' : next === 'Absent' ? ' absent' : next === 'Late' ? ' late' : next === 'Excused' ? ' excused' : '');
}

function markAllAtt(status) {
  document.querySelectorAll('#bulk-att-grid .att-card').forEach(c => {
    c.querySelector('.att-st').textContent = status;
    c.className = 'att-card ' + (status === 'Present' ? 'present' : status === 'Absent' ? 'absent' : 'late');
  });
}

async function saveBulkAttendance() {
  const pid = gv('batt-prj');
  if (!pid) { toast('اختر مشروعاً', 'twarn'); return; }
  const records = [];
  document.querySelectorAll('#bulk-att-grid .att-card').forEach(c => {
    const st = c.querySelector('.att-st').textContent;
    if (st && st !== '—') {
      records.push({
        member_id:       c.dataset.mid,
        volunteer_email: c.dataset.ve,
        participant_type:c.dataset.tp,
        attendance_status: st,
        attendance_date: new Date().toISOString().split('T')[0],
      });
    }
  });
  if (!records.length) { toast('لا توجد تغييرات', 'twarn'); return; }
  const r = await api('attendance.bulkRecord', { project_id: pid, records });
  if (r) {
    toast(`✅ حُفظ ${r.inserted || r.saved || records.length} سجل حضور`);
    closeModal('bulk-att');
    const flt = document.getElementById('flt-att-prj');
    if (flt && flt.value === pid) loadAttendance(pid);
  }
}

// ── EMAILS / THANKS ──────────────────────────────────────────
async function loadThanks(pid) {
  const d = await api('thanks.list', { project_id: pid });
  if (!d) return;
  const list = d.data || [];
  renderThanks(list);
  setEl('thx-total',   list.length);
  setEl('thx-sent',    list.filter(t => t.sent_status === 'Sent').length);
  setEl('thx-pending', list.filter(t => t.sent_status === 'Pending').length);
  setEl('thx-failed',  list.filter(t => t.sent_status === 'Failed').length);
}

function renderThanks(list) {
  const tb = document.getElementById('tb-thanks');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="6">لا توجد رسائل</td></tr>'; return; }
  tb.innerHTML = list.map(t => {
    const m  = DB.members.find(mb => mb.member_id === t.member_id);
    const p  = DB.projects.find(pr => pr.project_id === t.project_id);
    const nm = t.participant_type === 'Member'
      ? esc(m ? (m.preferred_name || m.full_name) : t.member_id)
      : esc(t.volunteer_email || '—');
    const stCls = t.sent_status === 'Sent' ? 't-g' : t.sent_status === 'Failed' ? 't-r' : 't-y';
    return `<tr>
      <td><strong>${nm}</strong></td>
      <td style="font-size:.76rem">${esc(p ? p.project_name : t.project_id)}</td>
      <td style="font-size:.75rem;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(t.email_subject || '—')}</td>
      <td>${t.hours_included ? '✅' : '—'}</td>
      <td>${tag(t.sent_status, stCls)}</td>
      <td style="font-size:.71rem;color:var(--tm)">${String(t.sent_at || '').split('T')[0] || '—'}</td>
    </tr>`;
  }).join('');
}

async function saveThanks() {
  const body = {
    project_id:           gv('thx-prj'),
    participant_type:     gv('thx-tp'),
    member_id:            gv('thx-mbr'),
    email_subject:        gv('thx-sb'),
    email_body:           gv('thx-bd'),
    hours_included:       !!document.getElementById('thx-hi')?.checked,
    outstanding_included: !!document.getElementById('thx-oi')?.checked,
  };
  if (!body.project_id) { toast('اختر مشروعاً', 'twarn'); return; }
  const r = await api('thanks.send', body);
  if (r) {
    toast(`📧 ${r.sent_status}`);
    closeModal('thanks');
    ['thx-sb','thx-bd'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
    loadThanks('');
  }
}

async function saveBulkThanks() {
  const pid = gv('bthx-prj');
  if (!pid) { toast('اختر مشروعاً', 'twarn'); return; }
  toast('⏳ جاري الإرسال...', 'twarn');
  const r = await api('thanks.bulkSend', {
    project_id: pid,
    options: {
      subject:        gv('bthx-sb'),
      custom_message: gv('bthx-msg'),
      hours_included: !!document.getElementById('bthx-hi')?.checked,
      outstanding_included: !!document.getElementById('bthx-oi')?.checked,
    }
  });
  if (r) {
    toast(`✅ أُرسل: ${r.sent} | تخطي: ${r.skipped || 0} | فشل: ${r.failed || 0}`);
    closeModal('bulk-thanks');
    loadThanks('');
  }
}

// ── CERTIFICATES ─────────────────────────────────────────────
async function loadCerts(pid) {
  const d = await api('certs.list', { project_id: pid });
  if (!d) return;
  const list = d.data || [];
  const tb = document.getElementById('tb-certs');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="7">لا توجد شهادات</td></tr>'; return; }
  tb.innerHTML = list.map(c => {
    const p = DB.projects.find(pr => pr.project_id === c.project_id);
    return `<tr>
      <td><strong>${esc(c.participant_name || '—')}</strong></td>
      <td style="font-size:.76rem">${esc(p ? p.project_name : c.project_id)}</td>
      <td>${tag(c.participation_role || '—', 't-gr')}</td>
      <td><strong style="color:var(--g)">${c.hours || 0}</strong></td>
      <td><code style="font-size:.7rem;background:#f3f4f6;padding:.13rem .4rem;border-radius:4px;direction:ltr;display:inline-block">${esc(c.verify_code)}</code></td>
      <td style="font-size:.71rem;color:var(--tm)">${String(c.issued_at || '').split('T')[0] || '—'}</td>
      <td><button class="btn-icon" onclick="previewCertCard(${JSON.stringify(c).replace(/"/g,'&quot;')})" title="معاينة">👁️</button></td>
    </tr>`;
  }).join('');
}

function switchCertTab(tab) {
  ['list','issue','verify'].forEach((t, i) => {
    document.querySelectorAll('.tab-btn')[i]?.classList.toggle('active', t === tab);
    const el = document.getElementById('cert-tab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  if (tab === 'issue' || tab === 'verify') populateNewSelects();
}

async function issueCert() {
  const pid = gv('cert-proj-sel');
  const mid = gv('cert-mbr-sel');
  if (!pid || !mid) { toast('المشروع والعضو مطلوبان', 'twarn'); return; }
  const m = DB.members.find(mb => mb.member_id === mid);
  const r = await api('certs.issue', {
    project_id:        pid,
    member_id:         mid,
    participant_name:  m ? (m.preferred_name || m.full_name) : mid,
    participation_role:'متطوع',
    hours:             0,
  });
  if (r) {
    toast(r.already_exists ? '⚠️ الشهادة موجودة بالفعل' : '🏅 تم إصدار الشهادة');
    loadCerts('');
    switchCertTab('list');
  }
}

async function saveBulkCerts() {
  const pid = gv('bcert-prj');
  if (!pid) { toast('اختر مشروعاً', 'twarn'); return; }
  const r = await api('certs.bulkIssue', { project_id: pid, options: {} });
  if (r) {
    toast(`🏅 صدر: ${r.issued} | تخطي: ${r.skipped}`);
    closeModal('bulk-certs');
    loadCerts('');
    switchCertTab('list');
  }
}

function buildCertHTML(c) {
  return `<div class="cert-card">
    <div style="font-size:2rem;margin-bottom:.7rem">🌿</div>
    <div style="font-size:.7rem;color:rgba(255,255,255,.5);letter-spacing:.1em;text-transform:uppercase;margin-bottom:.4rem">شهادة تطوع</div>
    <div style="font-size:1rem;font-weight:800">Saudi Students Association in Melbourne</div>
    <div style="font-size:.75rem;color:rgba(255,255,255,.5);margin:.2rem 0 .75rem">نادي الطلبة السعوديين في ملبورن</div>
    <div style="font-size:.8rem;color:rgba(255,255,255,.6)">يُشهد بأن</div>
    <div class="cert-name">${esc(c.participant_name || c.volunteer_email || '—')}</div>
    <div style="font-size:.85rem;color:rgba(255,255,255,.7);margin-top:.2rem">شارك في: ${esc(c.project_name || c.project_id || '—')}</div>
    ${c.event_date ? `<div style="font-size:.78rem;color:rgba(255,255,255,.55)">بتاريخ: ${esc(c.event_date)}</div>` : ''}
    ${c.hours ? `<div style="font-size:.78rem;color:rgba(255,255,255,.55);margin-top:.3rem">⏱️ ${c.hours} ساعة تطوعية</div>` : ''}
    <div class="cert-code-box">رمز التحقق: ${esc(c.verify_code)}</div>
    <div style="font-size:.67rem;color:rgba(255,255,255,.35);margin-top:.5rem">للتحقق: ssamau.com/verify</div>
  </div>`;
}

function previewCertCard(c) {
  const w = window.open('','_blank','width=540,height=600');
  if (!w) { toast('يرجى السماح بالنوافذ المنبثقة', 'twarn'); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Almarai:wght@400;700;800&display=swap" rel="stylesheet">
    <style>body{margin:0;padding:2rem;background:#111;display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:Almarai,sans-serif;}
    .cert-card{background:linear-gradient(135deg,#0e3a1c 0%,#1e5f35 60%,#B8932A 100%);border-radius:12px;padding:1.75rem;color:#fff;text-align:center;max-width:440px;margin:0 auto;}
    .cert-name{font-size:1rem;font-weight:800;color:#c9a032;margin:.6rem 0 .2rem;}
    .cert-code-box{margin-top:.85rem;background:rgba(255,255,255,.12);border-radius:8px;padding:.4rem 1rem;font-family:monospace;font-size:.78rem;letter-spacing:.1em;}
    </style></head><body>${buildCertHTML(c)}</body></html>`);
  w.document.close();
}

async function verifyCert() {
  const code = (document.getElementById('verify-code-input')?.value || '').toUpperCase().trim();
  if (!code) { toast('أدخل رمز الشهادة', 'twarn'); return; }
  const r = await api('certs.verify', { code });
  const area = document.getElementById('verify-result');
  if (!area) return;
  if (r && r.valid) {
    area.innerHTML = buildCertHTML({ ...r.data, project_name: r.data.project });
  } else {
    area.innerHTML = `<div style="background:var(--dnb);border:1.5px solid rgba(220,38,38,.25);border-radius:var(--rs);padding:1rem;font-size:.84rem;color:var(--dn);text-align:center">
      ❌ ${r?.message || 'الشهادة غير موجودة أو ملغاة'}
    </div>`;
  }
}

// ── PROJECT DETAIL ────────────────────────────────────────────
async function viewProjectDetail(pid) {
  showPage('project-detail');
  const el = document.getElementById('pdetail-content');
  if (el) el.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>جاري التحميل...</div>';

  const d = await api('dashboard.projectDetail', { project_id: pid });
  if (!d || !d.success) {
    if (el) el.innerHTML = '<p style="color:var(--dn);padding:2rem">خطأ في تحميل البيانات</p>';
    return;
  }

  const { project: p, participants, interest_summary: is, attendance_summary: as, hours_summary: hs } = d;
  const creator = DB.members.find(m => m.member_id === p.created_by_member_id);
  const pm      = DB.members.find(m => m.member_id === p.assigned_project_manager_member_id);
  const em      = DB.members.find(m => m.member_id === p.assigned_event_manager_member_id);

  el.innerHTML = `
    <div class="proj-hero">
      <div style="flex:1">
        <div style="font-size:.65rem;font-weight:700;color:rgba(255,255,255,.45);margin-bottom:.28rem">
          ${tag(p.project_type, p.project_type==='Project'?'t-b':'t-p')} · ${p.event_date||'—'} ${p.location?'· '+esc(p.location):''}
        </div>
        <div style="font-size:1.05rem;font-weight:800;margin-bottom:.22rem">${esc(p.project_name)}</div>
        <div style="font-size:.74rem;color:rgba(255,255,255,.55)">${p.start_time?p.start_time+' → '+p.end_time:''}</div>
        <div style="margin-top:.55rem;display:flex;gap:.55rem;flex-wrap:wrap">
          ${creator?`<span style="font-size:.71rem;color:rgba(255,255,255,.5)">👤 ${esc(creator.preferred_name||creator.full_name)}</span>`:''}
          ${pm?`<span style="font-size:.71rem;color:rgba(255,255,255,.5)">🔑 ${esc(pm.preferred_name||pm.full_name)}</span>`:''}
          ${em?`<span style="font-size:.71rem;color:rgba(255,255,255,.5)">🔑 ${esc(em.preferred_name||em.full_name)}</span>`:''}
        </div>
      </div>
      <div style="display:flex;gap:.45rem;flex-wrap:wrap;align-items:flex-start">
        ${tag(p.project_status, STATUS_COLORS[p.project_status]||'t-gr')}
        ${p.proposal_file_url?`<a href="${p.proposal_file_url}" target="_blank" class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)">📄 المقترح</a>`:''}
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          onclick="openModalWithPrj('bulk-att','batt-prj','${p.project_id}')">⚡ حضور جماعي</button>
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          onclick="openModalWithPrj('bulk-thanks','bthx-prj','${p.project_id}')">💌 شكر</button>
        <button class="btn btn-ol btn-sm" style="color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2)"
          onclick="openModalWithPrj('bulk-certs','bcert-prj','${p.project_id}')">🏅 شهادات</button>
      </div>
    </div>
    <div class="proj-kpis">
      <div class="kpi"><div class="kpi-n">${participants.length}</div><div class="kpi-l">مشارك</div></div>
      <div class="kpi"><div class="kpi-n">${is.interested||0}</div><div class="kpi-l">مهتم</div></div>
      <div class="kpi"><div class="kpi-n" style="color:var(--sc)">${as.present||0}</div><div class="kpi-l">حضر</div></div>
      <div class="kpi"><div class="kpi-n" style="color:var(--bl)">${hs.total_hours||0}</div><div class="kpi-l">ساعة</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>🙋 المشاركون (${participants.length})</h3></div>
      <div class="table-wrap"><table>
        <thead><tr><th>الاسم</th><th>النوع</th><th>المشاركة</th><th>الحضور</th><th>الساعات</th><th>مميّز</th></tr></thead>
        <tbody>${participants.length ? participants.map(par => `<tr>
          <td><strong>${esc(par.display_name)}</strong></td>
          <td>${tag(par.participant_type, par.participant_type==='Member'?'t-b':'t-p')}</td>
          <td>${tag(par.participation_status, STATUS_COLORS[par.participation_status]||'t-gr')}</td>
          <td>${par.attendance_status!=='—'?tag(par.attendance_status,STATUS_COLORS[par.attendance_status]||'t-gr'):'<span style="color:var(--tm)">—</span>'}</td>
          <td><strong style="color:var(--g)">${par.total_hours||0}</strong></td>
          <td>${(par.outstanding_flag===true||par.outstanding_flag==='TRUE')? '⭐':'—'}</td>
        </tr>`).join('') : '<tr class="empty-row"><td colspan="6">لا يوجد مشاركون</td></tr>'}</tbody>
      </table></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.85rem">
      <div class="card"><div class="card-head"><h3>🙋 الاهتمام</h3></div><div class="card-body">
        <div style="font-size:1.35rem;font-weight:800;color:var(--g)">${is.interested||0}<span style="font-size:.88rem;color:var(--tm)"> / ${is.total||0}</span></div>
        <div style="font-size:.72rem;color:var(--tl);margin-top:.18rem">أبدوا اهتماماً</div>
      </div></div>
      <div class="card"><div class="card-head"><h3>✅ الحضور</h3></div><div class="card-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem;text-align:center">
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--sc)">${as.present||0}</div><div style="font-size:.65rem;color:var(--tl)">حضر</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--dn)">${as.absent||0}</div><div style="font-size:.65rem;color:var(--tl)">غاب</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--wn)">${as.late||0}</div><div style="font-size:.65rem;color:var(--tl)">تأخّر</div></div>
          <div><div style="font-size:1.15rem;font-weight:800;color:var(--bl)">${as.excused||0}</div><div style="font-size:.65rem;color:var(--tl)">معذور</div></div>
        </div>
      </div></div>
      <div class="card"><div class="card-head"><h3>⏱️ الساعات</h3></div><div class="card-body">
        <div style="font-size:1.7rem;font-weight:800;color:var(--g)">${hs.total_hours||0}</div>
        <div style="font-size:.72rem;color:var(--tl)">إجمالي ساعات المشاركين</div>
      </div></div>
    </div>`;
}

function openModalWithPrj(modal, selectId, pid) {
  openModal(modal);
  const sel = document.getElementById(selectId);
  if (sel) sel.value = pid;
  if (modal === 'bulk-att') loadBulkAttGrid(pid);
}

// Apps-Script-era "Seed members → Google Sheets" banner removed in the
// Netlify migration — the data lives in Postgres now and the import flow
// is `npm run import:members` (see SETUP.md). Keeping a no-op stub here
// so the existing init code doesn't break.
function injectSeedBanner() { /* removed — see commit history */ }

// ── SIMPLE HELPERS ────────────────────────────────────────────
function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── INIT ─────────────────────────────────────────────────────
// Set sidebar user from session
if (window.CURRENT_USER) {
  const u = window.CURRENT_USER;
  const nm = document.getElementById('sb-name') || document.getElementById('sb-nm');
  const rl = document.getElementById('sb-role') || document.getElementById('sb-rl');
  const av = document.getElementById('sb-av');
  const displayName = u.name || u.username || '—';
  if (nm) nm.textContent = displayName;
  if (rl) rl.textContent = u.role || u.access || '—';
  if (av) av.textContent = (displayName.charAt(0) || '?');
}

window.addEventListener('load', () => {
  setTimeout(() => {
    populateNewSelects();
    injectSeedBanner();
  }, 800);
});


// ─── Inline-handler re-exports ──────────────────────────────────────────────
// admin.html still uses onclick="foo()" attributes throughout. ES modules are
// module-scoped, so handlers declared in this file aren't visible to inline
// HTML attributes unless we attach them to window. This block does that for
// every name reachable from a current inline handler — sourced by grepping
// admin.html for `on(click|change|submit|input|keydown|load)="<name>("`.
//
// Temporary scaffolding: the strict-CSP commit later in this branch removes
// the inline onclick="..." attributes from the markup and replaces them with
// addEventListener bindings, at which point this Object.assign goes away.
Object.assign(window, {
  // ── Generic / shared ─────────────────────────
  showPage, openModal, closeModal, refreshData, logout, filterTable, copyShownPw,

  // ── Members ──────────────────────────────────
  saveMember, editMember, filterMembersByRole, filterMembersByStatus, viewProfile, loadMemberProfile,

  // ── Advisors ─────────────────────────────────
  saveAdvisor, editAdvisor,

  // ── Committees ───────────────────────────────
  saveCommittee, editCommittee,

  // ── Projects ─────────────────────────────────
  saveProject, editProject, filterProjectsByStatus,

  // ── Participants ─────────────────────────────
  saveParticipant, loadParticipants, toggleParticipantFields,

  // ── Attendance ───────────────────────────────
  saveAttendance, loadAttendance, loadBulkAttGrid, saveBulkAttendance, markAttendance, markAllAtt, cycleAttStatus, toggleAttFields,

  // ── Hours ────────────────────────────────────
  saveHours, loadHours, toggleHrsFields, onHrsAssignmentChange, onHrsOpportunityChange, primaryApproveHours, finalApproveHours, rejectHours,

  // ── Interest ─────────────────────────────────
  saveInterest, loadInterest,

  // ── Thanks ───────────────────────────────────
  saveThanks, saveBulkThanks, loadThanks,

  // ── Certificates ─────────────────────────────
  issueCert, loadCerts, saveBulkCerts, switchCertTab, previewCertCard, verifyCert,

  // ── Applications ─────────────────────────────
  loadApplications, openApplicationReview, appAccept, appReject, appRequestInterview, appAssignCommittee,

  // ── Opportunities ────────────────────────────
  saveOpportunity, editOpportunity, loadOpportunities, confirmDeleteOpportunity, onOppRolePreset, openOpportunityAssignments, addAssignmentMember, addAssignmentVolunteer, removeAssignment,

  // ── Accounts (users) ─────────────────────────
  saveAccount, editAccount, openAccountModal, openAccountModalForMember, resetAccountPassword, sendPasswordResetEmail, confirmDeleteAccount, generateAccountPw,

  // ── Modal helpers ────────────────────────────
  openModalWithPrj, confirmDelete,
});
