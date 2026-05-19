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
import { sendEmail } from '../_email.ts';

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
  // Multi-role 2026-05-19: also join opportunity_roles via the new
  // assignments.role_id so the UI can render the specific role each
  // assignee was placed in (separate from the legacy single-role
  // mirror on opportunities.role_name).
  return sql`
    SELECT a.*,
      o.role_name, o.role_key, o.estimated_hours, o.project_id, o.owning_committee_id,
      p.project_name, p.project_type, p.event_date,
      m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
      m.email AS member_email,
      orole.role_name AS assigned_role_name
    FROM assignments a
    JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN projects p ON p.project_id     = o.project_id
    LEFT JOIN members  m ON m.member_id      = a.member_id
    LEFT JOIN opportunity_roles orole ON orole.id = a.role_id
    WHERE 1=1
      ${opportunity_id ? sql`AND a.opportunity_id = ${opportunity_id}` : sql``}
      ${project_id     ? sql`AND o.project_id     = ${project_id}`     : sql``}
      ${member_id      ? sql`AND a.member_id      = ${member_id}`      : sql``}
      ${committeeFilter}
    ORDER BY a.created_at DESC
  `;
};

// Capacity helper — counts confirmed assignments on a (opportunity,
// role) pair and compares to the role's headcount_needed. Returns
// { taken, needed } so callers can decide rejection vs warning.
// Pass role_id=null to count opportunity-level (legacy single-role)
// assignments — useful for opportunities created BEFORE the multi-
// role refactor that never got a role_id assigned to existing rows.
//
// Exported so interest.ts can apply the same guard at the express-
// interest stage (block before the head sees the request, not just
// at the assign step).
export async function getRoleCapacity(
  opportunity_id: string,
  role_id: number | null,
): Promise<{ taken: number; needed: number } | null> {
  if (role_id === null || role_id === undefined) {
    // No role specified — fall back to the opportunity-level legacy
    // headcount on `opportunities.headcount_needed`.
    const [opp] = await sql`
      SELECT headcount_needed FROM public.opportunities
      WHERE  opportunity_id = ${opportunity_id}
    ` as Array<{ headcount_needed: number }>;
    if (!opp) return null;
    const [{ taken }] = await sql`
      SELECT COUNT(*)::int AS taken FROM public.assignments
      WHERE  opportunity_id = ${opportunity_id} AND role_id IS NULL
    ` as Array<{ taken: number }>;
    return { taken, needed: Number(opp.headcount_needed) || 1 };
  }
  const [role] = await sql`
    SELECT headcount_needed FROM public.opportunity_roles
    WHERE  id = ${role_id} AND opportunity_id = ${opportunity_id}
  ` as Array<{ headcount_needed: number }>;
  if (!role) return null;
  const [{ taken }] = await sql`
    SELECT COUNT(*)::int AS taken FROM public.assignments
    WHERE  opportunity_id = ${opportunity_id} AND role_id = ${role_id}
  ` as Array<{ taken: number }>;
  return { taken, needed: Number(role.headcount_needed) || 1 };
}

