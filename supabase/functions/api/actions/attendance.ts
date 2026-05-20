// Attendance handlers.
//
// Port of the ATTENDANCE section from netlify/functions/api.js
// (lines 528–598). All actions require auth (no public access).
// `attendance.bulkRecord` upserts by (project_id, participant_id) — last
// write wins. `updateAttendance` did not exist in the Apps Script
// version (annotated in the source as "FIXES THE BUG").

import { sql } from '../_sql.ts';
import {
  type Handler,
} from '../_helpers.ts';
import { recomputeMemberTotalHours } from './hours.ts';

// ─── ATTENDANCE ──────────────────────────────────────────────────────
// 2026-05-18: now writes `checked_by_member_id` — the club member who
// physically did the attendance check, distinct from `recorded_by`
// (the system user running the data-entry session). The admin form
// has always carried a "checked by" picker but the column didn't
// exist, so the audit-trail value was dropped on every save and the
// list view's "checked by" column rendered blank. Migration
// 20260518100001 added the column.
// `meeting_hours` (2026-05-20 fix for the president's "people attended but
// got no hours" report): rolls into members.total_hours via
// recomputeMemberTotalHours below. Same column the head-portal meeting form
// has always used — extending it to project attendance was the missing link.
// Parsed defensively so an empty string or non-numeric value falls back to
// null (no hours credited), matching the previous behaviour.
function _parseMeetingHours(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 24) return null;
  return n;
}

// 2026-05-21 (president's integrity ask): the `hours` table is the
// canonical audit trail of every credited hour. `attendance.meeting_hours`
// stays as a denormalized display cache, but the source of truth — what
// members.total_hours sums, what the SACM report exports, what the
// dashboard counts — is the linked `hours` row this helper maintains.
//
// Marker: `notes = 'auto:meeting:<attendance_id>'`. Same precedent as
// the existing `auto:head-attendance` rows from assignmentsMarkAttendance,
// but distinguishable so we can clean either category up independently.
//
// Three behaviours from one helper:
//   * status='Deleted' OR member_id NULL OR hours <= 0 → soft-delete
//     the linked row (notes='Deleted'). Keeps history; recompute won't
//     count it.
//   * existing linked row present → UPDATE hours_during/total + un-delete.
//   * no linked row yet → INSERT a fresh FinalApproved row.
//
// Heads have authority to credit meetings + project attendance, so the
// row enters FinalApproved with the recording user as both approver
// fields (mirrors auto:head-attendance).
const MEETING_HOURS_MARKER_PREFIX = 'auto:meeting:';
async function _syncMeetingHoursRow(opts: {
  attendance_id: number;
  member_id: string | null;
  project_id: string | null;
  meeting_hours: number | null;
  attendance_status: string;
  recorded_by: number;
}): Promise<void> {
  const marker = `${MEETING_HOURS_MARKER_PREFIX}${opts.attendance_id}`;
  const shouldHaveRow = opts.member_id
                     && opts.attendance_status !== 'Deleted'
                     && opts.meeting_hours != null
                     && opts.meeting_hours > 0;

  // Find an existing row for this attendance, if any. We check by marker
  // alone (not by member_id) so a row created for a member then
  // reassigned to someone else still gets cleaned up.
  const existing = await sql`
    SELECT id FROM hours WHERE notes = ${marker} LIMIT 1
  ` as Array<{ id: number }>;

  if (!shouldHaveRow) {
    // No credit should land. If we previously created one, soft-delete
    // it so the audit history shows the credit was created then removed.
    // Hard delete would be invisible — the president's integrity ask.
    if (existing.length) {
      await sql`UPDATE hours SET notes = 'Deleted' WHERE id = ${existing[0].id}`;
    }
    return;
  }

  if (existing.length) {
    // Update the linked row in place. Status stays FinalApproved; the
    // recording user re-stamps both approver slots so the audit shows
    // the most recent person responsible.
    await sql`
      UPDATE hours SET
        hours_during        = ${opts.meeting_hours},
        hours_before        = 0,
        hours_after         = 0,
        project_id          = ${opts.project_id},
        member_id           = ${opts.member_id},
        approval_status     = 'FinalApproved',
        notes               = ${marker},
        primary_approver_id = ${opts.recorded_by},
        primary_approved_at = NOW(),
        final_approver_id   = ${opts.recorded_by},
        final_approved_at   = NOW(),
        updated_at          = NOW()
      WHERE id = ${existing[0].id}
    `;
    return;
  }

  // No prior row — insert a fresh FinalApproved row carrying the marker.
  await sql`
    INSERT INTO hours (
      project_id, member_id, participant_type,
      hours_before, hours_during, hours_after,
      notes, recorded_by, approval_status,
      primary_approver_id, primary_approved_at,
      final_approver_id,   final_approved_at
    ) VALUES (
      ${opts.project_id}, ${opts.member_id}, 'Member',
      0, ${opts.meeting_hours}, 0,
      ${marker}, ${opts.recorded_by}, 'FinalApproved',
      ${opts.recorded_by}, NOW(),
      ${opts.recorded_by}, NOW()
    )
  `;
}

