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

// ─── ATTENDANCE ──────────────────────────────────────────────────────
const recordAttendance: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const [r] = await sql`
    INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                            attendance_status, notes, recorded_by)
    VALUES (${data.project_id}, ${data.participant_id || null},
            ${data.member_id || null}, ${data.volunteer_email || null},
            ${data.attendance_status || 'Present'}, ${data.notes || null}, ${user!.id})
    RETURNING id
  ` as Array<{ id: number }>;
  return { id: r.id, attendance_id: r.id };
};

const attendanceBulkRecord: Handler = async (body, user) => {
  const project_id = body.project_id as string | undefined;
  const records = body.records as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(records) || records.length === 0) return { count: 0 };
  let count = 0;
  for (const r of records) {
    // Upsert by (project_id, participant_id) — last write wins.
    const existing = r.participant_id ? await sql`
      SELECT id FROM attendance
      WHERE project_id = ${project_id} AND participant_id = ${r.participant_id}
      ORDER BY recorded_at DESC LIMIT 1
    ` as Array<{ id: number }> : [];
    if (existing.length) {
      await sql`
        UPDATE attendance
        SET attendance_status = ${r.attendance_status},
            notes = ${r.notes || null},
            recorded_by = ${user!.id}
        WHERE id = ${existing[0].id}
      `;
    } else {
      await sql`
        INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                                attendance_status, notes, recorded_by)
        VALUES (${project_id}, ${r.participant_id || null},
                ${r.member_id || null}, ${r.volunteer_email || null},
                ${r.attendance_status}, ${r.notes || null}, ${user!.id})
      `;
    }
    count++;
  }
  return { count };
};

const attendanceList: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  return sql`
    SELECT a.id AS attendance_id, a.*,
           m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           p.project_name
    FROM attendance a
    LEFT JOIN members m  ON m.member_id  = a.member_id
    LEFT JOIN projects p ON p.project_id = a.project_id
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
  await sql`
    UPDATE attendance SET
      attendance_status = COALESCE(${data.attendance_status}, attendance_status),
      notes             = COALESCE(${data.notes},             notes)
    WHERE id = ${id}
  `;
  return { id };
};

export const attendanceActions: Record<string, Handler> = {
  'recordAttendance':       recordAttendance,
  'attendance.bulkRecord':  attendanceBulkRecord,
  'attendance.list':        attendanceList,
  'getAttendance':          getAttendance,
  'updateAttendance':       updateAttendance,
};
