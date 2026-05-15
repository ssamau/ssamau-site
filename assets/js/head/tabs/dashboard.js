// Head's dashboard tab — KPIs + pending queues.
//
// Single API call to `head.dashboardSummary` returns everything the
// page needs (committee meta, four KPI counts, top-5 pending
// applications, top-5 hours awaiting primary approval).

import { esc, fmtDate } from '../../lib/format.js';
import { api } from '../../lib/ui.js';

export async function loadDashboard() {
  const res = await api('head.dashboardSummary');
  if (!res || !res.success) {
    _renderError('تعذّر تحميل البيانات. تحقق من اتصالك وأعد المحاولة.');
    return;
  }
  const d = res.data || {};

  // Welcome strip — committee name + a small greeting using the user's
  // display name (already on window.CURRENT_USER from main.js).
  const greetingEl = document.getElementById('hd-greeting');
  const committeeEl = document.getElementById('hd-committee');
  if (greetingEl) {
    const name = window.CURRENT_USER?.name || 'رئيس اللجنة';
    greetingEl.textContent = `مرحباً، ${name}`;
  }
  if (committeeEl) {
    committeeEl.textContent = d.committee?.committee_name || '—';
  }

  // KPI cards.
  const c = d.counts || {};
  _setKpi('hd-kpi-members',       c.members_count);
  _setKpi('hd-kpi-applications',  c.pending_applications_count);
  _setKpi('hd-kpi-hours',         c.hours_pending_count);
  _setKpi('hd-kpi-opportunities', c.open_opportunities_count);

  // Applications list.
  const appsList = document.getElementById('hd-applications-list');
  if (appsList) {
    const apps = d.pending_applications || [];
    if (!apps.length) {
      appsList.innerHTML = '<div class="hd-empty">لا توجد طلبات بانتظار قرارك 🎉</div>';
    } else {
      appsList.innerHTML = apps.map(_renderApplicationRow).join('');
    }
  }

  // Hours list.
  const hoursList = document.getElementById('hd-hours-list');
  if (hoursList) {
    const hrs = d.hours_pending || [];
    if (!hrs.length) {
      hoursList.innerHTML = '<div class="hd-empty">لا توجد ساعات بانتظار اعتمادك ✅</div>';
    } else {
      hoursList.innerHTML = hrs.map(_renderHoursRow).join('');
    }
  }
}

function _setKpi(elId, n) {
  const el = document.getElementById(elId);
  if (el) el.textContent = (n == null ? '—' : String(n));
}

// One row in the pending-applications list. Click-through stays inside
// the head portal (#/head/applications), no admin.html jump.
function _renderApplicationRow(a) {
  const name = a.preferred_name || a.full_name || '—';
  // fmtDate already returns safe HTML; don't wrap in esc() or the <span>
  // shows up as literal text instead of formatting the date.
  const when = fmtDate(a.created_at) || '';
  const status = _appStatusLabel(a.status);
  return `<a class="hd-queue-row" href="#/head/applications" data-action="showPage" data-page="applications">
    <div class="hd-queue-main">
      <div class="hd-queue-title">${esc(name)}</div>
      <div class="hd-queue-sub">${esc(status)}${when ? ` · ${when}` : ''}</div>
    </div>
    <div class="hd-queue-action">قرّر ←</div>
  </a>`;
}

function _appStatusLabel(s) {
  return ({
    PendingTriage:         'بانتظار التوجيه',
    AssignedToCommittee:   'موجّه للجنتك',
    AwaitingInterview:     'بانتظار مقابلة',
  })[s] || s || '';
}

// One row in the hours-awaiting-primary-approval list.
function _renderHoursRow(h) {
  const name = h.member_preferred_name || h.member_full_name || '—';
  const proj = h.project_name || '—';
  const when = fmtDate(h.event_date || h.recorded_at) || '';
  const hours = h.total_hours != null ? `${h.total_hours} ساعة` : '';
  return `<a class="hd-queue-row" href="#/head/hours" data-action="showPage" data-page="hours">
    <div class="hd-queue-main">
      <div class="hd-queue-title">${esc(name)}</div>
      <div class="hd-queue-sub">${esc(proj)}${when ? ` · ${when}` : ''}</div>
    </div>
    <div class="hd-queue-action">${esc(hours)} ←</div>
  </a>`;
}

function _renderError(msg) {
  document.querySelectorAll('.hd-queue-list').forEach(el => {
    el.innerHTML = `<div class="hd-empty hd-empty-err">⚠️ ${esc(msg)}</div>`;
  });
}
