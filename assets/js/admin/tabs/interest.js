// Interest tab — members express interest in upcoming projects.
//
// Two loaders: `loadInterestAll` for the full set (the tab's default loader),
// and `loadInterest(pid)` for filtering by project from the dropdown. Both
// re-render the same table and update the same stats bar.

import { DB } from '../../lib/state.js';
import { esc, gv, tag, setEl } from '../../lib/format.js';
import { api, apiGet, toast, closeModal, populateNewSelects } from '../../lib/ui.js';

// ── INTEREST ─────────────────────────────────────────────────
export async function loadInterestAll() {
  const d = await apiGet('interest.listAll');
  if (!d || !d.success) return;
  DB.interest = d.data || [];
  renderInterest(DB.interest);
  updateIntStats(DB.interest);
  populateNewSelects();
}

export async function loadInterest(pid) {
  const d = pid
    ? await api('interest.list', { project_id: pid })
    : await apiGet('interest.listAll');
  if (!d) return;
  renderInterest(d.data || []);
  updateIntStats(d.data || []);
}

export function updateIntStats(list) {
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

export function renderInterest(list) {
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

export async function saveInterest() {
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

export function clearIntForm() {
  ['int-prj-sel','int-mbr-sel','int-cm'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
}
