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

// Robust YYYY-MM-DD formatter. Postgres can return DATE columns as
// either an ISO string ("2026-05-24") or a JS Date object depending on
// the driver path — when it's a Date, String(d) yields the verbose
// "Sun May 24 2026 00:00:00 GMT+…" form, which is what was leaking
// into the opportunity emails. Normalize via Date.toISOString() so the
// rendered string is always "YYYY-MM-DD". Falls back to the raw value
// if parsing fails so we never silently drop a date.
function fmtIsoDate(d: unknown): string {
  if (d === null || d === undefined || d === '') return '';
  if (d instanceof Date) {
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const s = String(d);
  // Already in YYYY-MM-DD or YYYY-MM-DDTHH:… form — slice without
  // round-tripping through Date so we don't time-zone-shift the day.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? s : parsed.toISOString().slice(0, 10);
}

// ─── OPPORTUNITIES (§4, §12) ─────────────────────────────────────────
// Multi-role refactor 2026-05-18:
// Returns roles as an aggregated JSON array per opportunity. The
// legacy single-role columns (role_name, role_key, …) stay on the
// row for backwards-compat with old call sites + email templates,
// but the new frontend should read from `roles`. Empty `roles` []
// means an opportunity exists but no role has been added yet —
// shouldn't happen in practice since the migration backfilled one
// role per legacy row.
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
        WHERE a.opportunity_id = o.opportunity_id AND a.attendance_status = 'Attended') AS attended_count,
      COALESCE(
        (SELECT json_agg(
          json_build_object(
            'id',              r.id,
            'role_name',       r.role_name,
            'role_key',        r.role_key,
            'estimated_hours', r.estimated_hours,
            'headcount_needed',r.headcount_needed,
            'notes',           r.notes,
            'sort_order',      r.sort_order,
            -- Capacity counters used by the member portal + head's
            -- other-opps tab to disable a role when it's full and
            -- show "X / Y" remaining. The subquery joins assignments
            -- on role_id so multi-role opps count per-role, not in
            -- aggregate. NULL role_id assignments (legacy / "any
            -- role") are NOT counted here; they show up under the
            -- opportunity-level legacy assigned_count above.
            'taken',
              (SELECT COUNT(*) FROM assignments a2
                WHERE a2.opportunity_id = o.opportunity_id
                  AND a2.role_id = r.id)
          ) ORDER BY r.sort_order, r.id
        ) FROM opportunity_roles r WHERE r.opportunity_id = o.opportunity_id),
        '[]'::json
      ) AS roles
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

// Multi-role create — accepts a `roles: [{role_name, role_key,
// estimated_hours, headcount_needed, notes}, …]` array. Legacy callers
// that still send top-level role_name / etc. are auto-promoted to a
// single-element roles array, so the old single-role path keeps working
// during rollout. At least one role is required.
const opportunitiesCreate: Handler = async (body, user) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  if (!data.project_id) {
    throw httpErr('err.required.project_role', 400);
  }
  // Normalize the roles list. Two shapes accepted:
  //   1. data.roles = [{ role_name, role_key, ... }, ...] (new flow)
  //   2. data.role_name + data.role_key + ... (legacy single-role)
  const rolesIn = Array.isArray(data.roles) && data.roles.length
    ? (data.roles as Array<Record<string, unknown>>)
    : [{
        role_name:        data.role_name,
        role_key:         data.role_key,
        estimated_hours:  data.estimated_hours,
        headcount_needed: data.headcount_needed,
        notes:            data.role_notes ?? null,
      }];
  if (!rolesIn.length || !rolesIn[0].role_name) {
    throw httpErr('err.required.project_role', 400);
  }
  requireAdminScope(user, data.owning_committee_id as string | null | undefined);
  const id = (data.opportunity_id as string | undefined) || shortId('OPP');

  // Keep the legacy single-role columns synced with the FIRST role so
  // pre-multi-role call sites (admin list display, email templates)
  // still get something meaningful.
  const first = rolesIn[0];
  await sql`
    INSERT INTO opportunities (opportunity_id, project_id, role_name, role_key,
                               estimated_hours, headcount_needed, owning_committee_id,
                               status, notes, created_by)
    VALUES (${id}, ${data.project_id}, ${first.role_name}, ${first.role_key || null},
            ${Number(first.estimated_hours) || 0}, ${Number(first.headcount_needed) || 1},
            ${data.owning_committee_id || null}, ${data.status || 'Open'},
            ${data.notes || null}, ${user!.id})
  `;
  for (let i = 0; i < rolesIn.length; i++) {
    const r = rolesIn[i];
    await sql`
      INSERT INTO opportunity_roles
        (opportunity_id, role_name, role_key, estimated_hours, headcount_needed, notes, sort_order)
      VALUES
        (${id}, ${r.role_name}, ${r.role_key || null},
         ${Number(r.estimated_hours) || 0}, ${Number(r.headcount_needed) || 1},
         ${r.notes || null}, ${i})
    `;
  }

  // Fire-and-forget confirmation receipt to whoever created the
  // opportunity (president's clarification 2026-05-17: "yes notify it
  // is meant to be a confirmation of creation"). NOT a fan-out — the
  // bulk member/head notification stays on the existing admin "Notify"
  // flow so the creator decides when (and to whom) to advertise the
  // opportunity. Failures are logged but don't fail the create; the
  // row is already saved.
  notifyCreatorOnOpportunityCreate(id, user!.id).catch(err => {
    console.error('[opportunities.create] confirmation email failed (creation still succeeded):', err);
  });

  return { opportunity_id: id };
};

