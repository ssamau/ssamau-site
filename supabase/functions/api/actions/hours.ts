// Hours recording + two-stage approval handlers.
//
// Port of the HOURS + HOURS APPROVAL (§7) sections from
// netlify/functions/api.js (lines 599–759).
//
// Two-stage approval: committee head primary-approves Draft rows for
// opportunities owned by their committee; presidency final-approves
// PrimaryApproved rows. `members.total_hours` rollups count only
// FinalApproved rows — kept consistent via `recomputeMemberTotalHours()`
// at the bottom of this file, called after every mutation.

import { sql } from '../_sql.ts';
import {
  httpErr,
  requireAdminScope, requireAdmin,
  type Handler,
} from '../_helpers.ts';

// ─── HOURS ───────────────────────────────────────────────────────────
const recordHours: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const before = parseFloat(data.hours_before as string) || 0;
  const during = parseFloat(data.hours_during as string) || 0;
  const after  = parseFloat(data.hours_after  as string) || 0;

  // Principle 2 — when an assignment is provided we refuse to log hours
  // unless attendance was confirmed. Direct (no-assignment) hour entries
  // remain allowed for legacy/admin-correction cases.
  if (data.assignment_id) {
    const [a] = await sql`
      SELECT a.attendance_status, a.member_id AS a_member_id, a.volunteer_email AS a_volunteer_email,
             o.project_id AS o_project_id
      FROM assignments a
      JOIN opportunities o ON o.opportunity_id = a.opportunity_id
      WHERE a.assignment_id = ${data.assignment_id}
    ` as Array<{
      attendance_status: string; a_member_id: string | null;
      a_volunteer_email: string | null; o_project_id: string;
    }>;
    if (!a) throw httpErr('Assignment not found', 404);
    if (a.attendance_status !== 'Attended') {
      throw httpErr('Hours can only be recorded for assignments marked Attended (Principle 2).', 422);
    }
    // Backfill project_id / member from the assignment if the caller didn't supply them.
    if (!data.project_id)      data.project_id      = a.o_project_id;
    if (!data.member_id)       data.member_id       = a.a_member_id;
    if (!data.volunteer_email) data.volunteer_email = a.a_volunteer_email;
  }

  const [r] = await sql`
    INSERT INTO hours (project_id, assignment_id, member_id, volunteer_email, participant_type,
                       hours_before, hours_during, hours_after,
                       notes, recorded_by, recorded_by_member_id, approval_status)
    VALUES (${data.project_id}, ${data.assignment_id || null},
            ${data.member_id || null}, ${data.volunteer_email || null},
            ${data.participant_type || null},
            ${before}, ${during}, ${after},
            ${data.notes || null}, ${user!.id}, ${data.recorded_by_member_id || null},
            'Draft')
    RETURNING id, total_hours
  ` as Array<{ id: number; total_hours: number }>;
  await recomputeMemberTotalHours(data.member_id as string | null | undefined);
  return { id: r.id, hours_id: r.id, total_hours: r.total_hours };
};

// FIXES THE BUG: this action did not exist in Apps Script.
const updateHours: Handler = async (body) => {
  const id = body.id as number | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const [row] = await sql`SELECT member_id FROM hours WHERE id = ${id}` as Array<{ member_id: string | null }>;
  await sql`
    UPDATE hours SET
      hours_before = COALESCE(${data.hours_before}, hours_before),
      hours_during = COALESCE(${data.hours_during}, hours_during),
      hours_after  = COALESCE(${data.hours_after},  hours_after),
      notes        = COALESCE(${data.notes},        notes)
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row?.member_id);
  return { id };
};

// ─── HOURS APPROVAL (§7) ─────────────────────────────────────────────
// Two-stage approval: committee head primary-approves Draft rows for
// opportunities owned by their committee; presidency final-approves
// PrimaryApproved rows. `members.total_hours` rollups count only
// FinalApproved rows.
const hoursPrimaryApprove: Handler = async (body, user) => {
  const id = body.id as number | undefined;
  const [row] = await sql`
    SELECT h.id, h.member_id, h.approval_status, o.owning_committee_id
    FROM hours h
    LEFT JOIN assignments  a ON a.assignment_id = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    WHERE h.id = ${id}
  ` as Array<{
    id: number; member_id: string | null; approval_status: string;
    owning_committee_id: string | null;
  }>;
  if (!row) throw httpErr('Hours row not found', 404);
  if (row.approval_status !== 'Draft') {
    throw httpErr(`Cannot primary-approve a row in status ${row.approval_status}`, 409);
  }
  requireAdminScope(user, row.owning_committee_id);
  await sql`
    UPDATE hours SET
      approval_status     = 'PrimaryApproved',
      primary_approver_id = ${user!.id},
      primary_approved_at = NOW()
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row.member_id);
  return { id };
};

