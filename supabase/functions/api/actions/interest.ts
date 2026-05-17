// Interest-request handlers.
//
// Port of the INTEREST section from netlify/functions/api.js (lines 761–797).
// All three actions require auth (none are in PUBLIC_ACTIONS) — submit is
// upserted by the (project_id, member_id) unique key so a member can change
// their mind without producing duplicate rows.

import { sql } from '../_sql.ts';
import {
  httpErr, requireAuth, requireAdmin,
  type Handler,
} from '../_helpers.ts';
import { sendEmail } from '../_email.ts';

// ─── INTEREST ────────────────────────────────────────────────────────
// Always uses the caller's own member_id (from auth context). The body's
// `member_id` is ignored — required for both interested:true (express)
// and interested:false (withdraw), so a member can't spoof or revoke
// another member's interest. interested:false is the withdraw path,
// enabled 2026-05-17 alongside the member-portal withdraw button.
const interestSubmit: Handler = async (body, user) => {
  requireAuth(user);
  if (!user!.member_id) throw httpErr('err.auth.no_member_link', 404);
  const data = (body.data ?? body) as Record<string, unknown>;
  if (!data.project_id) throw httpErr('err.required.project_id', 400);
  const interested = data.interested === true || data.interested === 'true';
  await sql`
    INSERT INTO interest_requests (project_id, member_id, interested, availability_type, comment)
    VALUES (${data.project_id}, ${user!.member_id}, ${interested},
            ${data.availability_type || null}, ${data.comment || null})
    ON CONFLICT (project_id, member_id) DO UPDATE SET
      interested        = EXCLUDED.interested,
      availability_type = EXCLUDED.availability_type,
      comment           = EXCLUDED.comment,
      submitted_at      = NOW()
  `;

  // Fire-and-forget admin + head notification — president's spec
  // 2026-05-18. Only fires on EXPRESS (interested=true), not on
  // withdrawal. The committee head of the project's owning committee
  // is included; admins/superadmins always are. Heads OUTSIDE that
  // committee don't get notified — same permission gate the rest of
  // the system uses.
  if (interested) {
    notifyAdminsOfNewInterest({
      project_id:    String(data.project_id),
      member_id:     String(user!.member_id),
      comment:       (data.comment as string | undefined) || null,
    }).catch(err => {
      console.error('[interest.submit] notify failed (row still saved):', err);
    });
  }

  return { ok: true };
};

// Compose + send the new-interest email. One per recipient (no BCC) so
// each admin/head can reply individually if they want to coordinate.
// Recipients deduped via a Set in case the committee head is also an
// admin (the president, who is both).
async function notifyAdminsOfNewInterest(opts: {
  project_id: string;
  member_id: string;
  comment: string | null;
}): Promise<void> {
  // Project + committee + head lookup — same join the audit-trail
  // queries use, kept inline so this module doesn't need a new helper.
  const [proj] = await sql`
    SELECT p.project_id, p.project_name, p.event_date, p.owning_committee_id,
           c.committee_name, c.committee_head_member_id
    FROM   public.projects p
    LEFT JOIN public.committees c ON c.committee_id = p.owning_committee_id
    WHERE  p.project_id = ${opts.project_id}
  ` as Array<{
    project_id: string; project_name: string; event_date: string | null;
    owning_committee_id: string | null;
    committee_name: string | null; committee_head_member_id: string | null;
  }>;
  if (!proj) return;

  const [member] = await sql`
    SELECT member_id, full_name, preferred_name, email, phone, committee_id
    FROM public.members WHERE member_id = ${opts.member_id}
  ` as Array<{
    member_id: string; full_name: string; preferred_name: string | null;
    email: string | null; phone: string | null; committee_id: string | null;
  }>;

  const memberName  = member?.preferred_name || member?.full_name || opts.member_id;
  const memberEmail = member?.email          || '—';
  const memberPhone = member?.phone          || '—';

  // Build recipient set. Admins/superadmins always; committee head if
  // this project belongs to a committee.
  const targets = new Set<string>();
  const admins = await sql`
    SELECT m.email
    FROM public.users u
    JOIN public.members m ON m.member_id = u.member_id
    WHERE u.access_level IN ('admin','superadmin')
      AND m.email IS NOT NULL AND m.email <> ''
  ` as Array<{ email: string }>;
  for (const r of admins) targets.add(r.email);

  if (proj.committee_head_member_id) {
    const [head] = await sql`
      SELECT email FROM public.members WHERE member_id = ${proj.committee_head_member_id}
    ` as Array<{ email: string | null }>;
    if (head?.email) targets.add(head.email);
  }
  if (!targets.size) return;

  const subject = `🙋 اهتمام جديد بفرصة — ${proj.project_name}`;
  const eventDate = proj.event_date ? String(proj.event_date).slice(0, 10) : '';
  const html = renderInterestNotificationHtml({
    member_name:    memberName,
    member_email:   memberEmail,
    member_phone:   memberPhone,
    project_name:   proj.project_name,
    event_date:     eventDate,
    committee_name: proj.committee_name,
    comment:        opts.comment,
  });
  for (const to of targets) {
    try {
      await sendEmail({ to, subject, html });
    } catch (err) {
      console.warn('[interest.notify] send failed for', to, err);
    }
  }
}