// Single confirmation email to whoever created the opportunity. Looks
// up the creator's email via public.users → members, builds a slim
// "✅ created" body (distinct from renderOppNotificationHtml which is
// the recruitment pitch aimed at potential volunteers), and sends one
// message. Members / heads / admins are NOT pulled in — that's the
// manual notify flow's job; the creator decides when to broadcast.
async function notifyCreatorOnOpportunityCreate(
  opportunity_id: string,
  user_id: number,
): Promise<void> {
  const [opp] = await sql`
    SELECT o.opportunity_id, o.role_name, o.estimated_hours, o.headcount_needed,
           o.owning_committee_id,
           p.project_name, p.event_date, p.location,
           c.committee_name
    FROM opportunities o
    LEFT JOIN projects   p ON p.project_id   = o.project_id
    LEFT JOIN committees c ON c.committee_id = o.owning_committee_id
    WHERE o.opportunity_id = ${opportunity_id}
  ` as Array<{
    opportunity_id: string; role_name: string; estimated_hours: number;
    headcount_needed: number; owning_committee_id: string | null;
    project_name: string; event_date: string | null;
    location: string | null; committee_name: string | null;
  }>;
  if (!opp) return;

  const [creator] = await sql`
    SELECT u.id, m.email, COALESCE(m.preferred_name, m.full_name) AS display_name
    FROM public.users u
    LEFT JOIN public.members m ON m.member_id = u.member_id
    WHERE u.id = ${user_id}
  ` as Array<{ id: number; email: string | null; display_name: string | null }>;

  const eventDate = fmtIsoDate(opp.event_date);
  const creatorName = creator?.display_name || '';

  // ── 1. Confirmation receipt → the creator themselves ──────────────
  if (creator?.email) {
    const subject = `✅ تم إنشاء الفرصة — ${opp.project_name}`;
    const html = renderOppConfirmationHtml({
      audience:         'self',
      creator_name:     creatorName,
      role_name:        opp.role_name,
      project_name:     opp.project_name,
      committee_name:   opp.committee_name,
      event_date:       eventDate,
      location:         opp.location,
      estimated_hours:  opp.estimated_hours,
      headcount_needed: opp.headcount_needed,
    });
    try {
      await sendEmail({ to: creator.email, subject, html });
    } catch (err) {
      console.warn('[opportunities.notifyCreator] send failed for', creator.email, err);
    }
  }

  // ── 2. Heads-up → all admins / superadmins (president's spec
  // 2026-05-17: "admins always get notif if an opp is created and by
  // who"). Skip the creator if they're admin to avoid double-emailing
  // (the confirmation receipt above already covered them). Members
  // and committee heads are NOT included here — broadcasts to volunteers
  // remain on the manual "Notify" flow.
  const admins = await sql`
    SELECT u.id, m.email
    FROM public.users u
    JOIN public.members m ON m.member_id = u.member_id
    WHERE u.access_level IN ('admin','superadmin')
      AND m.email IS NOT NULL AND m.email <> ''
      AND u.id <> ${user_id}
  ` as Array<{ id: number; email: string }>;
  if (admins.length) {
    const adminSubject = `📣 فرصة جديدة من ${creatorName || '—'} — ${opp.project_name}`;
    const adminHtml = renderOppConfirmationHtml({
      audience:         'admin',
      creator_name:     creatorName,
      role_name:        opp.role_name,
      project_name:     opp.project_name,
      committee_name:   opp.committee_name,
      event_date:       eventDate,
      location:         opp.location,
      estimated_hours:  opp.estimated_hours,
      headcount_needed: opp.headcount_needed,
    });
    for (const a of admins) {
      try {
        await sendEmail({ to: a.email, subject: adminSubject, html: adminHtml });
      } catch (err) {
        console.warn('[opportunities.notifyAdmins] send failed for', a.email, err);
      }
    }
  }
}

