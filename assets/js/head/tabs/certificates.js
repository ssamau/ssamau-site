// Head Certificates tab — list / issue / bulk-issue / verify, scoped
// to the head's own committee on both the dropdowns and the server.
//
// `certs.list` auto-scopes for heads when called with no project_id.
// `certs.issue` and `certs.bulkIssue` enforce ensureProjectScope +
// ensureMemberScope server-side, so even a crafted request can't
// touch another committee's project. `certs.verify` is intentionally
// global (cert codes are unguessable; the verifier may not even be
// signed in — same flow public verifiers use).

import { esc, gv, sv, tag } from '../../lib/format.js';
import { api, apiGet, toast, closeModal } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

// Module state — same pattern as emails.js. Roster refreshed on tab
// entry; cert list also cached so re-renders are free.
let _members  = [];
let _projects = [];
let _certs    = [];

// ── LOAD ─────────────────────────────────────────────────────────────
export async function loadHeadCertificates() {
  await _ensureRoster();
  await _refreshCerts(gv('hd-flt-cert-prj'));
  _populateCertSelects();
}

async function _ensureRoster() {
  const myCommittee = window.CURRENT_USER?.committee_id;
  const [mRes, pRes] = await Promise.all([
    apiGet('getMembers'),
    apiGet('getProjects'),
  ]);
  _members  = (mRes?.data || []).filter(m => m.status !== 'Inactive' && (!myCommittee || m.committee_id === myCommittee));
  _projects = (pRes?.data || []).filter(p => !myCommittee || p.owning_committee_id === myCommittee);
}

async function _refreshCerts(projectId) {
  const res = await api('certs.list', projectId ? { project_id: projectId } : {});
  if (!res || !res.success) return;
  _certs = res.data || [];
  _render();
}

function _render() {
  const tb = document.getElementById('hd-tb-certs');
  if (!tb) return;
  if (!_certs.length) {
    tb.innerHTML = `<tr class="empty-row"><td colspan="7">${esc(t('ap.cert.empty'))}</td></tr>`;
    return;
  }
  const previewTitle = t('ap.cert.row_preview_title');
  tb.innerHTML = _certs.map(c => {
    const recipient   = c.recipient_name || c.member_preferred_name || c.member_full_name || '—';
    const projectName = c.project_name || c.project_id;
    return `<tr>
      <td><strong>${esc(recipient)}</strong></td>
      <td style="font-size:.76rem">${esc(projectName)}</td>
      <td>${tag(c.role || '—', 't-gr')}</td>
      <td><strong style="color:var(--g)">${c.hours || 0}</strong></td>
      <td><code style="font-size:.7rem;background:#f3f4f6;padding:.13rem .4rem;border-radius:4px;direction:ltr;display:inline-block">${esc(c.cert_code || '—')}</code></td>
      <td style="font-size:.71rem;color:var(--tm)">${String(c.issued_at || '').split('T')[0] || '—'}</td>
      <td><button class="btn-icon" data-action="hd.certs.preview" data-card="${JSON.stringify(c).replace(/"/g,'&quot;')}" title="${esc(previewTitle)}">👁️</button></td>
    </tr>`;
  }).join('');
}

// ── SELECT POPULATION ────────────────────────────────────────────────
function _populateCertSelects() {
  _fillProjectSelect('hd-flt-cert-prj',  true);
  _fillProjectSelect('hd-cert-proj-sel', false);
  _fillProjectSelect('hd-bcert-prj',     false);
  _fillMemberSelect('hd-cert-mbr-sel');
}

function _fillProjectSelect(id, includeAll) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const prev = sel.value;
  const opts = _projects.map(p => `<option value="${esc(p.project_id)}">${esc(p.project_name)}</option>`).join('');
  sel.innerHTML = includeAll
    ? `<option value="">${esc(t('ap.cert.filter_all_projects'))}</option>${opts}`
    : `<option value="">${esc(t('ap.prj.choose'))}</option>${opts}`;
  if (prev) sel.value = prev;
}

