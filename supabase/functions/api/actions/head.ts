// Committee-head landing-page handlers.
//
// One action for now: `head.dashboardSummary`, which aggregates the
// four KPIs the head needs at-a-glance plus the top-N rows for the
// two pending queues (applications waiting on a decision + hours
// waiting on primary approval).
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

const headDashboardSummary: Handler = async (body, user) => {
  requireAuth(user);

  // Resolve target committee: heads always see their own; superadmin
  // can pass an override for preview/testing.
  let committee_id: string | null = null;
  if (user!.access === 'head') {
    if (!user!.committee_id) throw httpErr('Head account has no committee assigned', 409);
    committee_id = user!.committee_id;
  } else if (user!.access === 'superadmin') {
    committee_id = (body.committee_id as string | undefined) || null;
    if (!committee_id) {
      // Fall back to the first active committee — useful for "what does
      // a head see?" exploration without picking one manually.
      const rows = await sql`
        SELECT committee_id FROM public.committees
        WHERE status = 'Active'
        ORDER BY committee_name LIMIT 1
      ` as Array<{ committee_id: string }>;
      committee_id = rows[0]?.committee_id || null;
    }
    if (!committee_id) throw httpErr('No committees available to preview', 404);
  } else {
    throw httpErr('Forbidden — head or superadmin only', 403);
  }

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
  if (!committeeRow) throw httpErr('Committee not found', 404);

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

export const headActions: Record<string, Handler> = {
  'head.dashboardSummary': headDashboardSummary,
};
