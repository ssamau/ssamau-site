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
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// ── CERTIFICATES ─────────────────────────────────────────────
export async function loadCerts(pid) {
  const d = await api('certs.list', { project_id: pid });
  if (!d) return;
  const list = d.data || [];
  const tb = document.getElementById('tb-certs');
  if (!tb) return;
  if (!list.length) { tb.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.cert.empty'))}</td></tr>`; return; }
  const previewTitle = t('ap.cert.row_preview_title');
  // The Edge Function backend returns the raw `certificates` table columns
  // via `c.*` (cert_code / recipient_name / role / hours / issued_at) plus
  // joined `member_full_name`, `member_preferred_name`, `project_name`.
  // The old Apps-Script payload used `participant_name` / `participation_role`
  // / `verify_code` — those names linger in some call sites; map carefully.
  tb.innerHTML = list.map(c => {
    const p = DB.projects.find(pr => pr.project_id === c.project_id);
    const recipient = c.recipient_name || c.member_preferred_name || c.member_full_name || '—';
    const projectName = c.project_name || (p ? p.project_name : c.project_id);
    return `<tr>
      <td><strong>${esc(recipient)}</strong></td>
      <td style="font-size:.76rem">${esc(projectName)}</td>
      <td>${tag(c.role || '—', 't-gr')}</td>
      <td><strong style="color:var(--g)">${c.hours || 0}</strong></td>
      <td><code style="font-size:.7rem;background:#f3f4f6;padding:.13rem .4rem;border-radius:4px;direction:ltr;display:inline-block">${esc(c.cert_code || '—')}</code></td>
      <td style="font-size:.71rem;color:var(--tm)">${String(c.issued_at || '').split('T')[0] || '—'}</td>
      <td><button class="btn-icon" data-action="previewCertCard" data-card="${JSON.stringify(c).replace(/"/g,'&quot;')}" title="${esc(previewTitle)}">👁️</button></td>
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
  if (!pid || !mid) { toast(t('ap.cert.err_required'), 'twarn'); return; }
  const m = DB.members.find(mb => mb.member_id === mid);
  // Edge Function `certs.issue` expects: recipient_name / recipient_email
  // / role / hours. The form was sending `participant_name` /
  // `participation_role` (older Apps-Script-era names) and never
  // supplied `recipient_email` — both columns landed NULL in the
  // certificates table and tryDeliverCert silently skipped the
  // delivery email. Fixed by aligning names + adding the email lookup
  // + pulling the member's FinalApproved hours sum so the cert shows
  // a real number, not always 0.
  const recipient_email = m ? (m.email || '') : '';
  const recipient_name  = m ? (m.preferred_name || m.full_name) : '';
  if (!recipient_email) {
    toast(t('ap.cert.warn_no_email'), 'twarn');
    // Still proceed — the cert row + verification page work without
    // the email. Admin can hand over the cert code manually.
  }
  const r = await api('certs.issue', {
    project_id:      pid,
    member_id:       mid,
    recipient_name,
    recipient_email,
    role:            t('ap.cert.default_role'),
    hours:           m ? (m.total_hours || 0) : 0,
  });
  if (r && r.success) {
    toast(recipient_email ? t('ap.cert.success_issue_emailed') : t('ap.cert.success_issue_no_email'));
    loadCerts('');
    switchCertTab('list');
  }
}

export async function saveBulkCerts() {
  const pid = gv('bcert-prj');
  if (!pid) { toast(t('ap.eml.err_pick_project'), 'twarn'); return; }
  const r = await api('certs.bulkIssue', { project_id: pid, options: {} });
  // Backend returns { count, emailed }. count = certs created (the SQL
  // filter excludes participants who already have a cert for this project,
  // so we don't need a separate "skipped" tally to surface here).
  if (r && r.success) {
    toast(t('ap.cert.bulk_result', { count: r.count || 0, emailed: r.emailed || 0 }));
    closeModal('bulk-certs');
    loadCerts('');
    switchCertTab('list');
  }
}

// Strip the time portion off an ISO timestamp so cert footers show
// "2026-05-29" instead of "2026-05-29T00:00:00.000Z". Tolerates plain
// "YYYY-MM-DD" strings (passes them through) and falsy values (returns '').
function fmtDate(d) {
  if (!d) return '';
  return String(d).split('T')[0];
}

export function buildCertHTML(c) {
  // Map both old and new field names so this same builder works for
  // certs.list rows AND certs.verify rows. New backend uses
  // recipient_name / role / cert_code; old payload used
  // participant_name / participation_role / verify_code.
  //
  // All styling is inline `style=` attributes (not classes). The popup
  // version of this HTML is rendered via document.write into a popup that
  // inherits the opener's CSP, which has `style-src 'self'` (blocks
  // <style> blocks) but `style-src-attr 'unsafe-inline'` (permits inline
  // style attrs). Going attr-only keeps the popup looking right under
  // CSP — the previous version dropped to white-on-white because the
  // entire <style> block was blocked.
  const recipient = c.recipient_name || c.participant_name || c.member_preferred_name || c.member_full_name || c.volunteer_email || '—';
  const code      = c.cert_code      || c.verify_code      || '—';
  return `<div style="background:linear-gradient(135deg,#0e3a1c 0%,#1e5f35 60%,#B8932A 100%);border-radius:12px;padding:1.75rem;color:#fff;text-align:center;max-width:440px;margin:0 auto">
    <div style="font-size:2rem;margin-bottom:.7rem">🌿</div>
    <div style="font-size:.7rem;color:rgba(255,255,255,.5);letter-spacing:.1em;text-transform:uppercase;margin-bottom:.4rem">شهادة تطوع</div>
    <div style="font-size:1rem;font-weight:800">Saudi Students Association in Melbourne</div>
    <div style="font-size:.75rem;color:rgba(255,255,255,.5);margin:.2rem 0 .75rem">نادي الطلبة السعوديين في ملبورن</div>
    <div style="font-size:.8rem;color:rgba(255,255,255,.6)">يُشهد بأن</div>
    <div style="font-size:1rem;font-weight:800;color:#c9a032;margin:.6rem 0 .2rem">${esc(recipient)}</div>
    <div style="font-size:.85rem;color:rgba(255,255,255,.7);margin-top:.2rem">شارك في: ${esc(c.project_name || c.project_id || '—')}</div>
    ${c.event_date ? `<div style="font-size:.78rem;color:rgba(255,255,255,.55)">بتاريخ: ${esc(fmtDate(c.event_date))}</div>` : ''}
    ${c.hours ? `<div style="font-size:.78rem;color:rgba(255,255,255,.55);margin-top:.3rem">⏱️ ${c.hours} ساعة تطوعية</div>` : ''}
    <div style="margin-top:.85rem;background:rgba(255,255,255,.12);border-radius:8px;padding:.4rem 1rem;font-family:monospace;font-size:.78rem;letter-spacing:.1em">رمز التحقق: ${esc(code)}</div>
    <div style="font-size:.67rem;color:rgba(255,255,255,.35);margin-top:.5rem">للتحقق: ssamau.com/verify</div>
  </div>`;
}

export function previewCertCard(c) {
  const w = window.open('','_blank','width=540,height=600');
  if (!w) { toast(t('ap.cert.popup_blocked'), 'twarn'); return; }
  // No <style> block here — CSP `style-src 'self'` (inherited by the
  // about:blank popup in Chromium) blocks inline <style> contents. All
  // styles live as `style=` attrs on individual elements, which fall
  // under `style-src-attr 'unsafe-inline'` and render correctly.
  //
  // The popup chrome (lang/dir/title) follows the admin UI language so
  // the browser tab + scrollbar direction match the rest of the app;
  // the certificate body itself stays bilingual (Arabic + English brand)
  // by design — see the buildCertHTML comment for the rationale.
  const lang = (document.documentElement.lang === 'en') ? 'en' : 'ar';
  const dir  = lang === 'en' ? 'ltr' : 'rtl';
  const title = esc(t('ap.cert.preview_window_title'));
  w.document.write(`<!DOCTYPE html><html lang="${lang}" dir="${dir}"><head><meta charset="UTF-8"><title>${title}</title>
    <link href="https://fonts.googleapis.com/css2?family=Almarai:wght@400;700;800&display=swap" rel="stylesheet">
    </head><body style="margin:0;padding:2rem;background:#111;font-family:Almarai,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">${buildCertHTML(c)}</body></html>`);
  w.document.close();
}

export async function verifyCert() {
  const code = (document.getElementById('verify-code-input')?.value || '').toUpperCase().trim();
  if (!code) { toast(t('ap.cert.verify_err_no_code'), 'twarn'); return; }
  // Backend param is `cert_code` (not `code`); response shape is
  // { valid, certificate }. The certificate row already includes
  // `project_name` from the LEFT JOIN, so no extra mapping needed.
  const r = await api('certs.verify', { cert_code: code });
  const area = document.getElementById('verify-result');
  if (!area) return;
  if (r && r.valid && r.certificate) {
    area.innerHTML = buildCertHTML(r.certificate);
  } else {
    area.innerHTML = `<div style="background:var(--dnb);border:1.5px solid rgba(220,38,38,.25);border-radius:var(--rs);padding:1rem;font-size:.84rem;color:var(--dn);text-align:center">
      ❌ ${esc(localizeError(r?.error, r?.errorParams) || t('ap.cert.verify_invalid'))}
    </div>`;
  }
}