const assignmentsAdd: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  requireAuth(user);
  await ensureOpportunityScope(user, data.opportunity_id);
  if (!data.member_id && !data.volunteer_name) {
    throw httpErr('err.required.member_or_volunteer', 400);
  }
  // Capacity guard 2026-05-19 — block adding a member/volunteer to a
  // role that's already filled to headcount. role_id is optional in
  // the request body; if omitted, falls back to opportunity-level
  // capacity (legacy single-role behavior). Server-authoritative — no
  // way for the UI to bypass.
  const role_id_raw = data.role_id;
  const role_id = (role_id_raw === undefined || role_id_raw === null || role_id_raw === '')
                   ? null
                   : Number(role_id_raw);
  const cap = await getRoleCapacity(String(data.opportunity_id), role_id);
  if (cap && cap.taken >= cap.needed) {
    throw httpErr('err.business.role_full', 409);
  }

  const [r] = await sql`
    INSERT INTO assignments (opportunity_id, role_id, member_id, volunteer_name, volunteer_email,
                             assigned_by, attendance_status)
    VALUES (${data.opportunity_id}, ${role_id}, ${data.member_id || null},
            ${data.volunteer_name || null}, ${data.volunteer_email || null},
            ${user.id}, 'Pending')
    RETURNING assignment_id
  ` as Array<{ assignment_id: string }>;

  // Fire-and-forget confirmation to the assignee — president's spec
  // 2026-05-18. Members were being assigned without ever finding out.
  // Volunteers (no member_id) only get the email if volunteer_email
  // was provided. SMTP errors are logged but never bubble up; the
  // assignment row itself is already saved at this point.
  notifyAssignmentConfirmed({
    assignment_id:    r.assignment_id,
    opportunity_id:   String(data.opportunity_id),
    member_id:        (data.member_id as string | null) || null,
    volunteer_name:   (data.volunteer_name as string | null) || null,
    volunteer_email:  (data.volunteer_email as string | null) || null,
  }).catch(err => {
    console.error('[assignments.add] confirmation email failed (assignment saved):', err);
  });

  return { id: r.assignment_id, assignment_id: r.assignment_id };
};

const assignmentsRemove: Handler = async (body, user) => {
  requireAuth(user);
  const id = body.id as string | undefined;
  await ensureAssignmentScope(user, id);
  await sql`DELETE FROM assignments WHERE assignment_id = ${id}`;
  return { id };
};

// Sentinel note value used to identify hours rows that were auto-
// created by a head/admin via the assignment modal's hours-override
// field. Lets us re-mark attendance idempotently — DELETE any
// existing auto row for this assignment, then INSERT the fresh one.
// Plain logged hours (recorded via the hours form) don't carry this
// marker, so they're never touched by the auto path.
const HEAD_ATTENDANCE_HOURS_NOTE = 'auto:head-attendance';

const assignmentsMarkAttendance: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  requireAuth(user);
  if (!data.assignment_id || !data.attendance_status) {
    throw httpErr('err.required.assignment_attendance', 400);
  }
  await ensureAssignmentScope(user, data.assignment_id);

  const status = data.attendance_status as string;
  // hours_override: optional number from the head's assign-modal input.
  // null/undefined/empty-string = "no override, don't auto-create
  // hours". A non-zero number creates a FinalApproved hours row for
  // this assignment that overrides the opportunity's estimated_hours.
  const rawOverride = data.hours_override;
  const hoursOverride = (rawOverride === '' || rawOverride === null || rawOverride === undefined)
    ? null
    : Number(rawOverride);
  if (hoursOverride !== null && (!Number.isFinite(hoursOverride) || hoursOverride < 0 || hoursOverride > 24)) {
    throw httpErr('err.business.hours_range', 400);
  }

  await sql`
    UPDATE assignments SET
      attendance_status    = ${status},
      attendance_notes     = ${data.attendance_notes || null},
      attendance_marked_by = ${user.id},
      attendance_marked_at = NOW()
    WHERE assignment_id = ${data.assignment_id}
  `;

  // Two sub-paths for the auto-hours row, gated on attendance status:
  //   Attended + override → DELETE prior auto row, INSERT new
  //     FinalApproved row with the override value.
  //   anything else → DELETE prior auto row (so changing from
  //     Attended back to Absent/Excused doesn't leave orphaned
  //     hours on the member's total).
  const [meta] = await sql`
    SELECT a.member_id, a.opportunity_id, o.project_id
    FROM public.assignments a
    JOIN public.opportunities o ON o.opportunity_id = a.opportunity_id
    WHERE a.assignment_id = ${data.assignment_id}
  ` as Array<{ member_id: string | null; opportunity_id: string; project_id: string | null }>;

  if (meta) {
    await sql`
      DELETE FROM public.hours
      WHERE assignment_id = ${data.assignment_id}
        AND notes = ${HEAD_ATTENDANCE_HOURS_NOTE}
    `;
    if (status === 'Attended' && hoursOverride !== null && hoursOverride > 0 && meta.member_id) {
      await sql`
        INSERT INTO public.hours (
          project_id, assignment_id, member_id, participant_type,
          hours_before, hours_during, hours_after,
          notes, recorded_by, approval_status,
          primary_approver_id, primary_approved_at,
          final_approver_id, final_approved_at
        ) VALUES (
          ${meta.project_id}, ${data.assignment_id}, ${meta.member_id}, 'Member',
          0, ${hoursOverride}, 0,
          ${HEAD_ATTENDANCE_HOURS_NOTE}, ${user.id}, 'FinalApproved',
          ${user.id}, NOW(),
          ${user.id}, NOW()
        )
      `;
    }
    // Always recompute — even if we only deleted, the member's total
    // needs to drop accordingly.
    if (meta.member_id) {
      await sql`
        UPDATE public.members SET total_hours = (
          SELECT COALESCE(SUM(total_hours), 0) FROM public.hours
          WHERE member_id = ${meta.member_id} AND approval_status = 'FinalApproved'
        ) + (
          SELECT COALESCE(SUM(meeting_hours), 0) FROM public.attendance
          WHERE member_id = ${meta.member_id} AND meeting_hours IS NOT NULL
            AND attendance_status <> 'Deleted'
        ) WHERE member_id = ${meta.member_id}
      `;
    }
  }

  return { id: data.assignment_id, hours_override: hoursOverride };
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

