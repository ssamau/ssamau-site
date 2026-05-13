// Project / event CRUD handlers.
//
// Port of the PROJECTS / EVENTS section from netlify/functions/api.js
// (lines 439–496). `getProjects` is public; create + delete are
// superadmin-only via SUPERADMIN_ACTIONS; update is head-scoped on the
// project's owning committee.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  requireAdminScope,
  type Handler,
} from '../_helpers.ts';

// ─── PROJECTS / EVENTS ───────────────────────────────────────────────
const getProjects: Handler = async () => sql`
  SELECT p.*,
    (SELECT COUNT(*) FROM participants pa WHERE pa.project_id = p.project_id) AS participant_count
  FROM projects p
  ORDER BY p.event_date DESC NULLS LAST, p.created_at DESC
`;

const createProject: Handler = async (body) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const id = (data.project_id as string | undefined) || shortId('PRJ');
  await sql`
    INSERT INTO projects (project_id, project_name, project_type, project_description,
                          event_date, start_time, end_time, location, proposal_file_url,
                          created_by_member_id, assigned_project_manager_member_id,
                          assigned_event_manager_member_id, owning_committee_id,
                          project_status, notes)
    VALUES (${id}, ${data.project_name}, ${data.project_type || 'Event'},
            ${data.project_description || null}, ${data.event_date || null},
            ${data.start_time || null}, ${data.end_time || null},
            ${data.location || null}, ${data.proposal_file_url || null},
            ${data.created_by_member_id || null}, ${data.assigned_project_manager_member_id || null},
            ${data.assigned_event_manager_member_id || null}, ${data.owning_committee_id || null},
            ${data.project_status || 'Planned'}, ${data.notes || null})
  `;
  return { project_id: id };
};

const updateProject: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (user!.access === 'head') {
    const [p] = await sql`SELECT owning_committee_id FROM projects WHERE project_id = ${id}` as Array<{ owning_committee_id: string | null }>;
    if (!p) throw httpErr('Project not found', 404);
    requireAdminScope(user, p.owning_committee_id);
  }
  await sql`
    UPDATE projects SET
      project_name                       = COALESCE(${data.project_name},                       project_name),
      project_type                       = COALESCE(${data.project_type},                       project_type),
      project_description                = COALESCE(${data.project_description},                project_description),
      event_date                         = COALESCE(${data.event_date},                         event_date),
      start_time                         = COALESCE(${data.start_time},                         start_time),
      end_time                           = COALESCE(${data.end_time},                           end_time),
      location                           = COALESCE(${data.location},                           location),
      proposal_file_url                  = COALESCE(${data.proposal_file_url},                  proposal_file_url),
      assigned_project_manager_member_id = COALESCE(${data.assigned_project_manager_member_id}, assigned_project_manager_member_id),
      assigned_event_manager_member_id   = COALESCE(${data.assigned_event_manager_member_id},   assigned_event_manager_member_id),
      owning_committee_id                = COALESCE(${data.owning_committee_id},                owning_committee_id),
      project_status                     = COALESCE(${data.project_status},                     project_status),
      notes                              = COALESCE(${data.notes},                              notes)
    WHERE project_id = ${id}
  `;
  return { project_id: id };
};

const deleteProject: Handler = async (body) => {
  const id = body.id as string | undefined;
  await sql`DELETE FROM projects WHERE project_id = ${id}`;
  return { project_id: id };
};

export const projectsActions: Record<string, Handler> = {
  'getProjects':   getProjects,
  'createProject': createProject,
  'updateProject': updateProject,
  'deleteProject': deleteProject,
};
