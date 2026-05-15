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
  requireAuth, requireAdminScope,
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

  // Phase D — advisor support. recordHours now accepts advisor_id as
  // an alternative to member_id / volunteer_email. The Edge Function
  // enforces "exactly one" at the application layer (no DB CHECK,
  // since legacy rows might violate it). participant_type='advisor'
  // is the convention; for ergonomics we default it when advisor_id
  // is present and the caller didn't specify.
  const advisor_id = data.advisor_id ? Number(data.advisor_id) : null;
  if (advisor_id) {
    if (data.member_id || data.volunteer_email) {
      throw httpErr('Provide only one of advisor_id, member_id, or volunteer_email.', 422);
    }
    if (!data.participant_type) data.participant_type = 'advisor';
  }

  const [r] = await sql`
    INSERT INTO hours (project_id, assignment_id, member_id, volunteer_email, advisor_id,
                       participant_type, hours_before, hours_during, hours_after,
                       notes, recorded_by, recorded_by_member_id, approval_status)
    VALUES (${data.project_id}, ${data.assignment_id || null},
            ${data.member_id || null}, ${data.volunteer_email || null}, ${advisor_id},
            ${data.participant_type || null},
            ${before}, ${during}, ${after},
            ${data.notes || null}, ${user!.id}, ${data.recorded_by_member_id || null},
            'Draft')
    RETURNING id, total_hours
  ` as Array<{ id: number; total_hours: number }>;
  await recomputeMemberTotalHours(data.member_id as string | null | undefined);
  await recomputeAdvisorTotalHours(advisor_id);
  return { id: r.id, hours_id: r.id, total_hours: r.total_hours };
};

// FIXES THE BUG: this action did not exist in Apps Script.
const updateHours: Handler = async (body) => {
  const id = body.id as number | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const [row] = await sql`SELECT member_id, advisor_id FROM hours WHERE id = ${id}` as Array<{ member_id: string | null; advisor_id: number | null }>;
  await sql`
    UPDATE hours SET
      hours_before = COALESCE(${data.hours_before}, hours_before),
      hours_during = COALESCE(${data.hours_during}, hours_during),
      hours_after  = COALESCE(${data.hours_after},  hours_after),
      notes        = COALESCE(${data.notes},        notes)
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row?.member_id);
  await recomputeAdvisorTotalHours(row?.advisor_id);
  return { id };
};

// ─── HOURS APPROVAL (§7) ─────────────────────────────────────────────
// Two-stage approval, both stages now belonging to the head tier
// (Committee Head / Committee Vice Head / Deputy Vice Head — all
// scoped to their own committee). Per the 2026-05-16 president
// clarification: final approval also lives with heads, not presidency,
// "so the role of head means something". Presidency keeps unscoped
// override access via requireAdminScope's admin/superadmin bypass.
// `members.total_hours` rollups count only FinalApproved rows.
//
// Committee resolution: prefer the opportunity's owning_committee_id;
// fall back to the member's committee_id when the row was self-recorded
// without an assignment (rare — Principle 2 normally blocks this, but
// defensive coverage avoids a null-committee escape hatch).
const hoursPrimaryApprove: Handler = async (body, user) => {
  const id = body.id as number | undefined;
  const [row] = await sql`
    SELECT h.id, h.member_id, h.advisor_id, h.approval_status,
           COALESCE(o.owning_committee_id, m.committee_id) AS committee_id
    FROM hours h
    LEFT JOIN assignments  a ON a.assignment_id = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN members      m ON m.member_id      = h.member_id
    WHERE h.id = ${id}
  ` as Array<{
    id: number; member_id: string | null; advisor_id: number | null;
    approval_status: string; committee_id: string | null;
  }>;
  if (!row) throw httpErr('Hours row not found', 404);
  if (row.approval_status !== 'Draft') {
    throw httpErr(`Cannot primary-approve a row in status ${row.approval_status}`, 409);
  }
  requireAdminScope(user, row.committee_id);
  await sql`
    UPDATE hours SET
      approval_status     = 'PrimaryApproved',
      primary_approver_id = ${user!.id},
      primary_approved_at = NOW()
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row.member_id);
  await recomputeAdvisorTotalHours(row.advisor_id);
  return { id };
};