const hoursFinalApprove: Handler = async (body, user) => {
  requireAdmin(user);
  const id = body.id as number | undefined;
  const [row] = await sql`SELECT id, member_id, approval_status FROM hours WHERE id = ${id}` as Array<{
    id: number; member_id: string | null; approval_status: string;
  }>;
  if (!row) throw httpErr('Hours row not found', 404);
  if (row.approval_status !== 'PrimaryApproved') {
    throw httpErr(`Final approval requires PrimaryApproved (currently ${row.approval_status})`, 409);
  }
  await sql`
    UPDATE hours SET
      approval_status   = 'FinalApproved',
      final_approver_id = ${user.id},
      final_approved_at = NOW()
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row.member_id);
  return { id };
};

const hoursReject: Handler = async (body, user) => {
  const id = body.id as number | undefined;
  const reason = body.reason as string | undefined;
  const [row] = await sql`
    SELECT h.id, h.member_id, h.approval_status, o.owning_committee_id
    FROM hours h
    LEFT JOIN assignments  a ON a.assignment_id = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    WHERE h.id = ${id}
  ` as Array<{
    id: number; member_id: string | null; approval_status: string;
    owning_committee_id: string | null;
  }>;
  if (!row) throw httpErr('Hours row not found', 404);
  // Anyone in the approval chain can reject:
  //   - committee head can reject Draft rows in their committee
  //   - presidency can reject anything pre-FinalApproved
  //   - presidency can also reject FinalApproved (rolls it back)
  if (user!.access === 'head') {
    if (row.approval_status !== 'Draft') {
      throw httpErr('Committee heads can only reject Draft rows', 403);
    }
    requireAdminScope(user, row.owning_committee_id);
  } else if (user!.access !== 'superadmin') {
    throw httpErr('Forbidden', 403);
  }
  await sql`
    UPDATE hours SET
      approval_status = 'Rejected',
      rejected_reason = ${reason || null}
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row.member_id);
  return { id };
};

const getMemberHours: Handler = async (body) => {
  const member_id = body.member_id as string | undefined;
  const project_id = body.project_id as string | undefined;
  const approval_status = body.approval_status as string | undefined;
  return sql`
    SELECT h.id AS hours_id, h.*,
           p.project_name, p.event_date,
           m.full_name           AS member_full_name,
           m.preferred_name      AS member_preferred_name,
           o.role_name           AS opportunity_role_name,
           o.owning_committee_id AS opportunity_committee_id,
           pa.full_name          AS primary_approver_name,
           fa.full_name          AS final_approver_name
    FROM hours h
    LEFT JOIN projects     p  ON p.project_id     = h.project_id
    LEFT JOIN members      m  ON m.member_id      = h.member_id
    LEFT JOIN assignments  a  ON a.assignment_id  = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN users        upa ON upa.id          = h.primary_approver_id
    LEFT JOIN members      pa ON pa.member_id     = upa.member_id
    LEFT JOIN users        ufa ON ufa.id          = h.final_approver_id
    LEFT JOIN members      fa ON fa.member_id     = ufa.member_id
    WHERE (h.notes IS DISTINCT FROM 'Deleted')
      ${member_id       ? sql`AND h.member_id       = ${member_id}`       : sql``}
      ${project_id      ? sql`AND h.project_id      = ${project_id}`      : sql``}
      ${approval_status ? sql`AND h.approval_status = ${approval_status}` : sql``}
    ORDER BY h.recorded_at DESC
  `;
};

// Single source of truth for `members.total_hours`: sum of FinalApproved hours
// only. Everything that records/edits/approves hours must call this with the
// affected member_id (or no-op on null) so the cache stays consistent.
async function recomputeMemberTotalHours(member_id: string | null | undefined): Promise<void> {
  if (!member_id) return;
  await sql`
    UPDATE members SET total_hours = (
      SELECT COALESCE(SUM(total_hours), 0)
      FROM hours
      WHERE member_id = ${member_id}
        AND approval_status = 'FinalApproved'
    )
    WHERE member_id = ${member_id}
  `;
}

export const hoursActions: Record<string, Handler> = {
  'recordHours':           recordHours,
  'updateHours':           updateHours,
  'hours.primaryApprove':  hoursPrimaryApprove,
  'hours.finalApprove':    hoursFinalApprove,
  'hours.reject':          hoursReject,
  'getMemberHours':        getMemberHours,
};
