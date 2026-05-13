// Certificates tab — list + issue + verify.
//
// Three sub-tabs share this page; switchCertTab toggles their .active class
// and re-populates the new-page selects when entering issue/verify so a
// freshly added project shows up without a full reload.
//
// previewCertCard opens a blank popup window and writes a self-contained
// HTML doc with the certificate template. Goes through a popup because
// users want to ⌘P to PDF and the print preview of an iframe inside the
// app would inherit the admin styles.

import { DB } from '../../lib/state.js';
import { esc, gv, tag } from '../../lib/format.js';
import { api, toast, closeModal, populateNewSelects } from '../../lib/ui.js';

// ── CERTIFICATES ─────────────────────────────────────────────
export async function loadCerts(pid) {
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

export function switchCertTab(tab) {
  ['list','issue','verify'].forEach((t, i) => {
    document.querySelectorAll('.tab-btn')[i]?.classList.toggle('active', t === tab);
    const el = document.getElementById('cert-tab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  if (tab === 'issue' || tab === 'verify') populateNewSelects();
}

export async function issueCert() {
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

export async function saveBulkCerts() {
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

export function buildCertHTML(c) {
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

export function previewCertCard(c) {
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

export async function verifyCert() {
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
