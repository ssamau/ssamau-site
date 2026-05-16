// Committee-head landing-page handlers.
//
// Two areas:
//   - `head.dashboardSummary` aggregates the four KPIs the head sees
//     at-a-glance + top-N rows for the pending queues.
//   - `head.attendance.list` / `head.attendance.record` — the
//     committee-head attendance tab, added 2026-05-16 at a head's
//     request. Records attendance either against an existing project
//     in the committee OR against an ad-hoc meeting (online /
//     in-person) the head describes inline. Hours assigned by the
//     head auto-FinalApprove since heads own the approval chain for
//     their own committee.
//
// Permissioning: caller must have `access_level = 'head'` and a
// committee_id set; or `access_level = 'superadmin'` (for testing or
// when the dev wants to preview a head's view by passing committee_id
// explicitly). All filters are server-side — clients can't widen
// scope by sending different params.

import { sql } from '../_sql.ts';
import {
  requireAuth, httpErr,
  type Handler,
} from '../_helpers.ts';

// Resolve the target committee for a head-portal request. Heads
// always operate on their own committee; superadmin can pass an
// explicit override for preview/testing. Throws on anyone else.
async function resolveHeadCommittee(
  user: { access?: string; committee_id?: string | null } | null,
  bodyCommitteeId: string | null | undefined,
): Promise<string> {
  if (!user) throw httpErr('err.auth.unauthorized', 401);
  if (user.access === 'head') {
    if (!user.committee_id) throw httpErr('err.access.head_no_committee', 409);
    return user.committee_id;
  }
  if (user.access === 'superadmin') {
    if (bodyCommitteeId) return bodyCommitteeId;
    const rows = await sql`
      SELECT committee_id FROM public.committees
      WHERE status = 'Active' ORDER BY committee_name LIMIT 1
    ` as Array<{ committee_id: string }>;
    if (!rows[0]) throw httpErr('err.business.no_committees_setup', 404);
    return rows[0].committee_id;
  }
  throw httpErr('err.access.head_or_dev_only', 403);
}

const headDashboardSummary: Handler = async (body, user) => {
  // resolveHeadCommittee centralises the "head OR superadmin-with-
  // override" branching shared with head.attendance.* handlers below.
  const committee_id = await resolveHeadCommittee(user, body.committee_id as string | null | undefined);

  // Committee meta — name + the head's own profile-friendly info.
  const [committeeRow] = await sql`
    SELECT c.committee_id, c.committee_name, c.category,
           (SELECT full_name FROM public.members WHERE member_id = c.committee_head_member_id)
             AS head_full_name
    FROM public.committees c
    WHERE c.committee_id = ${committee_id}
  ` as Array<{
    committee_id: string; committee_name: string; category: string; head_full_name: string | null;
  }>;
  if (!committeeRow) throw httpErr('err.notfound.committee', 404);

  // ─── KPI counts ─────────────────────────────────────────────────────
  const [counts] = await sql`
    SELECT
      (SELECT COUNT(*) FROM public.members
        WHERE committee_id = ${committee_id} AND status = 'Active') AS members_count,
      (SELECT COUNT(*) FROM public.membership_applications
        WHERE assigned_committee_id = ${committee_id}
          AND status NOT IN ('Accepted', 'Rejected')) AS pending_applications_count,
      -- Both Draft AND PrimaryApproved count as "pending head action"
      -- now that heads own both approval stages (2026-05-16 policy
      -- change — see hours.ts header comment).
      (SELECT COUNT(*) FROM public.hours h
        JOIN public.members m ON m.member_id = h.member_id
        WHERE m.committee_id = ${committee_id}
          AND h.approval_status IN ('Draft', 'PrimaryApproved')) AS hours_pending_count,
      (SELECT COUNT(*) FROM public.opportunities o
        JOIN public.projects p ON p.project_id = o.project_id
        WHERE o.owning_committee_id = ${committee_id}
          AND o.status NOT IN ('Cancelled', 'Done')
          AND (p.event_date IS NULL OR p.event_date >= CURRENT_DATE - INTERVAL '7 days'))
          AS open_opportunities_count
  ` as Array<Record<string, number>>;

  // ─── Pending applications (top 5) ───────────────────────────────────
  const pendingApplications = await sql`
    SELECT application_id, full_name, preferred_name, email, status, created_at
    FROM public.membership_applications
    WHERE assigned_committee_id = ${committee_id}
      AND status NOT IN ('Accepted', 'Rejected')
    ORDER BY created_at DESC
    LIMIT 5
  `;

  // ─── Hours awaiting primary approval (top 5) ────────────────────────
  // Joins to members for the displayable name and projects for the
  // event context. Includes total_hours so the head sees the magnitude
  // before clicking through.
  const hoursPending = await sql`
    SELECT h.id AS hours_id, h.total_hours, h.recorded_at, h.approval_status,
           m.full_name      AS member_full_name,
           m.preferred_name AS member_preferred_name,
           p.project_name,
           p.event_date
    FROM public.hours h
    JOIN public.members  m ON m.member_id  = h.member_id
    JOIN public.projects p ON p.project_id = h.project_id
    WHERE m.committee_id = ${committee_id}
      AND h.approval_status IN ('Draft', 'PrimaryApproved')
    ORDER BY
      CASE h.approval_status WHEN 'Draft' THEN 0 ELSE 1 END,
      h.recorded_at ASC
    LIMIT 5
  `;

  return {
    committee: committeeRow,
    counts: counts || {
      members_count: 0,
      pending_applications_count: 0,
      hours_pending_count: 0,
      open_opportunities_count: 0,
    },
    pending_applications: pendingApplications,
    hours_pending:        hoursPending,
  };
};