// ─── ASSIGNMENT CONFIRMATION EMAIL ───────────────────────────────────
// Sent on every successful assignments.add. The assignee is either a
// member (look up email from members) or an ad-hoc volunteer (use
// volunteer_email directly). The opportunity + project context is
// looked up so the recipient sees what role, what event, when, where.
async function notifyAssignmentConfirmed(opts: {
  assignment_id:   string;
  opportunity_id:  string;
  member_id:       string | null;
  volunteer_name:  string | null;
  volunteer_email: string | null;
}): Promise<void> {
  let toEmail: string | null = null;
  let toName:  string        = '';

  if (opts.member_id) {
    const [m] = await sql`
      SELECT email, full_name, preferred_name
      FROM public.members WHERE member_id = ${opts.member_id}
    ` as Array<{ email: string | null; full_name: string; preferred_name: string | null }>;
    if (m?.email) {
      toEmail = m.email;
      toName  = m.preferred_name || m.full_name || '';
    }
  } else if (opts.volunteer_email) {
    toEmail = opts.volunteer_email;
    toName  = opts.volunteer_name || '';
  }
  if (!toEmail) return;  // no address → nothing to send

  // Opportunity + project + committee + role context. role_name comes
  // from opportunities.role_name (the legacy single-role mirror that
  // multi-role kept as the "primary" role label for the opp row).
  const [ctx] = await sql`
    SELECT o.role_name, o.estimated_hours,
           p.project_name, p.project_type, p.event_date,
           p.start_time, p.end_time, p.location,
           c.committee_name
    FROM   public.opportunities o
    LEFT JOIN public.projects   p ON p.project_id   = o.project_id
    LEFT JOIN public.committees c ON c.committee_id = o.owning_committee_id
    WHERE  o.opportunity_id = ${opts.opportunity_id}
  ` as Array<{
    role_name:       string | null;
    estimated_hours: number | null;
    project_name:    string;
    project_type:    string | null;
    event_date:      string | null;
    start_time:      string | null;
    end_time:        string | null;
    location:        string | null;
    committee_name:  string | null;
  }>;
  if (!ctx) return;

  const subject = `✅ تأكيد مشاركتك — ${ctx.project_name}`;
  const html = renderAssignmentConfirmedHtml({
    member_name:    toName,
    project_name:   ctx.project_name,
    project_type:   ctx.project_type,
    role_name:      ctx.role_name,
    event_date:     ctx.event_date ? String(ctx.event_date).slice(0, 10) : '',
    start_time:     ctx.start_time ? String(ctx.start_time).slice(0, 5) : '',
    end_time:       ctx.end_time   ? String(ctx.end_time).slice(0, 5)   : '',
    location:       ctx.location || '',
    committee_name: ctx.committee_name || '',
    estimated_hours: ctx.estimated_hours,
    is_member:      !!opts.member_id,
  });
  await sendEmail({ to: toEmail, subject, html });
}