function _fillMemberSelect(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${esc(t('ap.prj.choose'))}</option>` +
    _members.map(m => `<option value="${esc(m.member_id)}">${esc(m.preferred_name || m.full_name)}</option>`).join('');
  if (prev) sel.value = prev;
}

// ── TAB SWITCH ───────────────────────────────────────────────────────
// The cert page has 3 sub-tabs (list / issue / verify). The active class
// pattern mirrors admin's switchCertTab — but our sub-tab containers
// carry the hd- prefix so they don't collide with the admin markup.
export function switchHeadCertTab(tab) {
  ['list','issue','verify'].forEach((name, i) => {
    document.querySelectorAll('#page-certificates .tab-btn')[i]?.classList.toggle('active', name === tab);
    const el = document.getElementById('hd-cert-tab-' + name);
    if (el) el.classList.toggle('active', name === tab);
  });
  if (tab === 'issue') _populateCertSelects();
}

// ── FILTERS ──────────────────────────────────────────────────────────
export function filterHeadCerts() {
  _refreshCerts(gv('hd-flt-cert-prj'));
}

// ── ACTIONS ──────────────────────────────────────────────────────────
export async function issueHeadCert() {
  const pid = gv('hd-cert-proj-sel');
  const mid = gv('hd-cert-mbr-sel');
  if (!pid || !mid) { toast(t('ap.cert.err_required'), 'twarn'); return; }
  const m = _members.find(mb => mb.member_id === mid);
  const recipient_email = m ? (m.email || '') : '';
  const recipient_name  = m ? (m.preferred_name || m.full_name) : '';
  if (!recipient_email) toast(t('ap.cert.warn_no_email'), 'twarn');
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
    _refreshCerts('');
    switchHeadCertTab('list');
  }
}

export async function bulkIssueHeadCerts() {
  const pid = gv('hd-bcert-prj');
  if (!pid) { toast(t('ap.eml.err_pick_project'), 'twarn'); return; }
  const r = await api('certs.bulkIssue', { project_id: pid, options: {} });
  if (r && r.success) {
    toast(t('ap.cert.bulk_result', { count: r.count || 0, emailed: r.emailed || 0 }));
    closeModal('hd-bulk-certs');
    _refreshCerts('');
    switchHeadCertTab('list');
  }
}

export async function verifyHeadCert() {
  const code = (document.getElementById('hd-verify-code-input')?.value || '').toUpperCase().trim();
  if (!code) { toast(t('ap.cert.verify_err_no_code'), 'twarn'); return; }
  const r = await api('certs.verify', { cert_code: code });
  const area = document.getElementById('hd-verify-result');
  if (!area) return;
  if (r && r.valid && r.certificate) {
    area.innerHTML = _buildCertHTML(r.certificate);
  } else {
    area.innerHTML = `<div style="background:var(--dnb);border:1.5px solid rgba(220,38,38,.25);border-radius:var(--rs);padding:1rem;font-size:.84rem;color:var(--dn);text-align:center">
      ❌ ${esc(localizeError(r?.error, r?.errorParams) || t('ap.cert.verify_invalid'))}
    </div>`;
  }
}

// ── PREVIEW + BUILDER ────────────────────────────────────────────────
// Duplicated from admin/tabs/certificates.js so the head bundle doesn't
// depend on admin code. Same CSP-friendly inline-style approach: every
// rule is a `style=` attr (not a <style> block) so the popup renders
// correctly under style-src 'self'.
function _fmtDate(d) { return d ? String(d).split('T')[0] : ''; }

function _buildCertHTML(c) {
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
    ${c.event_date ? `<div style="font-size:.78rem;color:rgba(255,255,255,.55)">بتاريخ: ${esc(_fmtDate(c.event_date))}</div>` : ''}
    ${c.hours ? `<div style="font-size:.78rem;color:rgba(255,255,255,.55);margin-top:.3rem">⏱️ ${c.hours} ساعة تطوعية</div>` : ''}
    <div style="margin-top:.85rem;background:rgba(255,255,255,.12);border-radius:8px;padding:.4rem 1rem;font-family:monospace;font-size:.78rem;letter-spacing:.1em">رمز التحقق: ${esc(code)}</div>
    <div style="font-size:.67rem;color:rgba(255,255,255,.35);margin-top:.5rem">للتحقق: ssamau.com/verify</div>
  </div>`;
}

export function previewHeadCertCard(c) {
  const w = window.open('','_blank','width=540,height=600');
  if (!w) { toast(t('ap.cert.popup_blocked'), 'twarn'); return; }
  const lang = (document.documentElement.lang === 'en') ? 'en' : 'ar';
  const dir  = lang === 'en' ? 'ltr' : 'rtl';
  const title = esc(t('ap.cert.preview_window_title'));
  w.document.write(`<!DOCTYPE html><html lang="${lang}" dir="${dir}"><head><meta charset="UTF-8"><title>${title}</title>
    <link href="https://fonts.googleapis.com/css2?family=Almarai:wght@400;700;800&display=swap" rel="stylesheet">
    </head><body style="margin:0;padding:2rem;background:#111;font-family:Almarai,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center">${_buildCertHTML(c)}</body></html>`);
  w.document.close();
}