// ─── Head attendance tab (2026-05-16) ───────────────────────────────
// List attendance rows scoped to the head's committee. Returns BOTH
// project-linked rows (existing attendance flow) AND ad-hoc meeting
// rows (new). Joined with members + projects so the client can render
// a uniform table without extra lookups. Sorted with most recent
// activity first.
const headAttendanceList: Handler = async (body, user) => {
  const committee_id = await resolveHeadCommittee(user, body.committee_id as string | null | undefined);
  // Show every row that's "this committee's business":
  //   1. recorded_by = the current head — always show what THIS head
  //      personally logged, no matter whose project / member it
  //      touched. This is the critical fix: an admin-created project
  //      without owning_committee_id used to record successfully but
  //      then disappear from the head's list.
  //   2. recorded_by = anyone in this committee — covers other heads /
  //      future co-heads on the same committee.
  //   3. project is OWNED by this committee.
  //   4. ad-hoc meeting whose attendee is a member of this committee.
  // De-duped by the row id (a row matching multiple clauses still
  // appears once because SELECT … WHERE OR is row-scoped).
  return sql`
    SELECT a.id AS attendance_id, a.*,
           m.full_name      AS member_full_name,
           m.preferred_name AS member_preferred_name,
           m.committee_id   AS member_committee_id,
           p.project_name,
           p.event_date     AS project_event_date,
           p.owning_committee_id
    FROM   public.attendance a
    LEFT JOIN public.members  m  ON m.member_id  = a.member_id
    LEFT JOIN public.projects p  ON p.project_id = a.project_id
    LEFT JOIN public.users    ru ON ru.id        = a.recorded_by
    LEFT JOIN public.members  rm ON rm.member_id = ru.member_id
    WHERE  a.attendance_status <> 'Deleted'
      AND  (
        a.recorded_by = ${user!.id}
        OR rm.committee_id      = ${committee_id}
        OR p.owning_committee_id = ${committee_id}
        OR m.committee_id        = ${committee_id}
      )
    ORDER BY COALESCE(a.meeting_date, a.recorded_at::DATE) DESC, a.recorded_at DESC
    LIMIT 500
  `;
};

