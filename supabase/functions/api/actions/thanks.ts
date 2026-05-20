// Thank-you-email handlers.
//
// Port of the THANKS section from netlify/functions/api.js (lines 799–842).
//
// SMTP wiring (2026-05-15, Eid-Al-Adha readiness): both `thanks.send`
// and `thanks.bulkSend` now actually deliver email via _email.ts's
// sendEmail() helper using the same Google Workspace SMTP path the
// invite + application-notification flows use. The DB row is inserted
// first (so the audit trail exists regardless of SMTP outcome) and then
// status is updated to 'Sent' or 'Failed' based on the send result.
// Pre-existing rows still have status='Logged' from the previous code
// path; that's a separate manual cleanup if the president wants to
// retry them.

import { sql } from '../_sql.ts';
import {
  requireAdminScope, requireAuth, httpErr,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';

// Cheap HTML escaper for free-form text inserted into email bodies.
// The subject + message come from the admin form — we don't trust the
// admin to write XSS-safe HTML, but we also want to render plain text
// nicely. So: escape everything, then turn double newlines into <p>
// boundaries and single newlines into <br>.
function htmlBody(message: string): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const paragraphs = String(message || '').split(/\n\s*\n/);
  // Per-paragraph dir="rtl" + text-align:right so the body renders RTL
  // even in email clients that ignore the html-level dir attribute
  // (most mobile mail apps).
  return paragraphs
    .map(p => '<p dir="rtl" style="margin:0 0 .85rem 0;line-height:1.7;text-align:right">' + esc(p).replace(/\n/g, '<br/>') + '</p>')
    .join('');
}