const recordAttendance: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const meetingHours = _parseMeetingHours(data.meeting_hours);
  const attendanceStatus = (data.attendance_status as string) || 'Present';
  const memberId = (data.member_id as string | null) || null;
  const projectId = (data.project_id as string | null) || null;
  const [r] = await sql`
    INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                            attendance_status, notes, recorded_by, checked_by_member_id,
                            meeting_hours)
    VALUES (${projectId}, ${data.participant_id || null},
            ${memberId}, ${data.volunteer_email || null},
            ${attendanceStatus}, ${data.notes || null}, ${user!.id},
            ${data.checked_by_member_id || null},
            ${meetingHours})
    RETURNING id
  ` as Array<{ id: number }>;
  // Sync the linked hours row (canonical credit lives in the hours
  // table — see the helper comment for the integrity rationale).
  await _syncMeetingHoursRow({
    attendance_id: r.id, member_id: memberId, project_id: projectId,
    meeting_hours: meetingHours, attendance_status: attendanceStatus,
    recorded_by: user!.id,
  });
  // Recompute the cached member total so the new attendance hours appear
  // immediately in the member portal / admin views.
  await recomputeMemberTotalHours(memberId);
  return { id: r.id, attendance_id: r.id };
};

const attendanceBulkRecord: Handler = async (body, user) => {
  const project_id = body.project_id as string | undefined;
  const records = body.records as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(records) || records.length === 0) return { count: 0 };
  // Collect member_ids touched so we can recompute their totals once at
  // the end — cheaper than recomputing on every row, and dedupes if the
  // same member appears more than once in the batch.
  const touchedMembers = new Set<string>();
  let count = 0;
  for (const r of records) {
    const meetingHours = _parseMeetingHours(r.meeting_hours);
    const attendanceStatus = r.attendance_status as string;
    const memberId = (r.member_id as string | null) || null;
    // Upsert by (project_id, participant_id) — last write wins.
    const existing = r.participant_id ? await sql`
      SELECT id FROM attendance
      WHERE project_id = ${project_id} AND participant_id = ${r.participant_id}
      ORDER BY recorded_at DESC LIMIT 1
    ` as Array<{ id: number }> : [];
    let attendanceId: number;
    if (existing.length) {
      // meeting_hours is updated unconditionally — passing null clears
      // a previously-credited row (e.g. status flipped from Present to
      // Absent). COALESCE on checked_by_member_id stays the same so
      // re-saving a row without re-picking the checker preserves it.
      await sql`
        UPDATE attendance
        SET attendance_status    = ${attendanceStatus},
            notes                = ${r.notes || null},
            recorded_by          = ${user!.id},
            checked_by_member_id = COALESCE(${r.checked_by_member_id || null}, checked_by_member_id),
            meeting_hours        = ${meetingHours}
        WHERE id = ${existing[0].id}
      `;
      attendanceId = existing[0].id;
    } else {
      const [ins] = await sql`
        INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                                attendance_status, notes, recorded_by, checked_by_member_id,
                                meeting_hours)
        VALUES (${project_id}, ${r.participant_id || null},
                ${memberId}, ${r.volunteer_email || null},
                ${attendanceStatus}, ${r.notes || null}, ${user!.id},
                ${r.checked_by_member_id || null},
                ${meetingHours})
        RETURNING id
      ` as Array<{ id: number }>;
      attendanceId = ins.id;
    }
    // Sync the linked hours row for THIS attendance entry. Done inside
    // the loop so each member's credit lands as its own audit row.
    await _syncMeetingHoursRow({
      attendance_id: attendanceId,
      member_id: memberId,
      project_id: project_id ?? null,
      meeting_hours: meetingHours,
      attendance_status: attendanceStatus,
      recorded_by: user!.id,
    });
    if (memberId) touchedMembers.add(memberId);
    count++;
  }
  // One recompute per affected member, regardless of how many of their
  // rows we touched in this batch. The function is idempotent and cheap
  // (two scans of small tables), but doing it once is still nicer.
  for (const mid of touchedMembers) {
    await recomputeMemberTotalHours(mid);
  }
  return { count };
};

