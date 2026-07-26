// Handover tab (2026-07-27) — full-data export + system lock/unlock.
//
// The lock freezes every write across the whole API (enforced server-side
// in the Edge Function dispatcher), so it also blocks iOS. Lock + unlock
// require typing a GitHub-style confirmation phrase (same phrase for
// both). Export builds a multi-sheet .xlsx client-side from a JSON dump.

import { esc, gv, sv } from '../../lib/format.js';
import { api, apiGet, toast } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';
import { localizeError } from '../../lib/api.js';

let _phrase = '';

export async function loadHandover() {
  const res = await apiGet('system.getLockState');
  const st = (res && res.success) ? res.data : { locked: false };
  _phrase = st.confirm_phrase || '';
  _renderStatus(st);
}

function _renderStatus(st) {
  const el = document.getElementById('handover-status');
  if (el) {
    if (st.locked) {
      const when = st.locked_at ? String(st.locked_at).split('T')[0] : '';
      const who  = st.locked_by_name ? ` · ${esc(st.locked_by_name)}` : '';
      el.innerHTML = `<div style="background:var(--dnb,#fbeaea);border:1px solid rgba(180,20,30,.35);border-radius:8px;padding:.8rem;font-weight:700;color:var(--dn,#9b1c1c)">
        🔒 ${esc(t('ap.handover.status_locked'))}${when ? ` — ${esc(when)}` : ''}${who}</div>`;
    } else {
      el.innerHTML = `<div style="background:var(--okb,#e7f4ea);border:1px solid rgba(20,120,60,.3);border-radius:8px;padding:.8rem;font-weight:700;color:var(--g,#1a5c2e)">
        🔓 ${esc(t('ap.handover.status_unlocked'))}</div>`;
    }
  }
  const lockBtn = document.getElementById('handover-lock-btn');
  const unlockBtn = document.getElementById('handover-unlock-btn');
  if (lockBtn)   lockBtn.style.display   = st.locked ? 'none' : '';
  if (unlockBtn) unlockBtn.style.display = st.locked ? '' : 'none';
}

// ── Export all data → .xlsx ──────────────────────────────────────────
export async function exportAllData() {
  const btn = document.getElementById('handover-export-btn');
  const restore = t('ap.handover.export_btn');
  if (btn) { btn.disabled = true; btn.textContent = t('common.loading'); }
  try {
    const res = await api('system.exportAll', {});
    if (!res || !res.success) {
      toast(localizeError(res?.error, res?.errorParams) || t('common.generic_error'), 'twarn');
      return;
    }
    const XLSX = await import('../../lib/vendor/xlsx.mjs');
    const wb = XLSX.utils.book_new();
    const tables = res.data?.tables || {};
    for (const [name, rows] of Object.entries(tables)) {
      const data = Array.isArray(rows) && rows.length ? rows : [{ '—': '' }];
      const ws = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    }
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const date = (res.data?.exported_at || '').split('T')[0] || 'export';
    _download(blob, `SSAM_Full_Export_${date}.xlsx`);
    toast(t('ap.handover.export_done'), 'tok');
  } catch (e) {
    toast(t('common.generic_error'), 'twarn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = restore; }
  }
}

function _download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── Lock / unlock (type-to-confirm) ──────────────────────────────────
export function openLockModal() {
  sv('handover-confirm-input', '');
  const lbl = document.getElementById('handover-confirm-phrase-label');
  if (lbl) lbl.textContent = _phrase;
  const btn = document.getElementById('handover-confirm-btn');
  if (btn) btn.disabled = true;
  document.getElementById('ov-handover-lock')?.classList.add('open');
}

export function openUnlockModal() {
  sv('handover-unlock-input', '');
  const lbl = document.getElementById('handover-unlock-phrase-label');
  if (lbl) lbl.textContent = _phrase;
  const btn = document.getElementById('handover-unlock-confirm-btn');
  if (btn) btn.disabled = true;
  document.getElementById('ov-handover-unlock')?.classList.add('open');
}

export function closeHandoverModals() {
  document.getElementById('ov-handover-lock')?.classList.remove('open');
  document.getElementById('ov-handover-unlock')?.classList.remove('open');
}

export function onLockConfirmInput() {
  const btn = document.getElementById('handover-confirm-btn');
  if (btn) btn.disabled = ((gv('handover-confirm-input') || '').trim() !== _phrase);
}
export function onUnlockConfirmInput() {
  const btn = document.getElementById('handover-unlock-confirm-btn');
  if (btn) btn.disabled = ((gv('handover-unlock-input') || '').trim() !== _phrase);
}

export async function confirmLock() {
  const res = await api('system.lock', { confirm: (gv('handover-confirm-input') || '').trim() });
  if (!res || !res.success) {
    toast(localizeError(res?.error, res?.errorParams) || t('common.generic_error'), 'twarn');
    return;
  }
  closeHandoverModals();
  toast(t('ap.handover.locked_toast'), 'tok');
  await loadHandover();
  const m = await import('../../lib/handover-banner.js');
  m.refreshHandoverBanner();
}

export async function confirmUnlock() {
  const res = await api('system.unlock', { confirm: (gv('handover-unlock-input') || '').trim() });
  if (!res || !res.success) {
    toast(localizeError(res?.error, res?.errorParams) || t('common.generic_error'), 'twarn');
    return;
  }
  closeHandoverModals();
  toast(t('ap.handover.unlocked_toast'), 'tok');
  await loadHandover();
  const m = await import('../../lib/handover-banner.js');
  m.refreshHandoverBanner();
}
