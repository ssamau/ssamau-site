// Handover lock banner (2026-07-27).
//
// Shown on every portal (admin / head / member) when the system is
// locked for committee handover, so users know why writes are frozen.
// Injected + styled inline (CSP allows inline style attributes). The
// lock state comes from the public system.getLockState action.

import { apiGet } from './ui.js';
import { t } from './i18n.js';

const BANNER_ID = 'handover-banner';

function _ensureBanner() {
  let el = document.getElementById(BANNER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.style.cssText =
      'position:sticky;top:0;left:0;right:0;z-index:99999;background:#7a1420;color:#fff;' +
      'text-align:center;padding:.55rem 1rem;font-weight:700;font-size:.82rem;' +
      'box-shadow:0 2px 6px rgba(0,0,0,.2)';
    document.body.prepend(el);
  }
  return el;
}

export async function refreshHandoverBanner() {
  let locked = false;
  try {
    const res = await apiGet('system.getLockState');
    locked = !!(res && res.success && res.data && res.data.locked);
  } catch (_e) {
    return; // never break a portal because the banner check failed
  }
  const existing = document.getElementById(BANNER_ID);
  if (locked) {
    const el = _ensureBanner();
    el.textContent = '🔒 ' + t('common.handover_banner');
    el.style.display = '';
  } else if (existing) {
    existing.style.display = 'none';
  }
}

// Re-render the label on language toggle if the banner is visible.
export function initHandoverBanner() {
  refreshHandoverBanner();
  window.addEventListener('ssam-lang-changed', () => {
    const el = document.getElementById(BANNER_ID);
    if (el && el.style.display !== 'none') el.textContent = '🔒 ' + t('common.handover_banner');
  });
}