function renderInterestNotificationHtml(opts: {
  member_name: string;
  member_email: string;
  member_phone: string;
  project_name: string;
  event_date: string;
  committee_name: string | null;
  comment: string | null;
}): string {
  const esc = (s: string) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Role hint pulled out of the comment — the member-portal expressInterest
  // call sets comment = "{prefix} {role_name}". We display the comment
  // verbatim so the head sees exactly what the member meant.
  const commentBlock = opts.comment
    ? `<div dir="rtl" style="background:#fffbeb;border-inline-start:4px solid #b8932a;padding:.75rem 1rem;border-radius:6px;margin:.85rem 0;font-size:.86rem;line-height:1.7;text-align:right">${esc(opts.comment)}</div>`
    : '';
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">🙋</div>
      <div style="font-size:1.05rem;font-weight:800">اهتمام جديد بفرصة</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">New volunteer interest</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75;text-align:right">
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">السلام عليكم،</p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">سجّل عضو اهتمامه بالمشاركة في الفرصة التالية:</p>

      <div dir="rtl" style="background:#f9fafb;border-radius:10px;padding:1.1rem;margin:1rem 0;text-align:right">
        <div style="font-size:1rem;font-weight:800;color:#1A5C2E;margin-bottom:.5rem">${esc(opts.project_name)}</div>
        <table dir="rtl" style="width:100%;font-size:.86rem;color:#374151;border-collapse:collapse">
          <tr><td style="padding:.3rem 0;color:#6b7280;width:32%">👤 العضو</td><td style="padding:.3rem 0">${esc(opts.member_name)}</td></tr>
          <tr><td style="padding:.3rem 0;color:#6b7280">📧 البريد</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.member_email)}</td></tr>
          <tr><td style="padding:.3rem 0;color:#6b7280">📱 الجوال</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.member_phone)}</td></tr>
          ${opts.committee_name ? `<tr><td style="padding:.3rem 0;color:#6b7280">🏛️ اللجنة</td><td style="padding:.3rem 0">${esc(opts.committee_name)}</td></tr>` : ''}
          ${opts.event_date ? `<tr><td style="padding:.3rem 0;color:#6b7280">📅 التاريخ</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.event_date)}</td></tr>` : ''}
        </table>
      </div>

      ${commentBlock}

      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right;font-size:.85rem;color:#4b5563">يمكنك مراجعة الطلب وإسناد العضو إلى الفرصة من تبويب "طلبات الاهتمام" في لوحة الإدارة.</p>

      <div style="text-align:center;margin:1.4rem 0">
        <a href="https://ssamau.com/admin.html#/admin/interest" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.85rem">
          مراجعة الاهتمام
        </a>
      </div>
    </div>
    <div dir="rtl" style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>`;
}

const interestList: Handler = async (body) => {
  const project_id = body.project_id as string | undefined;
  return sql`
    SELECT ir.*, m.full_name, m.preferred_name, m.email, p.project_name
    FROM interest_requests ir
    LEFT JOIN members  m ON m.member_id  = ir.member_id
    LEFT JOIN projects p ON p.project_id = ir.project_id
    WHERE ir.project_id = ${project_id}
    ORDER BY ir.submitted_at DESC
  `;
};

const interestListAll: Handler = async () => sql`
  SELECT ir.*, m.full_name, m.preferred_name, m.email, p.project_name
  FROM interest_requests ir
  LEFT JOIN members  m ON m.member_id  = ir.member_id
  LEFT JOIN projects p ON p.project_id = ir.project_id
  ORDER BY ir.reviewed_at NULLS FIRST, ir.submitted_at DESC
`;

// Admin triage — flip the reviewed_at timestamp on an interest row so it
// fades to the bottom of the admin tab list. Body: { id, reviewed }.
// reviewed=true sets reviewed_at=NOW(); reviewed=false clears it (admin
// wants to reconsider). Admin-tier only — heads + members shouldn't be
// triaging requests they can't act on.
const interestMarkReviewed: Handler = async (body, user) => {
  requireAdmin(user);
  const id       = body.id as number | undefined;
  const reviewed = body.reviewed !== false;  // default true
  if (!id) throw httpErr('err.required.id', 400);
  await sql`
    UPDATE interest_requests
    SET    reviewed_at = ${reviewed ? sql`NOW()` : null}
    WHERE  id = ${id}
  `;
  return { id, reviewed };
};

// Member-portal self-scoped listing — returns only the caller's interest
// rows so the opportunities tab can pre-mark "✓ مُسجّل" on rows the
// member already expressed interest in. Without this, the button state
// is in-memory only and resets on every reload — members would re-click,
// see the same state-flip again, and assume the site is broken.
// Returns the minimal shape needed for the client-side set lookup.
const interestListOwn: Handler = async (_body, user) => {
  requireAuth(user);
  if (!user.member_id) return [];     // dev account: no member_id → no interests
  return sql`
    SELECT id, project_id, interested, comment, submitted_at, reviewed_at
    FROM interest_requests
    WHERE member_id = ${user.member_id}
  `;
};

export const interestActions: Record<string, Handler> = {
  'interest.submit':       interestSubmit,
  'interest.list':         interestList,
  'interest.listAll':      interestListAll,
  'interest.listOwn':      interestListOwn,
  'interest.markReviewed': interestMarkReviewed,
};