const hoursFinalApprove: Handler = async (body, user) => {
  const id = body.id as number | undefined;
  const [row] = await sql`
    SELECT h.id, h.member_id, h.advisor_id, h.approval_status,
           COALESCE(o.owning_committee_id, m.committee_id) AS committee_id
    FROM hours h
    LEFT JOIN assignments  a ON a.assignment_id = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN members      m ON m.member_id      = h.member_id
    WHERE h.id = ${id}
  ` as Array<{
    id: number; member_id: string | null; advisor_id: number | null;
    approval_status: string; committee_id: string | null;
  }>;
  if (!row) throw httpErr('Hours row not found', 404);
  if (row.approval_status !== 'PrimaryApproved') {
    throw httpErr(`Final approval requires PrimaryApproved (currently ${row.approval_status})`, 409);
  }
  requireAdminScope(user, row.committee_id);
  await sql`
    UPDATE hours SET
      approval_status   = 'FinalApproved',
      final_approver_id = ${user!.id},
      final_approved_at = NOW()
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row.member_id);
  await recomputeAdvisorTotalHours(row.advisor_id);
  return { id };
};

const hoursReject: Handler = async (body, user) => {
  const id = body.id as number | undefined;
  const reason = body.reason as string | undefined;
  const [row] = await sql`
    SELECT h.id, h.member_id, h.advisor_id, h.approval_status,
           COALESCE(o.owning_committee_id, m.committee_id) AS committee_id
    FROM hours h
    LEFT JOIN assignments  a ON a.assignment_id = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN members      m ON m.member_id      = h.member_id
    WHERE h.id = ${id}
  ` as Array<{
    id: number; member_id: string | null; advisor_id: number | null;
    approval_status: string; committee_id: string | null;
  }>;
  if (!row) throw httpErr('Hours row not found', 404);
  // Anyone with admin scope over the row's committee can reject at any
  // stage — including rolling back a FinalApproved row. Heads now own
  // the full approval chain for their committee so they also own the
  // ability to retract.
  requireAdminScope(user, row.committee_id);
  await sql`
    UPDATE hours SET
      approval_status = 'Rejected',
      rejected_reason = ${reason || null}
    WHERE id = ${id}
  `;
  await recomputeMemberTotalHours(row.member_id);
  await recomputeAdvisorTotalHours(row.advisor_id);
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

// Mirror of recomputeMemberTotalHours, but for advisor totals (Phase D).
// Every hours-mutation handler calls this alongside the member version so
// whichever participant the row references gets its cache rebuilt.
async function recomputeAdvisorTotalHours(advisor_id: number | null | undefined): Promise<void> {
  if (!advisor_id) return;
  await sql`
    UPDATE advisors SET total_hours = (
      SELECT COALESCE(SUM(total_hours), 0)
      FROM hours
      WHERE advisor_id = ${advisor_id}
        AND approval_status = 'FinalApproved'
    )
    WHERE id = ${advisor_id}
  `;
}

// Self-service hours recording — member portal (Phase 5 of Branch 4).
//
// Lets a member log hours for one of THEIR OWN assignments, provided the
// assignment was marked `Attended` (Principle 2, same rule the admin
// recordHours enforces). The row enters at `Draft` so it flows through
// the same two-stage approval the requirements doc §7 describes:
//
//   Draft  →  (committee head)        →  PrimaryApproved
//          →  (presidency)            →  FinalApproved   → counts
//
// Differences from `recordHours`:
//   - Hard-scoped to the caller. The assignment row is verified to
//     belong to user.member_id; passing someone else's assignment_id
//     returns 404. No ability for a member to log hours on behalf of
//     another member (that's still the admin's job).
//   - assignment_id is REQUIRED. Members can't log free-form hours
//     unattached to an assignment — the requirements doc only blesses
//     hours that come from an attended assignment.
//   - One row per (member, assignment). Re-submitting on an assignment
//     that already has a member-recorded hours row throws 409 — the
//     member should ask their committee head to edit if they need to
//     fix a number. (Admins editing on behalf of members still use the
//     existing updateHours path.)
const hoursRecordOwn: Handler = async (body, user) => {
  requireAuth(user);
  if (!user.member_id) throw httpErr('No member profile linked to this account.', 404);
  const data = (body.data ?? body) as Record<string, unknown>;
  const assignment_id = data.assignment_id as string | undefined;
  if (!assignment_id) throw httpErr('assignment_id is required', 400);

  const [a] = await sql`
    SELECT a.assignment_id, a.member_id, a.attendance_status,
           o.project_id AS o_project_id
    FROM assignments a
    JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    WHERE a.assignment_id = ${assignment_id}
  ` as Array<{
    assignment_id: string; member_id: string | null;
    attendance_status: string; o_project_id: string;
  }>;
  if (!a) throw httpErr('Assignment not found', 404);
  // Server-side self-scope: the assignment must belong to the caller.
  // Without this a member could pass a stranger's assignment_id and
  // log hours into their record.
  if (a.member_id !== user.member_id) {
    throw httpErr('Assignment does not belong to this member.', 403);
  }
  // Principle 2 — only attended assignments earn hours.
  if (a.attendance_status !== 'Attended') {
    throw httpErr('Hours can only be recorded for assignments marked Attended (Principle 2).', 422);
  }
  // One self-submission per assignment. Members fix mistakes via their
  // committee head — keeping the audit trail clean is more important
  // than self-service edits, which would also need a "can't edit after
  // primary-approved" check that the admin path already owns.
  const [existing] = await sql`
    SELECT id FROM hours WHERE assignment_id = ${assignment_id} LIMIT 1
  ` as Array<{ id: number }>;
  if (existing) {
    throw httpErr('Hours already recorded for this assignment. Ask a committee head to edit if needed.', 409);
  }

  const before = parseFloat(data.hours_before as string) || 0;
  const during = parseFloat(data.hours_during as string) || 0;
  const after  = parseFloat(data.hours_after  as string) || 0;
  if (before + during + after <= 0) {
    throw httpErr('Total hours must be greater than zero.', 422);
  }

  const [r] = await sql`
    INSERT INTO hours (project_id, assignment_id, member_id, participant_type,
                       hours_before, hours_during, hours_after,
                       notes, recorded_by, recorded_by_member_id, approval_status)
    VALUES (${a.o_project_id}, ${assignment_id}, ${user.member_id}, 'member',
            ${before}, ${during}, ${after},
            ${data.notes || null}, ${user.id}, ${user.member_id},
            'Draft')
    RETURNING id, total_hours
  ` as Array<{ id: number; total_hours: number }>;
  // No recomputeMemberTotalHours() call — Draft rows don't count toward
  // the total. The recompute fires when the head primary-approves and
  // again when presidency final-approves (see hoursPrimaryApprove /
  // hoursFinalApprove above).
  return { id: r.id, hours_id: r.id, total_hours: r.total_hours };
};

// Self-service hours listing — member portal (Phase 5 of Branch 4).
// Same row shape as getMemberHours so the renderer is reusable, but
// hard-filtered to user.member_id so a member can't see anyone else's
// rows. Auth-gated only — heads/admins can also call this for their
// own data on their own portal, which is correct.
const hoursListOwn: Handler = async (_body, user) => {
  requireAuth(user);
  if (!user.member_id) throw httpErr('No member profile linked to this account.', 404);
  return sql`
    SELECT h.id AS hours_id, h.*,
           p.project_name, p.event_date,
           o.role_name AS opportunity_role_name
    FROM hours h
    LEFT JOIN projects     p  ON p.project_id     = h.project_id
    LEFT JOIN assignments  a  ON a.assignment_id  = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    WHERE h.member_id = ${user.member_id}
      AND (h.notes IS DISTINCT FROM 'Deleted')
    ORDER BY h.recorded_at DESC
  `;
};

export const hoursActions: Record<string, Handler> = {
  'recordHours':           recordHours,
  'updateHours':           updateHours,
  'hours.primaryApprove':  hoursPrimaryApprove,
  'hours.finalApprove':    hoursFinalApprove,
  'hours.reject':          hoursReject,
  'getMemberHours':        getMemberHours,
  'hours.listOwn':         hoursListOwn,
  'hours.recordOwn':       hoursRecordOwn,
};
