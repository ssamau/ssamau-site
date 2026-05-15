// Advisor CRUD handlers.
//
// Port of the ADVISORS section from netlify/functions/api.js (lines 361–396).
// `getAdvisors` is public; the other three are superadmin-only via the
// SUPERADMIN_ACTIONS allowlist in the dispatcher.

import { sql } from '../_sql.ts';
import { type Handler } from '../_helpers.ts';

// ─── ADVISORS ────────────────────────────────────────────────────────
// total_hours added by Phase D (advisor hours). Mirrors members.total_hours —
// cached sum of FinalApproved hours rows that point at this advisor.
const getAdvisors: Handler = async () => sql`
  SELECT id AS advisor_id, id, full_name, advisory_role, email, phone, notes,
         status, total_hours, created_at, updated_at
  FROM advisors ORDER BY full_name
`;

const createAdvisor: Handler = async (body) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const [r] = await sql`
    INSERT INTO advisors (full_name, advisory_role, email, phone, notes, status)
    VALUES (${data.full_name}, ${data.advisory_role || null}, ${data.email || null},
            ${data.phone || null}, ${data.notes || null}, ${data.status || 'Active'})
    RETURNING id
  ` as Array<{ id: number }>;
  return { id: r.id, advisor_id: r.id };
};

const updateAdvisor: Handler = async (body) => {
  const id = body.id as number | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  await sql`
    UPDATE advisors SET
      full_name     = COALESCE(${data.full_name},     full_name),
      advisory_role = COALESCE(${data.advisory_role}, advisory_role),
      email         = COALESCE(${data.email},         email),
      phone         = COALESCE(${data.phone},         phone),
      notes         = COALESCE(${data.notes},         notes),
      status        = COALESCE(${data.status},        status),
      updated_at    = NOW()
    WHERE id = ${id}
  `;
  return { id };
};

const deleteAdvisor: Handler = async (body) => {
  const id = body.id as number | undefined;
  await sql`DELETE FROM advisors WHERE id = ${id}`;
  return { id };
};

export const advisorsActions: Record<string, Handler> = {
  'getAdvisors':   getAdvisors,
  'createAdvisor': createAdvisor,
  'updateAdvisor': updateAdvisor,
  'deleteAdvisor': deleteAdvisor,
};
