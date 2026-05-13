// Dashboard tab — landing page after login.
//
// Pulls the aggregate stats blob from the server (`getDashboardStats`) and
// paints four KPI cards, the top-volunteer leaderboard, the per-committee
// hours-bar chart, and a small "recent projects" table. Nothing here mutates
// DB — the dashboard renders straight from the response so we don't have to
// reconcile it with whatever the individual tabs have already cached.

import { STATUS_COLORS } from '../../lib/state.js';
import { esc, fmtDate, tag } from '../../lib/format.js';
import { apiGet, setApiStatus } from '../../lib/ui.js';

// ══════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════
export async function loadDashboard() {
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