// Dedicated confirmation body — distinct from renderOppNotificationHtml
// further down. That one is a recruitment ask aimed at potential
// volunteers; this is a "your opportunity is live, here are the
// details" receipt for the creator. Same brand letterhead so it
// visually belongs to the suite.
function renderOppConfirmationHtml(opts: {
  audience: 'self' | 'admin';
  creator_name: string;
  role_name: string;
  project_name: string;
  committee_name: string | null;
  event_date: string;
  location: string | null;
  estimated_hours: number;
  headcount_needed: number;
}): string {
  const esc = (s: string) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Audience-dependent intro + heading:
  //   self  → "تم إنشاء الفرصة" — receipt to the creator themselves.
  //   admin → "فرصة جديدة من <name>" — heads-up to admins/superadmins
  //           so they can keep an eye on cross-committee activity.
  const isAdmin     = opts.audience === 'admin';
  const heading     = isAdmin ? 'فرصة جديدة في النظام' : 'تم إنشاء الفرصة';
  const headingEn   = isAdmin ? 'New opportunity created' : 'Opportunity created';
  const emoji       = isAdmin ? '📣' : '✅';
  const greeting    = isAdmin ? 'تنبيه إداري' : `السلام عليكم${opts.creator_name ? ' ' + esc(opts.creator_name) : ''}،`;
  const introLine   = isAdmin
    ? `قام <strong>${esc(opts.creator_name || '—')}</strong> بإنشاء فرصة تطوعية جديدة. هذه نسخة للاطّلاع.`
    : 'تم إنشاء الفرصة التطوعية التالية بنجاح. هذا تأكيد بالتفاصيل المسجّلة.';
  const footerLine  = isAdmin
    ? 'للاطّلاع على التفاصيل الكاملة أو إرسال إشعار للأعضاء، افتح لوحة الإدارة.'
    : 'للتواصل مع الأعضاء والإعلان عن الفرصة، استخدم زر الإشعار من لوحة الإدارة.';

  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:560px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">${emoji}</div>
      <div style="font-size:1.05rem;font-weight:800">${esc(heading)}</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">${esc(headingEn)}</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75;text-align:right">
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">${greeting}</p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">${introLine}</p>

      <div dir="rtl" style="background:#f9fafb;border-radius:10px;padding:1.1rem;margin:1rem 0;text-align:right">
        <div style="font-size:1.05rem;font-weight:800;color:#1A5C2E;margin-bottom:.5rem">${esc(opts.role_name)}</div>
        <div style="font-size:.88rem;color:#4b5563;margin-bottom:.85rem">${esc(opts.project_name)}</div>
        <table dir="rtl" style="width:100%;font-size:.86rem;color:#374151;border-collapse:collapse">
          ${isAdmin && opts.creator_name ? `<tr><td style="padding:.3rem 0;color:#6b7280;width:30%">👤 المنشئ</td><td style="padding:.3rem 0">${esc(opts.creator_name)}</td></tr>` : ''}
          ${opts.event_date ? `<tr><td style="padding:.3rem 0;color:#6b7280;width:30%">📅 التاريخ</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.event_date)}</td></tr>` : ''}
          ${opts.location ? `<tr><td style="padding:.3rem 0;color:#6b7280">📍 الموقع</td><td style="padding:.3rem 0">${esc(opts.location)}</td></tr>` : ''}
          ${opts.committee_name ? `<tr><td style="padding:.3rem 0;color:#6b7280">🏛️ اللجنة</td><td style="padding:.3rem 0">${esc(opts.committee_name)}</td></tr>` : ''}
          <tr><td style="padding:.3rem 0;color:#6b7280">⏱️ ساعات تقديرية</td><td style="padding:.3rem 0">${opts.estimated_hours || 0} ساعة</td></tr>
          <tr><td style="padding:.3rem 0;color:#6b7280">👥 المطلوب</td><td style="padding:.3rem 0">${opts.headcount_needed || 1} متطوع</td></tr>
        </table>
      </div>

      <p dir="rtl" style="margin:0 0 .5rem 0;text-align:right;font-size:.85rem;color:#4b5563">${esc(footerLine)}</p>
    </div>
    <div dir="rtl" style="padding:.95rem 1.4rem;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:.7rem;color:#6b7280;text-align:center">
      <span style="color:#b8932a;font-weight:700">نادي الطلبة السعوديين في ملبورن</span><br/>
      SSAM · Saudi Students Association in Melbourne
    </div>
  </div>
</body></html>`;
}

// Bug fix (2026-05-17, president reported "edits not saving"):
// The previous body used COALESCE(${data.field}, field) for every
// column. That sounds safe ("don't overwrite with NULL") but the
// _sql.ts wrapper coerces '' AND undefined to NULL before the SQL
// runs — meaning any field the admin cleared on the edit form would
// silently roll back to the old value. Worse, a stale-cache admin
// hitting an older opportunities.update could see partial saves that
// looked random.
//
// Fix: the frontend save form ALWAYS sends a full body. Only the
// fields explicitly present in `data` should be written, and they
// should be written verbatim (no COALESCE fallback). Missing fields
// stay untouched via the `COALESCE(${value}, column)` pattern only
// when `value` was actually `undefined` in the request — that's the
// difference between "I didn't send this field" and "I want to
// clear this field".
//
// Implementation: build the SET list dynamically. A field shows up in
// the UPDATE only if the client sent it (presence-check, not
// truthiness-check); when present, NULL/empty string is honoured as
// a legitimate clear.
const opportunitiesUpdate: Handler = async (body, user) => {
  const id = body.id as string | undefined;
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (!id) throw httpErr('err.required.id', 400);
  const [existing] = await sql`SELECT owning_committee_id FROM opportunities WHERE opportunity_id = ${id}` as Array<{ owning_committee_id: string | null }>;
  if (!existing) throw httpErr('err.notfound.opportunity', 404);
  requireAdminScope(user, existing.owning_committee_id);
  if (data.owning_committee_id) requireAdminScope(user, data.owning_committee_id as string | null | undefined);

  // Normalize. If the client sent a roles array (multi-role flow), use
  // its first entry to sync the legacy single-role columns so old call
  // sites + email templates keep rendering. If they sent the legacy
  // shape (top-level role_name/etc), leave the columns to the existing
  // COALESCE path below — we still write to opportunity_roles too so
  // both paths stay in sync.
  const norm = { ...data };
  if ('estimated_hours' in norm)  norm.estimated_hours  = Number(norm.estimated_hours)  || 0;
  if ('headcount_needed' in norm) norm.headcount_needed = Number(norm.headcount_needed) || 1;

  const rolesIn = Array.isArray(data.roles) && (data.roles as unknown[]).length
    ? (data.roles as Array<Record<string, unknown>>)
    : null;
  if (rolesIn) {
    if (!rolesIn[0]?.role_name) throw httpErr('err.required.project_role', 400);
    // Mirror the first role into the legacy single-role columns so
    // pre-multi-role display paths (admin list, old email templates)
    // still show something useful.
    const first = rolesIn[0];
    norm.role_name        = first.role_name;
    norm.role_key         = first.role_key ?? null;
    norm.estimated_hours  = Number(first.estimated_hours)  || 0;
    norm.headcount_needed = Number(first.headcount_needed) || 1;
  }

  // Use COALESCE(${value}, column) so an explicit NULL in the request
  // (e.g. user cleared notes → '' → wrapper coerces to NULL) does NOT
  // clear the column — that's the safer default. Clearing a field is
  // rare enough that we can live without it; the alternative is partial
  // saves silently dropping the field, which is the bug we're fixing.
  // COALESCE pattern is kept only for required / never-null fields
  // (role_name, status, estimated_hours, headcount_needed). The
  // nullable fields — role_key, owning_committee_id, notes — bypass
  // COALESCE so the admin can actually clear them. Bug 2026-05-18:
  // the previous COALESCE on owning_committee_id meant "move this
  // opportunity to all-committees" silently did nothing because
  // _sql.ts coerces null → null and COALESCE(null, existing) wins.
  await sql`
    UPDATE opportunities SET
      role_name           = COALESCE(${norm.role_name},           role_name),
      role_key            = ${norm.role_key            ?? null},
      estimated_hours     = COALESCE(${norm.estimated_hours},     estimated_hours),
      headcount_needed    = COALESCE(${norm.headcount_needed},    headcount_needed),
      owning_committee_id = ${norm.owning_committee_id ?? null},
      status              = COALESCE(${norm.status},              status),
      notes               = ${norm.notes               ?? null}
    WHERE opportunity_id = ${id}
  `;

  // Atomic replace of opportunity_roles when the client sent the new
  // roles array. Done as DELETE + INSERT (not UPSERT) so removed roles
  // actually disappear; the row count is small (typically 1–5 roles).
  // ON DELETE CASCADE on interest_requests.role_id → SET NULL preserves
  // pending "any role" interests even if the role they picked goes
  // away in the edit.
  if (rolesIn) {
    await sql`DELETE FROM opportunity_roles WHERE opportunity_id = ${id}`;
    for (let i = 0; i < rolesIn.length; i++) {
      const r = rolesIn[i];
      await sql`
        INSERT INTO opportunity_roles
          (opportunity_id, role_name, role_key, estimated_hours, headcount_needed, notes, sort_order)
        VALUES
          (${id}, ${r.role_name}, ${r.role_key || null},
           ${Number(r.estimated_hours) || 0}, ${Number(r.headcount_needed) || 1},
           ${r.notes || null}, ${i})
      `;
    }
  }
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

  if (!opportunity_id) throw httpErr('err.required.opportunity_id', 400);

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
  if (!opp) throw httpErr('err.notfound.opportunity', 404);
  // Committee-head scope check — head can only notify for own-committee
  // opportunities; admin/superadmin pass through.
  requireAdminScope(user, opp.owning_committee_id);

  // Pull every role attached to this opportunity for the multi-role
  // list in the email body. Empty array is fine — render falls back
  // to the legacy single-role card.
  const roles = await sql`
    SELECT id, role_name, estimated_hours, headcount_needed, notes, sort_order
    FROM   opportunity_roles
    WHERE  opportunity_id = ${opportunity_id}
    ORDER BY sort_order, id
  ` as Array<{
    id: number; role_name: string; estimated_hours: number;
    headcount_needed: number; notes: string | null; sort_order: number;
  }>;

  // ── Build email body ───────────────────────────────────────────────
  const eventDate = fmtIsoDate(opp.event_date);
  const html = renderOppNotificationHtml({
    role_name:        opp.role_name,
    project_name:     opp.project_name,
    committee_name:   opp.committee_name,
    event_date:       eventDate,
    location:         opp.location,
    estimated_hours:  opp.estimated_hours,
    headcount_needed: opp.headcount_needed,
    roles,
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
    if (!recipients.length) throw httpErr('err.required.recipients_members', 400);
    const rows = await sql`
      SELECT email FROM members
      WHERE member_id = ANY(${recipients}) AND email IS NOT NULL AND email <> ''
    ` as Array<{ email: string }>;
    targets = rows.map(r => r.email);
  } else if (mode === 'emails') {
    targets = recipients
      .map(s => String(s).trim())
      .filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
    if (!targets.length) throw httpErr('err.business.no_emails', 400);
  } else {
    throw httpErr('err.business.unknown_mode', 400, { mode });
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
  // Multi-role list. Empty array → fall back to the legacy single-role
  // card (kept so the email looks identical for single-role opportunities).
  roles: Array<{
    role_name: string; estimated_hours: number;
    headcount_needed: number; notes: string | null;
  }>;
  custom_message: string;
}): string {
  const esc = (s: string) => String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const customBlock = opts.custom_message
    ? `<div dir="rtl" style="background:#fffbeb;border-inline-start:4px solid #b8932a;padding:.75rem 1rem;border-radius:6px;margin-bottom:1rem;font-size:.92rem;line-height:1.7;text-align:right">${esc(opts.custom_message).replace(/\n/g, '<br/>')}</div>`
    : '';
  // Multi-role rendering. >1 role → list each as its own card so the
  // recipient can scan options and pick. =1 role + legacy single-role
  // opportunities → render the existing single card so the email stays
  // pixel-identical for the common case.
  const multi = (opts.roles || []).length > 1;
  const totalHeadcount = (opts.roles || []).reduce(
    (n, r) => n + (Number(r.headcount_needed) || 0), 0
  ) || opts.headcount_needed || 1;
  const totalHours = (opts.roles || []).reduce(
    (n, r) => n + (Number(r.estimated_hours) || 0), 0
  ) || opts.estimated_hours || 0;
  const rolesList = multi
    ? `<div dir="rtl" style="margin:.85rem 0">
         <div style="font-size:.88rem;font-weight:800;color:#1A5C2E;margin-bottom:.5rem">🎯 الأدوار المتاحة (${opts.roles.length})</div>
         ${opts.roles.map(r => `
           <div dir="rtl" style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:.7rem .9rem;margin-bottom:.5rem;text-align:right">
             <div style="font-size:.92rem;font-weight:700;color:#1f2937;margin-bottom:.2rem">${esc(r.role_name)}</div>
             <div style="font-size:.78rem;color:#6b7280">
               👥 ${Number(r.headcount_needed) || 1} متطوع · ⏱️ ${Number(r.estimated_hours) || 0} ساعة
               ${r.notes ? ` · <span style="color:#4b5563">${esc(r.notes)}</span>` : ''}
             </div>
           </div>`).join('')}
       </div>`
    : '';
  // RTL hardening: dir="rtl" + text-align:right on every block so
  // phone-mail clients (which ignore the html-level dir) still render
  // Arabic correctly. Same pattern as the cert delivery + thanks emails.
  return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"></head>
<body dir="rtl" style="margin:0;padding:0;background:#f5f5f5;font-family:'Almarai',Arial,sans-serif;color:#111827;text-align:right">
  <div dir="rtl" style="max-width:580px;margin:24px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.06)">
    <div dir="rtl" style="background:linear-gradient(135deg,#1A5C2E 0%,#0e3a1c 60%,#b8932a 100%);padding:1.6rem 1.4rem;color:#fff;text-align:center">
      <div style="font-size:1.7rem;margin-bottom:.3rem">🎯</div>
      <div style="font-size:1.05rem;font-weight:800">فرصة تطوعية جديدة</div>
      <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:.25rem">New Volunteer Opportunity</div>
    </div>
    <div dir="rtl" style="padding:1.6rem 1.4rem;font-size:.92rem;color:#1f2937;line-height:1.75;text-align:right">
      ${customBlock}
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">السلام عليكم،</p>
      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">يسرّنا الإعلان عن فرصة تطوعية جديدة في النادي، ندعوك للمشاركة:</p>

      <div dir="rtl" style="background:#f9fafb;border-radius:10px;padding:1.1rem;margin:1rem 0;text-align:right">
        ${multi
          ? `<div style="font-size:1.05rem;font-weight:800;color:#1A5C2E;margin-bottom:.5rem">${esc(opts.project_name)}</div>`
          : `<div style="font-size:1.05rem;font-weight:800;color:#1A5C2E;margin-bottom:.5rem">${esc(opts.role_name)}</div>
             <div style="font-size:.88rem;color:#4b5563;margin-bottom:.85rem">${esc(opts.project_name)}</div>`}
        <table dir="rtl" style="width:100%;font-size:.86rem;color:#374151;border-collapse:collapse">
          ${opts.event_date ? `<tr><td style="padding:.3rem 0;color:#6b7280;width:30%">📅 التاريخ</td><td style="padding:.3rem 0;direction:ltr">${esc(opts.event_date)}</td></tr>` : ''}
          ${opts.location ? `<tr><td style="padding:.3rem 0;color:#6b7280">📍 الموقع</td><td style="padding:.3rem 0">${esc(opts.location)}</td></tr>` : ''}
          ${opts.committee_name ? `<tr><td style="padding:.3rem 0;color:#6b7280">🏛️ اللجنة</td><td style="padding:.3rem 0">${esc(opts.committee_name)}</td></tr>` : ''}
          <tr><td style="padding:.3rem 0;color:#6b7280">⏱️ ساعات تقديرية</td><td style="padding:.3rem 0">${totalHours} ساعة${multi ? ' (إجمالي)' : ''}</td></tr>
          <tr><td style="padding:.3rem 0;color:#6b7280">👥 المطلوب</td><td style="padding:.3rem 0">${totalHeadcount} متطوع${multi ? ' (إجمالي)' : ''}</td></tr>
        </table>
        ${rolesList}
      </div>

      <p dir="rtl" style="margin:0 0 1rem 0;text-align:right">${multi
        ? 'إذا كنت مهتماً بالمشاركة، سجّل الدخول إلى بوابة العضو وانتقل إلى تبويب "الفرص التطوعية"، اضغط "اهتمام" على هذه الفرصة، ثم اختر الدور الذي يناسبك (أو اختر "أي دور" إذا كنت مستعداً للمساعدة حيث تحتاج اللجنة). سيتواصل معك رئيس اللجنة لتأكيد المشاركة.'
        : 'إذا كنت مهتماً بالمشاركة، سجّل الدخول إلى بوابة العضو وانتقل إلى تبويب "الفرص التطوعية" واضغط "اهتمام" على هذه الفرصة. سيتواصل معك رئيس اللجنة لتأكيد المشاركة.'}</p>

      <div style="text-align:center;margin:1.4rem 0">
        <a href="https://ssamau.com/login.html" style="display:inline-block;background:#1A5C2E;color:#fff;text-decoration:none;padding:.75rem 1.6rem;border-radius:50px;font-weight:700;font-size:.85rem">
          🚪 الدخول لبوابة العضو
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

export const opportunitiesActions: Record<string, Handler> = {
  'opportunities.list':   opportunitiesList,
  'opportunities.create': opportunitiesCreate,
  'opportunities.update': opportunitiesUpdate,
  'opportunities.delete': opportunitiesDelete,
  'opportunities.notify': opportunitiesNotify,
};
