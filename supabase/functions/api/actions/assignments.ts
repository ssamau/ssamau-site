// Assignment handlers.
//
// Port of the ASSIGNMENTS section from netlify/functions/api.js
// (lines 1048–1104 + 1303–1320 for bulkMarkAttendance).
//
// Scope model (2026-05-17): heads can only operate on assignments for
// opportunities owned by their committee. Admin / superadmin pass
// through unchanged. The opportunity → owning_committee_id link is the
// authority; member_id committee isn't consulted because admin already
// allows cross-committee assignments (e.g. a hospitality member helping
// at a sports event) and that's intentional.

import { sql } from '../_sql.ts';
import {
  httpErr,
  requireAuth, requireAdminScope,
  type Handler,
} from '../_helpers.ts';

// Look up the opportunity's owning committee and push it through
// requireAdminScope. Throws 404 if the opportunity_id is bogus.
async function ensureOpportunityScope(user: any, opportunity_id: unknown): Promise<void> {
  if (!opportunity_id) throw httpErr('err.required.opportunity_id', 400);
  const [opp] = await sql`
    SELECT owning_committee_id FROM public.opportunities WHERE opportunity_id = ${opportunity_id}
  ` as Array<{ owning_committee_id: string | null }>;
  if (!opp) throw httpErr('err.notfound.opportunity', 404);
  requireAdminScope(user, opp.owning_committee_id);
}

// Given an assignment_id, resolve its opportunity → owning_committee
// and scope-check. Used by remove / markAttendance which take an
// assignment_id rather than an opportunity_id directly.
async function ensureAssignmentScope(user: any, assignment_id: unknown): Promise<void> {
  if (!assignment_id) throw httpErr('err.required.assignment_id', 400);
  const [row] = await sql`
    SELECT o.owning_committee_id
    FROM public.assignments a
    JOIN public.opportunities o ON o.opportunity_id = a.opportunity_id
    WHERE a.assignment_id = ${assignment_id}
  ` as Array<{ owning_committee_id: string | null }>;
  if (!row) throw httpErr('err.notfound.assignment', 404);
  requireAdminScope(user, row.owning_committee_id);
}

// ─── ASSIGNMENTS ─────────────────────────────────────────────────────
const assignmentsList: Handler = async (body, user) => {
  requireAuth(user);
  const opportunity_id = body.opportunity_id as string | undefined;
  const project_id = body.project_id as string | undefined;
  const member_id = body.member_id as string | undefined;
  // If a specific opportunity is queried, scope-check it. Otherwise for
  // heads, narrow the SQL to opportunities they own.
  if (opportunity_id) await ensureOpportunityScope(user, opportunity_id);
  const isHead = user!.access === 'head';
  const committeeFilter = isHead && !opportunity_id
    ? sql`AND o.owning_committee_id = ${user!.committee_id}`
    : sql``;
  return sql`
    SELECT a.*,
      o.role_name, o.role_key, o.estimated_hours, o.project_id, o.owning_committee_id,
      p.project_name, p.project_type, p.event_date,
      m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
      m.email AS member_email
    FROM assignments a
    JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN projects p ON p.project_id     = o.project_id
    LEFT JOIN members  m ON m.member_id      = a.member_id
    WHERE 1=1
      ${opportunity_id ? sql`AND a.opportunity_id = ${opportunity_id}` : sql``}
      ${project_id     ? sql`AND o.project_id     = ${project_id}`     : sql``}
      ${member_id      ? sql`AND a.member_id      = ${member_id}`      : sql``}
      ${committeeFilter}
    ORDER BY a.created_at DESC
  `;
};

const assignmentsAdd: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  requireAuth(user);
  await ensureOpportunityScope(user, data.opportunity_id);
  if (!data.member_id && !data.volunteer_name) {
    throw httpErr('err.required.member_or_volunteer', 400);
  }
  const [r] = await sql`
    INSERT INTO assignments (opportunity_id, member_id, volunteer_name, volunteer_email,
                             assigned_by, attendance_status)
    VALUES (${data.opportunity_id}, ${data.member_id || null},
            ${data.volunteer_name || null}, ${data.volunteer_email || null},
            ${user.id}, 'Pending')
    RETURNING assignment_id
  ` as Array<{ assignment_id: string }>;
  return { id: r.assignment_id, assignment_id: r.assignment_id };
};

const assignmentsRemove: Handler = async (body, user) => {
  requireAuth(user);
  const id = body.id as string | undefined;
  await ensureAssignmentScope(user, id);
  await sql`DELETE FROM assignments WHERE assignment_id = ${id}`;
  return { id };
};

const assignmentsMarkAttendance: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  requireAuth(user);
  if (!data.assignment_id || !data.attendance_status) {
    throw httpErr('err.required.assignment_attendance', 400);
  }
  await ensureAssignmentScope(user, data.assignment_id);
  await sql`
    UPDATE assignments SET
      attendance_status    = ${data.attendance_status},
      attendance_notes     = ${data.attendance_notes || null},
      attendance_marked_by = ${user.id},
      attendance_marked_at = NOW()
    WHERE assignment_id = ${data.assignment_id}
  `;
  return { id: data.assignment_id };
};

const assignmentsBulkMarkAttendance: Handler = async (body, user) => {
  requireAuth(user);
  const records = body.records as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(records)) throw httpErr('err.required.records', 400);
  let count = 0;
  for (const r of records) {
    if (!r.assignment_id || !r.attendance_status) continue;
    // Scope-check every record so a single bulk call can't smuggle in
    // an assignment from another committee.
    await ensureAssignmentScope(user, r.assignment_id);
    await sql`
      UPDATE assignments SET
        attendance_status    = ${r.attendance_status},
        attendance_notes     = ${r.attendance_notes || null},
        attendance_marked_by = ${user.id},
        attendance_marked_at = NOW()
      WHERE assignment_id = ${r.assignment_id}
    `;
    count++;
  }
  return { count };
};

// Self-service assignment listing — member portal (Phase 5 of Branch 4).
// Same shape as assignments.list filtered by member_id, but enforces the
// filter server-side from the auth context so a member can't query
// someone else's assignments by passing a different member_id in the
// body. Returns the joined opportunity + project info needed to split
// Upcoming vs Past on the client.
const assignmentsListOwn: Handler = async (_body, user) => {
  requireAuth(user);
  if (!user.member_id) throw httpErr('err.auth.no_member_link', 404);
  return sql`
    SELECT a.*,
      o.role_name, o.role_key, o.estimated_hours, o.project_id, o.owning_committee_id,
      p.project_name, p.project_type, p.event_date, p.start_time, p.end_time, p.location,
      c.committee_name
    FROM assignments a
    JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN projects   p ON p.project_id     = o.project_id
    LEFT JOIN committees c ON c.committee_id   = o.owning_committee_id
    WHERE a.member_id = ${user.member_id}
    ORDER BY p.event_date DESC NULLS LAST, a.created_at DESC
  `;
};

export const assignmentsActions: Record<string, Handler> = {
  'assignments.list':                assignmentsList,
  'assignments.add':                 assignmentsAdd,
  'assignments.remove':              assignmentsRemove,
  'assignments.markAttendance':      assignmentsMarkAttendance,
  'assignments.bulkMarkAttendance':  assignmentsBulkMarkAttendance,
  'assignments.listOwn':             assignmentsListOwn,
};
