// SACM monthly hours report — exportable XLSX for the president to
// submit to the Saudi Cultural Mission (الملحقية الثقافية).
//
// Two sheets:
//   1. "إجمالي الساعات"  — one row per active member with their cached
//      total_hours, identity fields (name AR + EN, NID, DOB), committee,
//      club role, status, and join date. This is the row shape the SACM
//      end-of-year certificate verification asks for.
//   2. "تفصيل الساعات"   — one row per hours entry: FinalApproved rows
//      from the `hours` table PLUS attendance.meeting_hours rows. Same
//      union that powers the in-portal hours list (see getMemberHours
//      in supabase/functions/api/actions/hours.ts). The president can
//      audit any row in the summary by looking up the same member here.
//
// xlsx.mjs is lazy-loaded (876 KB) so the main bundle isn't penalized
// for users who never click this button. Loaded once, cached by the
// browser for the session.

import { DB } from '../../lib/state.js';
import { api, toast, withBusyButton } from '../../lib/ui.js';
import { t } from '../../lib/i18n.js';

let _xlsxModulePromise = null;
function _loadXlsx() {
  // Module-singleton cache so repeated clicks reuse the parsed module.
  if (!_xlsxModulePromise) {
    _xlsxModulePromise = import('../../vendor/xlsx.mjs');
  }
  return _xlsxModulePromise;
}

// Helper — committee name lookup with em-dash fallback so missing /
// not-yet-loaded committees don't blow the cell up.
function _committeeName(committee_id) {
  if (!committee_id) return '';
  const c = DB.committees.find(c => c.committee_id === committee_id);
  return c ? (c.committee_name || c.committee_id) : committee_id;
}

// fmt helpers — coerce nulls into empty strings so xlsx writes blank
// cells (not "null" text). Numbers stay as numbers so Excel can sum.
const _str = v => (v == null ? '' : String(v));
const _num = v => (v == null || v === '' ? 0 : Number(v) || 0);

export async function exportSacmReport(el) {
  return withBusyButton(el, '⏳ ' + t('common.loading'), async () => {
    // Fetch the unioned hours list (everyone, all sources) in parallel
    // with the xlsx module. getMemberHours with no filters returns
    // FinalApproved hours + attendance.meeting_hours unioned (see the
    // edge function). DB.members + DB.committees should already be
    // warm by the time an admin reaches the Hours tab.
    const [hoursRes, XLSX] = await Promise.all([
      api('getMemberHours'),
      _loadXlsx(),
    ]);
    if (!hoursRes || !hoursRes.success) {
      toast(t('ap.hrs.export_err'), 'terr');
      return;
    }
    const hoursRows = hoursRes.data || [];

    // ── Sheet 1: per-member summary ──────────────────────────────────
    // Only active members go in — Inactive accounts shouldn't show on
    // the SACM submission. Sort by total_hours desc so the highest
    // contributors lead the sheet.
    const activeMembers = (DB.members || [])
      .filter(m => m.status !== 'Inactive')
      .slice()
      .sort((a, b) => Number(b.total_hours || 0) - Number(a.total_hours || 0));

    // Count distinct projects each member has hours on (helps the
    // president see who showed up across multiple events vs one).
    const projectsByMember = new Map();
    for (const r of hoursRows) {
      if (!r.member_id) continue;
      if (!projectsByMember.has(r.member_id)) projectsByMember.set(r.member_id, new Set());
      const set = projectsByMember.get(r.member_id);
      set.add(r.project_id || r.meeting_title || '');
    }

    const summaryRows = activeMembers.map(m => ({
      'الاسم بالعربية':   _str(m.full_name),
      'الاسم بالإنجليزية': _str(m.name_en),
      'الهوية الوطنية':    _str(m.national_id),
      'تاريخ الميلاد':     _str(m.date_of_birth),
      'البريد':           _str(m.email),
      'الجوال':           _str(m.phone),
      'اللجنة':           _committeeName(m.committee_id),
      'الدور':            _str(m.club_role),
      'الحالة':           _str(m.status),
      'تاريخ الانضمام':    _str(m.join_date),
      'إجمالي الساعات':    _num(m.total_hours),
      'عدد المشاريع':     projectsByMember.get(m.member_id)?.size || 0,
    }));

    // ── Sheet 2: per-row hours detail ───────────────────────────────
    // Joins the member name + NID inline so each detail row stands on
    // its own (the SACM auditor doesn't have to cross-reference sheet 1).
    const memberById = new Map((DB.members || []).map(m => [m.member_id, m]));
    const detailRows = hoursRows
      .filter(r => r.member_id) // skip volunteer-email rows (no NID to match)
      .map(r => {
        const m = memberById.get(r.member_id);
        return {
          'الاسم':         _str(m?.full_name || r.member_full_name || r.member_id),
          'الهوية الوطنية':  _str(m?.national_id),
          'اللجنة':         _committeeName(m?.committee_id),
          'المشروع / اللقاء': _str(r.project_name || r.meeting_title || r.project_id || ''),
          'الدور':          _str(r.opportunity_role_name),
          'قبل':           _num(r.hours_before),
          'خلال':          _num(r.hours_during),
          'بعد':           _num(r.hours_after),
          'الإجمالي':       _num(r.total_hours),
          'الحالة':         _str(r.approval_status),
          'المصدر':        r.source === 'attendance'
                            ? 'حضور لقاء'
                            : 'ساعات معتمدة',
          'سُجِّل في':      _str(r.recorded_at),
        };
      });

    // ── Build workbook ──────────────────────────────────────────────
    const wb = XLSX.utils.book_new();
    // Workbook-level RTL flag so Excel opens both sheets right-to-left
    // by default. Excel honours this on .xlsx files.
    wb.Workbook = wb.Workbook || {};
    wb.Workbook.Views = [{ RTL: true }];

    const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
    const wsDetail  = XLSX.utils.json_to_sheet(detailRows);
    // Column widths — wide enough so Arabic names + emails aren't clipped.
    wsSummary['!cols'] = [
      { wch: 28 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 26 },
      { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 14 },
      { wch: 14 }, { wch: 12 },
    ];
    wsDetail['!cols'] = [
      { wch: 26 }, { wch: 14 }, { wch: 22 }, { wch: 36 }, { wch: 20 },
      { wch: 8 },  { wch: 8 },  { wch: 8 },  { wch: 12 }, { wch: 16 },
      { wch: 14 }, { wch: 22 },
    ];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'إجمالي الساعات');
    XLSX.utils.book_append_sheet(wb, wsDetail,  'تفصيل الساعات');

    // Filename: include YYYY-MM so the president can stack monthly
    // reports in the same folder without renaming.
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    XLSX.writeFile(wb, `SSAM-Hours-Report-${ym}.xlsx`);
    toast(t('ap.hrs.export_success'));
  });
}
