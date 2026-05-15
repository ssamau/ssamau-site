// Opportunities (volunteer roles) handlers.
//
// Port of the OPPORTUNITIES (§4, §12) section from netlify/functions/api.js
// (lines 984–1046). All four require auth; create/update/delete are
// head-scoped on the opportunity's owning committee — heads can only manage
// opportunities in their committee, presidency in any.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId,
  requireAdminScope, requireAuth,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';

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

// Opportunity announcement notifier — president-requested feature (2026-05-15).
//
// Three send modes:
//   mode='all'     — every Active member with a non-NULL email. One
//                    email per recipient (allows future personalisation
//                    like "Hi <name>" in the body).
//   mode='members' — emails for the member_ids passed in `recipients`.
//                    Looks up each member's email server-side; ignores
//                    members without one.
//   mode='emails'  — ad-hoc email addresses. Sent as ONE message with
//                    every address in BCC so recipients don't see each
//                    other's addresses (per the president's exact spec).
//
// All three build the same HTML body: project + role + date + location
// + estimated hours + an optional admin "custom_message" prepended above
// the auto-generated opportunity card.
//
// Returns { count, sent, failed, mode } so the admin UI can show a
// delivery summary toast.
const opportunitiesNotify: Handler = async (body, user) => {
  requireAuth(user);
  const opportunity_id = body.opportunity_id as string | undefined;
  const mode           = (body.mode as 'all' | 'members' | 'emails' | undefined) || 'all';
  const recipients     = (body.recipients as string[] | undefined) || [];
  const custom_message = (body.custom_message as string | undefined) || '';

  if (!opportunity_id) throw httpErr('opportunity_id is required', 400);

  // Pull the opportunity + project for body content.
  const [opp] = await sql`
    SELECT o.opportunity_id, o.role_name, o.estimated_hours, o.headcount_needed,
           o.owning_committee_id, o.notes,
           p.project_id, p.project_name, p.event_date, p.location,
           c.committee_name
    FROM opportunities o
    LEFT JOIN projects   p ON p.project_id   = o.project_id
    LEFT JOIN committees c ON c.committee_id = o.owning_committee_id
    WHERE o.opportunity_id = ${opportunity_id}
  ` as Array<{
    opportunity_id: string; role_name: string; estimated_hours: number;
    headcount_needed: number; owning_committee_id: string | null;
    notes: string | null; project_id: string; project_name: string;
    event_date: string | null; location: string | null;
    committee_name: string | null;
  }>;
  if (!opp) throw httpErr('Opportunity not found', 404);
  // Committee-head scope check — head can only notify for own-committee
  // opportunities; admin/superadmin pass through.
  requireAdminScope(user, opp.owning_committee_id);

  // ── Build email body ───────────────────────────────────────────────
  const eventDate = opp.event_date ? String(opp.event_date).split('T')[0] : '';
  const html = renderOppNotificationHtml({
    role_name:        opp.role_name,
    project_name:     opp.project_name,
    committee_name:   opp.committee_name,
    event_date:       eventDate,
    location:         opp.location,
    estimated_hours:  opp.estimated_hours,
    headcount_needed: opp.headcount_needed,
    custom_message,
  });
  const subject = `🎯 فرصة تطوعية جديدة — ${opp.project_name}`;

  // ── Resolve recipient list per mode ───────────────────────────────
  let targets: string[] = [];
  if (mode === 'all') {
    const rows = await sql`
      SELECT email FROM members
      WHERE status = 'Active' AND email IS NOT NULL AND email <> ''
    ` as Array<{ email: string }>;
    targets = rows.map(r => r.email);
  } else if (mode === 'members') {
    if (!recipients.length) throw httpErr('recipients[] required for mode=members', 400);
    const rows = await sql`
      SELECT email FROM members
      WHERE member_id = ANY(${recipients}) AND email IS NOT NULL AND email <> ''
    ` as Array<{ email: string }>;
    targets = rows.map(r => r.email);
  } else if (mode === 'emails') {
    targets = recipients
      .map(s => String(s).trim())
      .filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (!targets.length) throw httpErr('No valid email addresses in recipients[]', 400);
  } else {
    throw httpErr(`Unknown mode: ${mode}`, 400);
  }

  // ── Send ───────────────────────────────────────────────────────────
  // emails mode → single BCC blast (recipients don't see each other).
  // all / members mode → one email per recipient (each is To'd directly).
  let sent = 0, failed = 0;
  const SMTP_USER = Deno.env.get('SMTP_USER') || '';

  if (mode === 'emails') {
    const ok = await sendEmail({
      to: SMTP_USER || 'info@ssamau.com',  // placeholder visible To
      bcc: targets,
      subject,
      html,
    });
    if (ok) sent = targets.length; else failed = targets.length;
  } else {
    for (const to of targets) {
      const ok = await sendEmail({ to, subject, html });
      if (ok) sent++; else failed++;
    }
  }
  return { count: targets.length, sent, failed, mode };
};