const attendanceList: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  // recorded_by_username joins public.users so the admin list can show
  // who entered each row (separate concept from checked_by_member_id,
  // the member who physically did the check). Both fields are useful —
  // admin needs to know "who's on the hook for this data" (recorder)
  // distinct from "who confirmed it in person" (checker).
  //
  // recorded_by_member_name follows the same pattern as thanks.list: the
  // recorder's linked-member display name, so the UI shows "روان"
  // instead of "rawan". System accounts with no linked member fall back
  // to the username on the frontend.
  return sql`
    SELECT a.id AS attendance_id, a.*,
           m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           p.project_name, p.event_date AS project_event_date,
           u.username AS recorded_by_username,
           COALESCE(rm.preferred_name, rm.full_name) AS recorded_by_member_name
    FROM attendance a
    LEFT JOIN members m   ON m.member_id  = a.member_id
    LEFT JOIN projects p  ON p.project_id = a.project_id
    LEFT JOIN users u     ON u.id         = a.recorded_by
    LEFT JOIN members rm  ON rm.member_id = u.member_id
    WHERE ${project_id ? sql`a.project_id = ${project_id}` : sql`TRUE`}
      AND a.attendance_status <> 'Deleted'
    ORDER BY a.recorded_at DESC
  `;
};

const getAttendance: Handler = async (body, user) => attendanceList(body, user);

// FIXES THE BUG: this action did not exist in Apps Script.
const updateAttendance: Handler = async (body, user) => {
  const id = body.id as number | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (!id) return { id: null };
  // Look up the row so we can sync the linked hours row + recompute at
  // the end with the FINAL (post-update) values, regardless of which
  // fields the caller chose to send. Even an update that removes
  // credited hours (e.g. status flipped to Absent / Deleted) is
  // handled correctly because we re-read after the UPDATE.
  if (Object.hasOwn(data, 'meeting_hours')) {
    const newHours = _parseMeetingHours(data.meeting_hours);
    await sql`
      UPDATE attendance SET
        attendance_status = COALESCE(${data.attendance_status}, attendance_status),
        notes             = COALESCE(${data.notes},             notes),
        meeting_hours     = ${newHours}
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE attendance SET
        attendance_status = COALESCE(${data.attendance_status}, attendance_status),
        notes             = COALESCE(${data.notes},             notes)
      WHERE id = ${id}
    `;
  }
  // Re-read the row to get the post-update state, then sync the linked
  // hours row + recompute the affected member's cached total.
  const [after] = await sql`
    SELECT id, member_id, project_id, meeting_hours, attendance_status
    FROM attendance WHERE id = ${id}
  ` as Array<{
    id: number; member_id: string | null; project_id: string | null;
    meeting_hours: string | number | null; attendance_status: string;
  }>;
  if (after) {
    const hrs = after.meeting_hours == null ? null : Number(after.meeting_hours);
    await _syncMeetingHoursRow({
      attendance_id: after.id,
      member_id: after.member_id,
      project_id: after.project_id,
      meeting_hours: Number.isFinite(hrs) ? hrs as number : null,
      attendance_status: after.attendance_status,
      recorded_by: user!.id,
    });
    await recomputeMemberTotalHours(after.member_id);
  }
  return { id };
};

export const attendanceActions: Record<string, Handler> = {
  'recordAttendance':       recordAttendance,
  'attendance.bulkRecord':  attendanceBulkRecord,
  'attendance.list':        attendanceList,
  'getAttendance':          getAttendance,
  'updateAttendance':       updateAttendance,
};
