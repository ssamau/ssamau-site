// Head's "الفرص التطوعية" tab — list opportunities owned by the head's
// committee, plus an inline form for creating new ones. The head's
// `owning_committee_id` is auto-applied on create so they can't (and
// don't need to) think about scope. The server still enforces it via
// requireAdminScope.

import { esc, fmtDate, gv, sv, tag } from '../../lib/format.js';
import { api, toast } from '../../lib/ui.js';

const STATUS_AR = {
  Open:      'مفتوحة',
  Filled:    'مكتملة',
  NeedsHelp: 'تحتاج مساعدة',
  Cancelled: 'ملغاة',
  Done:      'منتهية',
};
const STATUS_CLS = {
  Open:      't-b',
  Filled:    't-g',
  NeedsHelp: 't-y',
  Cancelled: 't-gr',
  Done:      't-gr',
};

export async function loadHeadOpportunities() {
  const tbody = document.getElementById('hd-opps-tbody');
  if (!tbody) return;
  const params = {};
  const cid = window.CURRENT_USER?.committee_id;
  if (cid) params.committee_id = cid;
  const res = await api('opportunities.list', params);
  if (!res || !res.success) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">⚠️ تعذّر تحميل الفرص</td></tr>';
    return;
  }
  const opps = res.data || [];
  if (!opps.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">لا توجد فرص في لجنتك بعد</td></tr>';
    return;
  }
  tbody.innerHTML = opps.map(o => {
    const proj = o.project_name
      ? `<div>${esc(o.project_name)}</div>
         ${o.event_date ? `<div style="font-size:.7rem;color:var(--tm)">${fmtDate(o.event_date)}</div>` : ''}`
      : `<span style="color:var(--tm)">${esc(o.project_id || '—')}</span>`;
    const status = tag(STATUS_AR[o.status] || o.status || '—', STATUS_CLS[o.status] || 't-gr');
    const filled = `${o.attended_count || 0}/${o.headcount_needed || 0}`;
    return `<tr>
      <td><strong>${esc(o.role_name || '—')}</strong></td>
      <td>${proj}</td>
      <td>${esc((o.estimated_hours || 0) + ' ساعة')}</td>
      <td>${esc(filled)}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}

// ─── Inline create-opportunity flow ─────────────────────────────────
// Toggle the form panel; populate the project dropdown the first time
// it's opened. Project list is cached on the function so we don't refetch
// on every toggle.
let _projectsCached = null;
export async function toggleOpportunityCreateForm() {
  const form = document.getElementById('hd-opps-create-form');
  if (!form) return;
  const willOpen = form.style.display === 'none';
  form.style.display = willOpen ? '' : 'none';
  if (willOpen && !_projectsCached) {
    await _populateProjectsDropdown();
  }
}

async function _populateProjectsDropdown() {
  const sel = document.getElementById('hd-opp-project');
  if (!sel) return;
  const res = await api('getProjects');
  if (!res || !res.success) return;
  // Sort by event_date desc (recent + upcoming first), then by name.
  // Opportunities are typically created against current/future events.
  const projects = (res.data || []).slice().sort((a, b) => {
    const da = a.event_date || '0';
    const db = b.event_date || '0';
    if (da !== db) return db.localeCompare(da);
    return (a.project_name || '').localeCompare(b.project_name || '', 'ar');
  });
  _projectsCached = projects;
  sel.innerHTML = '<option value="">— اختر المشروع —</option>'
    + projects.map(p => {
        const date = p.event_date ? ` (${fmtDate(p.event_date).replace(/<[^>]+>/g, '')})` : '';
        return `<option value="${esc(p.project_id)}">${esc(p.project_name)}${esc(date)}</option>`;
      }).join('');
}

export async function createOpportunity() {
  const project_id     = gv('hd-opp-project');
  const role_name      = gv('hd-opp-role');
  const estimated_hours= Number(gv('hd-opp-hours') || 0);
  const headcount_needed = Number(gv('hd-opp-headcount') || 1);
  const notes          = gv('hd-opp-notes');
  if (!project_id) { toast('اختر المشروع أولاً', 'terr'); return; }
  if (!role_name)  { toast('اسم الدور مطلوب',  'terr'); return; }
  if (headcount_needed < 1) { toast('عدد المطلوبين 1 على الأقل', 'terr'); return; }

  const owning_committee_id = window.CURRENT_USER?.committee_id;
  if (!owning_committee_id) { toast('لا يمكن تحديد لجنتك', 'terr'); return; }

  const res = await api('opportunities.create', {
    data: {
      project_id, role_name,
      estimated_hours, headcount_needed,
      owning_committee_id,
      notes: notes || null,
    },
  });
  if (!res || !res.success) return;
  toast('✅ تم إنشاء الفرصة');
  // Reset + collapse form, refresh list.
  sv('hd-opp-role', '');
  sv('hd-opp-hours', '0');
  sv('hd-opp-headcount', '1');
  sv('hd-opp-notes', '');
  sv('hd-opp-project', '');
  document.getElementById('hd-opps-create-form').style.display = 'none';
  loadHeadOpportunities();
}
