// Opportunities (volunteer roles) handlers.
//
// Port of the OPPORTUNITIES (§4, §12) section from netlify/functions/api.js
// (lines 984–1046). All four require auth; create/update/delete are
// head-scoped on the opportunity's owning committee — heads can only manage
// opportunities in their committee, presidency in any.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  requireAdminScope,
  type Handler,
} from '../_helpers.ts';

// ─── OPPORTUNITIES (§4, §12) ─────────────────────────────────────────
const opportunitiesList: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  const committee_id = body.committee_id as string | undefined;
  const status = body.status as string | undefined;
  return sql`
    SELECT o.*,
      p.project_name, p.project_type, p.event_date,
      c.committee_name AS owning_committee_name,
      (SELECT COUNT(*) FROM assignments a WHERE a.opportunity_id = o.opportunity_id) AS assigned_count,
      (SELECT COUNT(*) FROM assignments a
        WHERE a.opportunity_id = o.opportunity_id AND a.attendance_status = 'Attended') AS attended_count
    FROM opportunities o
    LEFT JOIN projects   p ON p.project_id   = o.project_id
    LEFT JOIN committees c ON c.committee_id = o.owning_committee_id
    WHERE 1=1
      ${project_id   ? sql`AND o.project_id          = ${project_id}`   : sql``}
      ${committee_id ? sql`AND o.owning_committee_id = ${committee_id}` : sql``}
      ${status       ? sql`AND o.status              = ${status}`       : sql``}
    ORDER BY p.event_date DESC NULLS LAST, o.created_at DESC
  `;
};

const opportunitiesCreate: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  if (!data.project_id || !data.role_name) {
    throw httpErr('project_id and role_name are required', 400);
  }
  requireAdminScope(user, data.owning_committee_id as string | null | undefined);
  const id = (data.opportunity_id as string | undefined) || shortId('OPP');
  await sql`
    INSERT INTO opportunities (opportunity_id, project_id, role_name, role_key,
                               estimated_hours, headcount_needed, owning_committee_id,
                               status, notes, created_by)
    VALUES (${id}, ${data.project_id}, ${data.role_name}, ${data.role_key || null},
            ${data.estimated_hours || 0}, ${data.headcount_needed || 1},
            ${data.owning_committee_id || null}, ${data.status || 'Open'},
            ${data.notes || null}, ${user!.id})
  `;
  return { opportunity_id: id };
};

const opportunitiesUpdate: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  const [existing] = await sql`SELECT owning_committee_id FROM opportunities WHERE opportunity_id = ${id}` as Array<{ owning_committee_id: string | null }>;
  if (!existing) throw httpErr('Opportunity not found', 404);
  requireAdminScope(user, existing.owning_committee_id);
  if (data.owning_committee_id) requireAdminScope(user, data.owning_committee_id as string | null | undefined);
  await sql`
    UPDATE opportunities SET
      role_name           = COALESCE(${data.role_name},           role_name),
      role_key            = COALESCE(${data.role_key},            role_key),
      estimated_hours     = COALESCE(${data.estimated_hours},     estimated_hours),
      headcount_needed    = COALESCE(${data.headcount_needed},    headcount_needed),
      owning_committee_id = COALESCE(${data.owning_committee_id}, owning_committee_id),
      status              = COALESCE(${data.status},              status),
      notes               = COALESCE(${data.notes},               notes)
    WHERE opportunity_id = ${id}
  `;
  return { opportunity_id: id };
};

const opportunitiesDelete: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const [existing] = await sql`SELECT owning_committee_id FROM opportunities WHERE opportunity_id = ${id}` as Array<{ owning_committee_id: string | null }>;
  if (!existing) return { opportunity_id: id };
  requireAdminScope(user, existing.owning_committee_id);
  await sql`DELETE FROM opportunities WHERE opportunity_id = ${id}`;
  return { opportunity_id: id };
};

export const opportunitiesActions: Record<string, Handler> = {
  'opportunities.list':   opportunitiesList,
  'opportunities.create': opportunitiesCreate,
  'opportunities.update': opportunitiesUpdate,
  'opportunities.delete': opportunitiesDelete,
};