// Record attendance — either against an existing project or an ad-hoc
// meeting. Validates "exactly one of project_id / meeting_title" at the
// application level too, so we get a friendly error before the CHECK
// constraint fires. If the head supplies meeting_hours, the row is the
// canonical record of those hours — no parallel `hours` table insert
// needed, because recomputeMemberTotalHours() also sums
// attendance.meeting_hours per member (see hours.ts).
const headAttendanceRecord: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const committee_id = await resolveHeadCommittee(user, body.committee_id as string | null | undefined);

  const project_id    = (data.project_id as string | undefined) || null;
  const meeting_title = ((data.meeting_title as string | undefined) || '').trim() || null;

  // Exactly one of project_id / meeting_title.
  if ((project_id && meeting_title) || (!project_id && !meeting_title)) {
    throw httpErr('err.business.attendance_project_xor_meeting', 400);
  }

  // For project-linked rows, verify the project belongs to this committee
  // (heads can't record attendance for another committee's event).
  if (project_id) {
    const [proj] = await sql`
      SELECT owning_committee_id FROM public.projects WHERE project_id = ${project_id}
    ` as Array<{ owning_committee_id: string | null }>;
    if (!proj) throw httpErr('err.notfound.project', 404);
    if (proj.owning_committee_id && proj.owning_committee_id !== committee_id) {
      throw httpErr('err.access.committee_scope', 403);
    }
  }

  // For ad-hoc meetings, require the supporting metadata so the row
  // is self-describing (the DB CHECK only enforces the title). Heads
  // can leave meeting_location null for purely-online meetings.
  if (meeting_title) {
    if (!data.meeting_type || !data.meeting_date || !data.meeting_start_time) {
      throw httpErr('err.required.meeting_fields', 400);
    }
  }

  // For member-attendance, verify the member is in this committee
  // (volunteer rows skip this check — anyone can be an external
  // attendee on the head's meeting).
  const member_id = (data.member_id as string | undefined) || null;
  if (member_id) {
    const [m] = await sql`
      SELECT committee_id FROM public.members WHERE member_id = ${member_id}
    ` as Array<{ committee_id: string | null }>;
    if (!m) throw httpErr('err.notfound.member', 404);
    if (m.committee_id !== committee_id) {
      throw httpErr('err.access.member_committee_scope', 403);
    }
  }

  // Meeting-hours sanity: non-negative, at most a sensible upper bound
  // so a typo can't add 999 hours to a member's total.
  let meeting_hours: number | null = null;
  if (data.meeting_hours != null && data.meeting_hours !== '') {
    const n = Number(data.meeting_hours);
    if (!Number.isFinite(n) || n < 0 || n > 24) {
      throw httpErr('err.business.hours_out_of_range', 400);
    }
    meeting_hours = n;
  }

  const status = (data.attendance_status as string | undefined) || 'Present';

  const [r] = await sql`
    INSERT INTO public.attendance (
      project_id, member_id, volunteer_name, volunteer_email,
      attendance_status, notes, recorded_by,
      meeting_title, meeting_type, meeting_date, meeting_start_time,
      meeting_location, meeting_hours
    ) VALUES (
      ${project_id}, ${member_id}, ${(data.volunteer_name as string) || null},
      ${(data.volunteer_email as string) || null},
      ${status}, ${(data.notes as string) || null}, ${user!.id},
      ${meeting_title}, ${(data.meeting_type as string) || null},
      ${(data.meeting_date as string) || null},
      ${(data.meeting_start_time as string) || null},
      ${(data.meeting_location as string) || null},
      ${meeting_hours}
    )
    RETURNING id
  ` as Array<{ id: number }>;

  // If we attributed hours to a member, recompute their cached total
  // so the homepage / member portal reflects the new entry. Skip for
  // volunteer-only rows (no member to update) and for zero-hour
  // attendance (no impact on the running total).
  if (member_id && meeting_hours && meeting_hours > 0) {
    await sql`
      UPDATE public.members SET total_hours = (
        SELECT COALESCE(SUM(total_hours), 0) FROM public.hours
          WHERE member_id = ${member_id} AND approval_status = 'FinalApproved'
      ) + (
        SELECT COALESCE(SUM(meeting_hours), 0) FROM public.attendance
          WHERE member_id = ${member_id} AND meeting_hours IS NOT NULL
      )
      WHERE member_id = ${member_id}
    `;
  }

  return { attendance_id: r.id };
};

export const headActions: Record<string, Handler> = {
  'head.dashboardSummary': headDashboardSummary,
  'head.attendance.list':  headAttendanceList,
  'head.attendance.record':headAttendanceRecord,
};
