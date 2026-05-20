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
// 2026-05-21: the three hours aggregates below used to LEFT JOIN the
// `hours` table at FinalApproved only. That ignored
// `attendance.meeting_hours` — heads who credit hours via meeting
// attendance had those hours appear on the member's own portal but NOT
// on the admin dashboard's total / leaderboard / committee rollup. The
// president flagged it: he could see سارة had 5.00 in her profile, but
// the leaderboard still showed her at 0.
//
// Fix: read from `members.total_hours` directly. That column is the
// canonical cached sum of (FinalApproved hours + meeting_hours), kept
// in sync by recomputeMemberTotalHours after every mutation. One
// source, two aggregates derived from it.
const getDashboardStats: Handler = async () => {
  const [counts] = await sql`
    SELECT
      (SELECT COUNT(*) FROM members WHERE status='Active')    AS active_members,
      (SELECT COUNT(*) FROM members)                          AS total_members,
      (SELECT COUNT(*) FROM projects)                         AS total_projects,
      (SELECT COALESCE(SUM(total_hours), 0) FROM members WHERE status='Active') AS total_hours,
      (SELECT COUNT(*) FROM committees WHERE status='Active') AS total_committees
  ` as Array<Record<string, unknown>>;
  const topVolunteers = await sql`
    SELECT m.member_id, m.full_name, m.preferred_name, m.committee_id,
           COALESCE(m.preferred_name, m.full_name) AS name,
           COALESCE(m.total_hours, 0) AS hours
    FROM members m
    WHERE m.status = 'Active'
    ORDER BY m.total_hours DESC NULLS LAST, m.full_name
    LIMIT 10
  `;
  const committeeHours = await sql`
    SELECT c.committee_id, c.committee_name,
           COALESCE(SUM(m.total_hours), 0) AS hours
    FROM committees c
    LEFT JOIN members m ON m.committee_id = c.committee_id
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