function renderAssignmentConfirmedHtml(opts: {
  member_name:     string;
  project_name:    string;
  project_type:    string | null;
  role_name:       string | null;
  event_date:      string;
  start_time:      string;
  end_time:        string;
  location:        string;
  committee_name:  string;
  estimated_hours: number | null;
  is_member:       boolean;
}): string {
  const esc = (s: string) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const greeting = opts.member_name
    ? `أهلاً ${esc(opts.member_name)}،`
    : `أهلاً،`;
  const timeRow = (opts.start_time || opts.end_time)
    ? `<tr><td style="padding:.3rem 0;color:#6b7280;width:32%">⏰ الوقت</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.start_time)}${opts.end_time ? ` — ${esc(opts.end_time)}` : ''}</td></tr>`
    : '';
  const locRow = opts.location
    ? `<tr><td style="padding:.3rem 0;color:#6b7280">📍 الموقع</td><td style="padding:.3rem 0">${esc(opts.location)}</td></tr>`
    : '';
  const hrsRow = (opts.estimated_hours && opts.estimated_hours > 0)
    ? `<tr><td style="padding:.3rem 0;color:#6b7280">⏱️ الساعات المقدّرة</td><td style="padding:.3rem 0;direction:ltr">${opts.estimated_hours}</td></tr>`
    : '';
  const portalCta = opts.is_member
    ? `<div style="text-align:center;margin:1.4rem 0">
         <a href="https://ssamau.com/member.html#/member/assignments" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.85rem">
           عرض مهامي
         </a>
       </div>`
    : '';
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">✅</div>
      <div style="font-size:1.05rem;font-weight:800">تم تأكيد مشاركتك</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">Assignment confirmed</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75;text-align:right">
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">${greeting}</p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">يسعدنا تأكيد مشاركتك في الفعالية التالية:</p>

      <div dir="rtl" style="background:#f9fafb;border-radius:10px;padding:1.1rem;margin:1rem 0;text-align:right">
        <div style="font-size:1rem;font-weight:800;color:#1A5C2E;margin-bottom:.5rem">${esc(opts.project_name)}</div>
        <table dir="rtl" style="width:100%;font-size:.86rem;color:#374151;border-collapse:collapse">
          ${opts.role_name ? `<tr><td style="padding:.3rem 0;color:#6b7280;width:32%">🎯 دورك</td><td style="padding:.3rem 0"><strong style="color:#1A5C2E">${esc(opts.role_name)}</strong></td></tr>` : ''}
          ${opts.committee_name ? `<tr><td style="padding:.3rem 0;color:#6b7280">🏛️ اللجنة</td><td style="padding:.3rem 0">${esc(opts.committee_name)}</td></tr>` : ''}
          ${opts.event_date ? `<tr><td style="padding:.3rem 0;color:#6b7280">📅 التاريخ</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.event_date)}</td></tr>` : ''}
          ${timeRow}
          ${locRow}
          ${hrsRow}
        </table>
      </div>

      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right;font-size:.88rem;color:#4b5563">
        نشكرك على اهتمامك بخدمة النادي. سيتواصل معك رئيس اللجنة قبل الفعالية لتأكيد آخر التفاصيل.
      </p>

      ${portalCta}
    </div>
    <div dir="rtl" style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>`;
}

export const assignmentsActions: Record<string, Handler> = {
  'assignments.list':                assignmentsList,
  'assignments.add':                 assignmentsAdd,
  'assignments.remove':              assignmentsRemove,
  'assignments.markAttendance':      assignmentsMarkAttendance,
  'assignments.bulkMarkAttendance':  assignmentsBulkMarkAttendance,
  'assignments.listOwn':             assignmentsListOwn,
};