// Branded HTML envelope for the opportunity notification email. Same
// green/gold letterhead as the invite + thanks templates so recipients
// recognise the sender visually.
function renderOppNotificationHtml(opts: {
  role_name: string;
  project_name: string;
  committee_name: string | null;
  event_date: string;
  location: string | null;
  estimated_hours: number;
  headcount_needed: number;
  custom_message: string;
}): string {
  const esc = (s: string) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const customBlock = opts.custom_message
    ? `<div style="background:#fffbeb;border-inline-start:4px solid #b8932a;padding:.75rem 1rem;border-radius:6px;margin-bottom:1rem;font-size:.92rem;line-height:1.7">${esc(opts.custom_message).replace(/\n/g, '<br/>')}</div>`
    : '';
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827">
  <div style="max-width:580px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 60%,#b8932a 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">🎯</div>
      <div style="font-size:1.05rem;font-weight:800">فرصة تطوعية جديدة</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">New Volunteer Opportunity</div>
    </div>
    <div style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75">
      ${customBlock}
      <p style="margin:0 0 1rem 0">السلام عليكم،</p>
      <p style="margin:0 0 1rem 0">يسرّنا الإعلان عن فرصة تطوعية جديدة في النادي، ندعوك للمشاركة:</p>

      <div style="background:#f9fafb;border-radius:10px;padding:1.1rem;margin:1rem 0">
        <div style="font-size:1.05rem;font-weight:800;color:#1A5C2E;margin-bottom:.5rem">${esc(opts.role_name)}</div>
        <div style="font-size:.88rem;color:#4b5563;margin-bottom:.85rem">${esc(opts.project_name)}</div>
        <table style="width:100%;font-size:.86rem;color:#374151;border-collapse:collapse">
          ${opts.event_date ? `<tr><td style="padding:.3rem 0;color:#6b7280;width:30%">📅 التاريخ</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.event_date)}</td></tr>` : ''}
          ${opts.location ? `<tr><td style="padding:.3rem 0;color:#6b7280">📍 الموقع</td><td style="padding:.3rem 0">${esc(opts.location)}</td></tr>` : ''}
          ${opts.committee_name ? `<tr><td style="padding:.3rem 0;color:#6b7280">🏛️ اللجنة</td><td style="padding:.3rem 0">${esc(opts.committee_name)}</td></tr>` : ''}
          <tr><td style="padding:.3rem 0;color:#6b7280">⏱️ ساعات تقديرية</td><td style="padding:.3rem 0">${opts.estimated_hours || 0} ساعة</td></tr>
          <tr><td style="padding:.3rem 0;color:#6b7280">👥 المطلوب</td><td style="padding:.3rem 0">${opts.headcount_needed || 1} متطوع</td></tr>
        </table>
      </div>

      <p style="margin:0 0 1rem 0">إذا كنت مهتماً بالمشاركة، سجّل الدخول إلى بوابة العضو وانتقل إلى تبويب "الفرص التطوعية" واضغط "اهتمام" على هذه الفرصة. سيتواصل معك رئيس اللجنة لتأكيد المشاركة.</p>

      <div style="text-align:center;margin:1.4rem 0">
        <a href="https://ssamau.com/login.html" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.85rem">
          🚪 الدخول لبوابة العضو
        </a>
      </div>
    </div>
    <div style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>`;
}

export const opportunitiesActions: Record<string, Handler> = {
  'opportunities.list':   opportunitiesList,
  'opportunities.create': opportunitiesCreate,
  'opportunities.update': opportunitiesUpdate,
  'opportunities.delete': opportunitiesDelete,
  'opportunities.notify': opportunitiesNotify,
};
