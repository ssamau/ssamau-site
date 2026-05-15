// Dashboard aggregate handlers.
//
// Port of the DASHBOARD section from netlify/functions/api.js (lines 921–982).
// Both actions require auth — used by the admin dashboard landing page and
// the per-project detail drawer.

import { sql } from '../_sql.ts';
import {
  httpErr,
  type Handler,
} from '../_helpers.ts';

// ─── DASHBOARD ───────────────────────────────────────────────────────
const getDashboardStats: Handler = async () => {
  const [counts] = await sql`
    SELECT
      (SELECT COUNT(*) FROM members WHERE status='Active')    AS active_members,
      (SELECT COUNT(*) FROM members)                          AS total_members,
      (SELECT COUNT(*) FROM projects)                         AS total_projects,
      (SELECT COALESCE(SUM(total_hours), 0) FROM hours WHERE approval_status = 'FinalApproved') AS total_hours,
      (SELECT COUNT(*) FROM committees WHERE status='Active') AS total_committees
  ` as Array<Record<string, unknown>>;
  const topVolunteers = await sql`
    SELECT m.member_id, m.full_name, m.preferred_name, m.committee_id,
           COALESCE(m.preferred_name, m.full_name) AS name,
           COALESCE(SUM(h.total_hours), 0) AS hours
    FROM members m
    LEFT JOIN hours h ON h.member_id = m.member_id AND h.approval_status = 'FinalApproved'
    WHERE m.status = 'Active'
    GROUP BY m.member_id
    ORDER BY hours DESC, m.full_name
    LIMIT 10
  `;
  const committeeHours = await sql`
    SELECT c.committee_id, c.committee_name,
           COALESCE(SUM(h.total_hours), 0) AS hours
    FROM committees c
    LEFT JOIN members m ON m.committee_id = c.committee_id
    LEFT JOIN hours   h ON h.member_id    = m.member_id AND h.approval_status = 'FinalApproved'
    GROUP BY c.committee_id, c.committee_name
    ORDER BY hours DESC
  `;
  const recentProjects = await sql`
    SELECT project_id, project_name, project_type, event_date, project_status
    FROM projects
    ORDER BY event_date DESC NULLS LAST, created_at DESC
    LIMIT 8
  `;
  return {
    stats: counts,                  // legacy name expected by admin.html
    counts,                         // also exposed
    top_volunteers: topVolunteers,
    committee_hours: committeeHours,
    recent_projects: recentProjects,
  };
};

const dashboardProjectDetail: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  const [project] = await sql`SELECT * FROM projects WHERE project_id = ${project_id}` as Array<Record<string, unknown>>;
  if (!project) throw httpErr('err.notfound.project', 404);
  const participants = await sql`
    SELECT pa.*, m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           m.email AS member_email
    FROM participants pa
    LEFT JOIN members m ON m.member_id = pa.member_id
    WHERE pa.project_id = ${project_id}
  `;
  const attendance = await sql`
    SELECT * FROM attendance
    WHERE project_id = ${project_id} AND attendance_status <> 'Deleted'
  `;
  const hours = await sql`SELECT * FROM hours WHERE project_id = ${project_id}`;
  return { project, participants, attendance, hours };
};

export const dashboardActions: Record<string, Handler> = {
  'getDashboardStats':       getDashboardStats,
  'dashboard.projectDetail': dashboardProjectDetail,
};
