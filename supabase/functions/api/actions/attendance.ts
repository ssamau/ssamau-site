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

const recordAttendance: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const meetingHours = _parseMeetingHours(data.meeting_hours);
  const [r] = await sql`
    INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                            attendance_status, notes, recorded_by, checked_by_member_id,
                            meeting_hours)
    VALUES (${data.project_id}, ${data.participant_id || null},
            ${data.member_id || null}, ${data.volunteer_email || null},
            ${data.attendance_status || 'Present'}, ${data.notes || null}, ${user!.id},
            ${data.checked_by_member_id || null},
            ${meetingHours})
    RETURNING id
  ` as Array<{ id: number }>;
  // Recompute the cached member total so the new attendance hours appear
  // immediately in the member portal / admin views. No-op for volunteer
  // rows (member_id null) and for Present-without-hours rows alike — the
  // SQL inside recomputeMemberTotalHours filters meeting_hours IS NOT NULL.
  await recomputeMemberTotalHours(data.member_id as string | null);
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
    // Upsert by (project_id, participant_id) — last write wins.
    const existing = r.participant_id ? await sql`
      SELECT id FROM attendance
      WHERE project_id = ${project_id} AND participant_id = ${r.participant_id}
      ORDER BY recorded_at DESC LIMIT 1
    ` as Array<{ id: number }> : [];
    if (existing.length) {
      // meeting_hours is updated unconditionally — passing null clears
      // a previously-credited row (e.g. status flipped from Present to
      // Absent). COALESCE on checked_by_member_id stays the same so
      // re-saving a row without re-picking the checker preserves it.
      await sql`
        UPDATE attendance
        SET attendance_status    = ${r.attendance_status},
            notes                = ${r.notes || null},
            recorded_by          = ${user!.id},
            checked_by_member_id = COALESCE(${r.checked_by_member_id || null}, checked_by_member_id),
            meeting_hours        = ${meetingHours}
        WHERE id = ${existing[0].id}
      `;
    } else {
      await sql`
        INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                                attendance_status, notes, recorded_by, checked_by_member_id,
                                meeting_hours)
        VALUES (${project_id}, ${r.participant_id || null},
                ${r.member_id || null}, ${r.volunteer_email || null},
                ${r.attendance_status}, ${r.notes || null}, ${user!.id},
                ${r.checked_by_member_id || null},
                ${meetingHours})
      `;
    }
    if (r.member_id) touchedMembers.add(r.member_id as string);
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
const updateAttendance: Handler = async (body) => {
  const id = body.id as number | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  // Look up the member_id so we can recompute their total at the end —
  // even if this update happens to remove credited hours (e.g. status
  // flipped to Absent / Deleted), the recompute will scrub them.
  const before = (await sql`SELECT member_id FROM attendance WHERE id = ${id}`) as Array<{ member_id: string | null }>;
  // meeting_hours: only touched when the caller explicitly sends the
  // key — letting them clear hours by sending null/empty, OR leave
  // them alone by omitting the key. Using Object.hasOwn (not
  // `meeting_hours in data`) so we ignore prototype-chain hits.
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
  await recomputeMemberTotalHours(before[0]?.member_id ?? null);
  return { id };
};

export const attendanceActions: Record<string, Handler> = {
  'recordAttendance':       recordAttendance,
  'attendance.bulkRecord':  attendanceBulkRecord,
  'attendance.list':        attendanceList,
  'getAttendance':          getAttendance,
  'updateAttendance':       updateAttendance,
};