// Branded HTML shell — same gold/green letterhead the invite emails use
// so recipients recognise the sender visually. Arabic-first RTL.
function thanksEnvelope(message: string): string {
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.05rem;font-weight:800;letter-spacing:.02em">نادي الطلبة السعوديين في ملبورن</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.7);margin-top:.2rem">SSAM · Saudi Students Association in Melbourne</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;text-align:right">
      ${htmlBody(message)}
    </div>
    <div dir="rtl" style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      مع خالص الشكر والتقدير<br/>
      <span style="color:#b8932a;font-weight:700">SSAM Committee</span>
    </div>
  </div>
</body></html>`;
}

// Scope-check a project_id for the caller. Resolves the project's
// owning_committee_id and runs it through requireAdminScope so heads
// can only act on their own committee's projects; admin/superadmin
// pass through. Throws 404 if the project doesn't exist.
async function ensureProjectScope(user: any, project_id: unknown): Promise<void> {
  if (!project_id) throw httpErr('err.required.project_id', 400);
  const [proj] = await sql`
    SELECT owning_committee_id FROM public.projects WHERE project_id = ${project_id}
  ` as Array<{ owning_committee_id: string | null }>;
  if (!proj) throw httpErr('err.notfound.project', 404);
  requireAdminScope(user, proj.owning_committee_id);
}

// Same for a member_id — scope check via the member's committee_id.
// Allows a NULL member_id (volunteer-only thanks/cert) to pass through;
// the project scope is the gate in that case.
async function ensureMemberScope(user: any, member_id: unknown): Promise<void> {
  if (!member_id) return;
  const [mem] = await sql`
    SELECT committee_id FROM public.members WHERE member_id = ${member_id}
  ` as Array<{ committee_id: string | null }>;
  if (!mem) throw httpErr('err.notfound.member', 404);
  requireAdminScope(user, mem.committee_id);
}

// ─── THANKS ──────────────────────────────────────────────────────────
const thanksSend: Handler = async (body, user) => {
  requireAuth(user);
  const data    = (body.data ?? body) as Record<string, unknown>;
  await ensureProjectScope(user, data.project_id);
  await ensureMemberScope(user, data.member_id);
  const to      = (data.recipient_email as string) || '';
  const subject = (data.subject as string) || 'رسالة شكر — نادي الطلبة السعوديين في ملبورن';
  const message = (data.message as string) || '';

  // Insert first so the row exists even if SMTP fails. Status starts as
  // 'Pending' to make the in-flight state visible if the function dies
  // before the UPDATE lands.
  const [r] = await sql`
    INSERT INTO thanks_emails (member_id, project_id, recipient_email, subject, message, status, sent_by)
    VALUES (${data.member_id || null}, ${data.project_id || null},
            ${to || null}, ${subject}, ${message},
            'Pending', ${user!.id})
    RETURNING id
  ` as Array<{ id: number }>;

  let status: 'Sent' | 'Failed' = 'Failed';
  if (to) {
    const ok = await sendEmail({ to, subject, html: thanksEnvelope(message) });
    status = ok ? 'Sent' : 'Failed';
  }
  await sql`UPDATE thanks_emails SET status = ${status} WHERE id = ${r.id}`;
  return { id: r.id, status };
};

const thanksBulkSend: Handler = async (body, user) => {
  requireAuth(user);
  const project_id = body.project_id as string | undefined;
  await ensureProjectScope(user, project_id);
  const subject    = (body.subject as string) || 'رسالة شكر — نادي الطلبة السعوديين في ملبورن';
  const message    = (body.message as string) || '';
  const recipients = await sql`
    SELECT pa.member_id, pa.volunteer_email, m.email AS member_email
    FROM participants pa
    LEFT JOIN members m ON m.member_id = pa.member_id
    WHERE pa.project_id = ${project_id}
  ` as Array<{ member_id: string | null; volunteer_email: string | null; member_email: string | null }>;

  // Render the envelope once and reuse — message is identical for every
  // recipient in a bulk send. Saves work per call when blasting many
  // thank-yous after a big event.
  const html = thanksEnvelope(message);

  let sent = 0;
  let failed = 0;
  for (const rec of recipients) {
    const to = rec.member_email || rec.volunteer_email || null;
    const [r] = await sql`
      INSERT INTO thanks_emails (member_id, project_id, recipient_email, subject, message, status, sent_by)
      VALUES (${rec.member_id || null}, ${project_id},
              ${to}, ${subject}, ${message}, 'Pending', ${user!.id})
      RETURNING id
    ` as Array<{ id: number }>;

    let status: 'Sent' | 'Failed' = 'Failed';
    if (to) {
      const ok = await sendEmail({ to, subject, html });
      status = ok ? 'Sent' : 'Failed';
    }
    await sql`UPDATE thanks_emails SET status = ${status} WHERE id = ${r.id}`;
    if (status === 'Sent') sent++; else failed++;
  }
  return { count: recipients.length, sent, failed };
};

const thanksList: Handler = async (body, user) => {
  requireAuth(user);
  const project_id = body.project_id as string | undefined;
  const member_id  = body.member_id  as string | undefined;
  // If a specific project is requested, scope-check it explicitly so a
  // head can't list another committee's thanks even by guessing IDs.
  if (project_id) await ensureProjectScope(user, project_id);
  if (member_id)  await ensureMemberScope(user, member_id);
  // Otherwise (heads with no project filter), narrow at the SQL level
  // to projects owned by their committee. Admins/superadmins skip this
  // filter and see everything.
  const isHead = user!.access === 'head';
  const committeeFilter = isHead && !project_id && !member_id
    ? sql`AND p.owning_committee_id = ${user!.committee_id}`
    : sql``;
  // sent_by_username + the LATERAL hours subquery feed the admin list
  // view (commit 0674e69's siblings). The hours number is the member's
  // total recorded hours for THIS project — sums FinalApproved
  // `hours` rows plus credited `attendance.meeting_hours`, the same
  // two-source rule recomputeMemberTotalHours uses globally. Lets
  // admins eyeball whether the thank-you matched the hours the member
  // actually earned without bouncing to the hours tab.
  return sql`
    SELECT t.*,
           m.full_name, m.preferred_name,
           p.project_name,
           u.username AS sent_by_username,
           COALESCE((
             SELECT SUM(h.total_hours)
             FROM hours h
             WHERE h.member_id   = t.member_id
               AND h.project_id  = t.project_id
               AND h.approval_status = 'FinalApproved'
           ), 0) +
           COALESCE((
             SELECT SUM(a.meeting_hours)
             FROM attendance a
             WHERE a.member_id   = t.member_id
               AND a.project_id  = t.project_id
               AND a.meeting_hours IS NOT NULL
               AND a.attendance_status <> 'Deleted'
           ), 0) AS recorded_hours
    FROM thanks_emails t
    LEFT JOIN members  m ON m.member_id  = t.member_id
    LEFT JOIN projects p ON p.project_id = t.project_id
    LEFT JOIN users    u ON u.id          = t.sent_by
    WHERE 1=1
      ${project_id ? sql`AND t.project_id = ${project_id}` : sql``}
      ${member_id  ? sql`AND t.member_id  = ${member_id}`  : sql``}
      ${committeeFilter}
    ORDER BY t.sent_at DESC
  `;
};

export const thanksActions: Record<string, Handler> = {
  'thanks.send':     thanksSend,
  'thanks.bulkSend': thanksBulkSend,
  'thanks.list':     thanksList,
};
