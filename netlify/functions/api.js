// SSAMAU API — single endpoint, action-based router.
// Mirrors the Google Apps Script surface 1:1 so the existing admin.html keeps working
// after only changing the API URL constant.

import bcrypt from 'bcryptjs';
import { getSql, shortId, ok, fail } from './_db.js';
import {
  signToken, verifyToken,
  PUBLIC_ACTIONS, SUPERADMIN_ACTIONS,
  requireAuth, requireSuperadmin, requireAdminScope,
} from './_auth.js';

// Populated on first request by `getSql()`. Handlers below reference `sql`
// from this module scope, so once it's assigned every existing call site
// (including nested SQL fragments) works without further changes.
let sql;

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  let body;
  try { body = await req.json(); } catch { return fail('Invalid JSON body'); }

  const action = body.action;
  if (!action) return fail('Missing action');

  const handler = handlers[action];
  if (!handler) return fail(`Action not found: ${action}`);

  let user = null;
  if (!PUBLIC_ACTIONS.has(action)) {
    user = verifyToken(req.headers.get('authorization'));
    if (!user) return fail('Unauthorized', 401);
    if (SUPERADMIN_ACTIONS.has(action) && user.access !== 'superadmin') {
      return fail('Forbidden — superadmin only', 403);
    }
  }

  try {
    if (!sql) sql = await getSql();
    const data = await handler(body, user);
    const res = ok(data);
    for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v);
    return res;
  } catch (e) {
    console.error(`[${action}]`, e);
    return fail(e.message || 'Server error', e.status || 500);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ════════════════════════════════════════════════════════════════════════
// HANDLERS
// ════════════════════════════════════════════════════════════════════════

const handlers = {
  // ─── AUTH ────────────────────────────────────────────────────────────
  auth: async ({ username, password }) => {
    if (!username || !password) throw httpErr('Missing credentials', 400);
    const rows = await sql`
      SELECT u.id, u.username, u.password_hash, u.access_level, u.member_id,
             m.full_name, m.preferred_name, m.committee_id
      FROM users u
      LEFT JOIN members m ON m.member_id = u.member_id
      WHERE LOWER(u.username) = LOWER(${username})
      LIMIT 1
    `;
    const u = rows[0];
    if (!u) throw httpErr('Invalid credentials', 401);
    const okPw = await bcrypt.compare(password, u.password_hash);
    if (!okPw) throw httpErr('Invalid credentials', 401);
    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${u.id}`;
    const token = signToken(u);
    return {
      token,
      user: {
        id: u.id,
        username: u.username,
        name: u.preferred_name || u.full_name,
        role: u.access_level,
        access: u.access_level,
        member_id: u.member_id,
        committee_id: u.committee_id,
      },
    };
  },

  // ─── MEMBERS ─────────────────────────────────────────────────────────
  getMembers: async () => sql`
    SELECT * FROM members
    ORDER BY
      CASE club_role
        WHEN 'President' THEN 1
        WHEN 'Vice President' THEN 2
        WHEN 'Deputy Vice President' THEN 3
        WHEN 'Committee Head' THEN 4
        WHEN 'Committee Vice Head' THEN 5
        ELSE 9
      END,
      full_name
  `,

  createMember: async (body, user) => {
    const data = body.data || body;
    requireAdminScope(user, data.committee_id);
    const id = data.member_id || shortId('MBR');
    await sql`
      INSERT INTO members (member_id, full_name, preferred_name, email, phone, gender,
                           profile_photo_url, committee_id, club_role, status, join_date, total_hours)
      VALUES (${id}, ${data.full_name}, ${data.preferred_name || null}, ${data.email || null},
              ${data.phone || null}, ${data.gender || null}, ${data.profile_photo_url || null},
              ${data.committee_id || null}, ${data.club_role || 'Member'},
              ${data.status || 'Active'}, ${data.join_date || null}, ${data.total_hours || 0})
    `;
    return { member_id: id };
  },

  updateMember: async ({ id, data }, user) => {
    const [existing] = await sql`SELECT committee_id FROM members WHERE member_id = ${id}`;
    if (!existing) throw httpErr('Member not found', 404);
    requireAdminScope(user, existing.committee_id);
    if (data.committee_id && data.committee_id !== existing.committee_id) {
      requireAdminScope(user, data.committee_id);
    }
    await sql`
      UPDATE members SET
        full_name         = COALESCE(${data.full_name},         full_name),
        preferred_name    = COALESCE(${data.preferred_name},    preferred_name),
        email             = COALESCE(${data.email},             email),
        phone             = COALESCE(${data.phone},             phone),
        gender            = COALESCE(${data.gender},            gender),
        profile_photo_url = COALESCE(${data.profile_photo_url}, profile_photo_url),
        committee_id      = COALESCE(${data.committee_id},      committee_id),
        club_role         = COALESCE(${data.club_role},         club_role),
        status            = COALESCE(${data.status},            status),
        join_date         = COALESCE(${data.join_date},         join_date)
      WHERE member_id = ${id}
    `;
    return { member_id: id };
  },

  deleteMember: async ({ id }) => {
    await sql`DELETE FROM members WHERE member_id = ${id}`;
    return { member_id: id };
  },

  // ─── ADVISORS ────────────────────────────────────────────────────────
  getAdvisors: async () => sql`
    SELECT id AS advisor_id, id, full_name, advisory_role, email, phone, notes,
           status, created_at, updated_at
    FROM advisors ORDER BY full_name
  `,

  createAdvisor: async (body) => {
    const data = body.data || body;
    const [r] = await sql`
      INSERT INTO advisors (full_name, advisory_role, email, phone, notes, status)
      VALUES (${data.full_name}, ${data.advisory_role || null}, ${data.email || null},
              ${data.phone || null}, ${data.notes || null}, ${data.status || 'Active'})
      RETURNING id
    `;
    return { id: r.id, advisor_id: r.id };
  },

  updateAdvisor: async ({ id, data }) => {
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
  },

  deleteAdvisor: async ({ id }) => {
    await sql`DELETE FROM advisors WHERE id = ${id}`;
    return { id };
  },

  // ─── COMMITTEES ──────────────────────────────────────────────────────
  getCommittees: async () => sql`
    SELECT c.*,
      (SELECT COUNT(*) FROM members m WHERE m.committee_id = c.committee_id AND m.status='Active') AS member_count
    FROM committees c
    ORDER BY c.committee_id
  `,

  createCommittee: async (body) => {
    const data = body.data || body;
    const id = data.committee_id || shortId('COM', 4);
    await sql`
      INSERT INTO committees (committee_id, committee_name, committee_description,
                              committee_head_member_id, committee_vice_head_member_id, status)
      VALUES (${id}, ${data.committee_name}, ${data.committee_description || null},
              ${data.committee_head_member_id || null},
              ${data.committee_vice_head_member_id || null},
              ${data.status || 'Active'})
    `;
    return { committee_id: id };
  },

  updateCommittee: async ({ id, data }) => {
    await sql`
      UPDATE committees SET
        committee_name                = COALESCE(${data.committee_name},                committee_name),
        committee_description         = COALESCE(${data.committee_description},         committee_description),
        committee_head_member_id      = COALESCE(${data.committee_head_member_id},      committee_head_member_id),
        committee_vice_head_member_id = COALESCE(${data.committee_vice_head_member_id}, committee_vice_head_member_id),
        status                        = COALESCE(${data.status},                        status)
      WHERE committee_id = ${id}
    `;
    return { committee_id: id };
  },

  deleteCommittee: async ({ id }) => {
    await sql`DELETE FROM committees WHERE committee_id = ${id}`;
    return { committee_id: id };
  },

  // ─── PROJECTS / EVENTS ───────────────────────────────────────────────
  getProjects: async () => sql`
    SELECT p.*,
      (SELECT COUNT(*) FROM participants pa WHERE pa.project_id = p.project_id) AS participant_count
    FROM projects p
    ORDER BY p.event_date DESC NULLS LAST, p.created_at DESC
  `,

  createProject: async (body) => {
    const data = body.data || body;
    const id = data.project_id || shortId('PRJ');
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
  },

  updateProject: async ({ id, data }, user) => {
    if (user.access === 'head') {
      const [p] = await sql`SELECT owning_committee_id FROM projects WHERE project_id = ${id}`;
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
  },

  deleteProject: async ({ id }) => {
    await sql`DELETE FROM projects WHERE project_id = ${id}`;
    return { project_id: id };
  },

  // ─── PARTICIPANTS ────────────────────────────────────────────────────
  addParticipant: async (body, user) => {
    requireAuth(user);
    const data = body.data || body;
    const [r] = await sql`
      INSERT INTO participants (project_id, participant_type, member_id, volunteer_name, volunteer_email)
      VALUES (${data.project_id}, ${data.participant_type},
              ${data.member_id || null}, ${data.volunteer_name || null}, ${data.volunteer_email || null})
      RETURNING id
    `;
    return { id: r.id, participant_id: r.id };
  },

  removeParticipant: async ({ id }) => {
    await sql`DELETE FROM participants WHERE id = ${id}`;
    return { id };
  },

  getParticipants: async ({ project_id }) => sql`
    SELECT pa.id AS participant_id, pa.*,
           m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           m.email AS member_email
    FROM participants pa
    LEFT JOIN members m ON m.member_id = pa.member_id
    WHERE ${project_id ? sql`pa.project_id = ${project_id}` : sql`TRUE`}
    ORDER BY pa.created_at
  `,

  'participants.list': async (body) => handlers.getParticipants(body),

  // ─── ATTENDANCE ──────────────────────────────────────────────────────
  recordAttendance: async (body, user) => {
    const data = body.data || body;
    const [r] = await sql`
      INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                              attendance_status, notes, recorded_by)
      VALUES (${data.project_id}, ${data.participant_id || null},
              ${data.member_id || null}, ${data.volunteer_email || null},
              ${data.attendance_status || 'Present'}, ${data.notes || null}, ${user.id})
      RETURNING id
    `;
    return { id: r.id, attendance_id: r.id };
  },

  'attendance.bulkRecord': async ({ project_id, records }, user) => {
    if (!Array.isArray(records) || records.length === 0) return { count: 0 };
    let count = 0;
    for (const r of records) {
      // Upsert by (project_id, participant_id) — last write wins.
      const existing = r.participant_id ? await sql`
        SELECT id FROM attendance
        WHERE project_id = ${project_id} AND participant_id = ${r.participant_id}
        ORDER BY recorded_at DESC LIMIT 1
      ` : [];
      if (existing.length) {
        await sql`
          UPDATE attendance
          SET attendance_status = ${r.attendance_status},
              notes = ${r.notes || null},
              recorded_by = ${user.id}
          WHERE id = ${existing[0].id}
        `;
      } else {
        await sql`
          INSERT INTO attendance (project_id, participant_id, member_id, volunteer_email,
                                  attendance_status, notes, recorded_by)
          VALUES (${project_id}, ${r.participant_id || null},
                  ${r.member_id || null}, ${r.volunteer_email || null},
                  ${r.attendance_status}, ${r.notes || null}, ${user.id})
        `;
      }
      count++;
    }
    return { count };
  },

  'attendance.list': async ({ project_id }) => sql`
    SELECT a.id AS attendance_id, a.*,
           m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           p.project_name
    FROM attendance a
    LEFT JOIN members m  ON m.member_id  = a.member_id
    LEFT JOIN projects p ON p.project_id = a.project_id
    WHERE ${project_id ? sql`a.project_id = ${project_id}` : sql`TRUE`}
      AND a.attendance_status <> 'Deleted'
    ORDER BY a.recorded_at DESC
  `,

  getAttendance: async (body) => handlers['attendance.list'](body),

  // FIXES THE BUG: this action did not exist in Apps Script.
  updateAttendance: async ({ id, data }) => {
    await sql`
      UPDATE attendance SET
        attendance_status = COALESCE(${data.attendance_status}, attendance_status),
        notes             = COALESCE(${data.notes},             notes)
      WHERE id = ${id}
    `;
    return { id };
  },

  // ─── HOURS ───────────────────────────────────────────────────────────
  recordHours: async (body, user) => {
    const data = body.data || body;
    const before = parseFloat(data.hours_before) || 0;
    const during = parseFloat(data.hours_during) || 0;
    const after  = parseFloat(data.hours_after)  || 0;
    const [r] = await sql`
      INSERT INTO hours (project_id, member_id, volunteer_email, participant_type,
                         hours_before, hours_during, hours_after,
                         notes, recorded_by, recorded_by_member_id)
      VALUES (${data.project_id}, ${data.member_id || null}, ${data.volunteer_email || null},
              ${data.participant_type || null},
              ${before}, ${during}, ${after},
              ${data.notes || null}, ${user.id}, ${data.recorded_by_member_id || null})
      RETURNING id, total_hours
    `;
    if (data.member_id) {
      await sql`
        UPDATE members SET total_hours = (
          SELECT COALESCE(SUM(total_hours), 0) FROM hours WHERE member_id = ${data.member_id} AND notes IS DISTINCT FROM 'Deleted'
        ) WHERE member_id = ${data.member_id}
      `;
    }
    return { id: r.id, hours_id: r.id, total_hours: r.total_hours };
  },

  // FIXES THE BUG: this action did not exist in Apps Script.
  updateHours: async ({ id, data }) => {
    const [row] = await sql`SELECT member_id FROM hours WHERE id = ${id}`;
    await sql`
      UPDATE hours SET
        hours_before = COALESCE(${data.hours_before}, hours_before),
        hours_during = COALESCE(${data.hours_during}, hours_during),
        hours_after  = COALESCE(${data.hours_after},  hours_after),
        notes        = COALESCE(${data.notes},        notes)
      WHERE id = ${id}
    `;
    if (row?.member_id) {
      await sql`
        UPDATE members SET total_hours = (
          SELECT COALESCE(SUM(total_hours), 0) FROM hours WHERE member_id = ${row.member_id} AND notes IS DISTINCT FROM 'Deleted'
        ) WHERE member_id = ${row.member_id}
      `;
    }
    return { id };
  },

  getMemberHours: async ({ member_id, project_id }) => sql`
    SELECT h.id AS hours_id, h.*, p.project_name, p.event_date,
           m.full_name AS member_full_name, m.preferred_name AS member_preferred_name
    FROM hours h
    LEFT JOIN projects p ON p.project_id = h.project_id
    LEFT JOIN members m  ON m.member_id  = h.member_id
    WHERE (h.notes IS DISTINCT FROM 'Deleted')
      ${member_id  ? sql`AND h.member_id  = ${member_id}`  : sql``}
      ${project_id ? sql`AND h.project_id = ${project_id}` : sql``}
    ORDER BY h.recorded_at DESC
  `,

  // ─── INTEREST ────────────────────────────────────────────────────────
  'interest.submit': async (body) => {
    const data = body.data || body;
    await sql`
      INSERT INTO interest_requests (project_id, member_id, interested, availability_type, comment)
      VALUES (${data.project_id}, ${data.member_id}, ${data.interested},
              ${data.availability_type || null}, ${data.comment || null})
      ON CONFLICT (project_id, member_id) DO UPDATE SET
        interested        = EXCLUDED.interested,
        availability_type = EXCLUDED.availability_type,
        comment           = EXCLUDED.comment,
        submitted_at      = NOW()
    `;
    return { ok: true };
  },

  'interest.list': async ({ project_id }) => sql`
    SELECT ir.*, m.full_name, m.preferred_name, m.email, p.project_name
    FROM interest_requests ir
    LEFT JOIN members  m ON m.member_id  = ir.member_id
    LEFT JOIN projects p ON p.project_id = ir.project_id
    WHERE ir.project_id = ${project_id}
    ORDER BY ir.submitted_at DESC
  `,

  'interest.listAll': async () => sql`
    SELECT ir.*, m.full_name, m.preferred_name, m.email, p.project_name
    FROM interest_requests ir
    LEFT JOIN members  m ON m.member_id  = ir.member_id
    LEFT JOIN projects p ON p.project_id = ir.project_id
    ORDER BY ir.submitted_at DESC
  `,

  // ─── THANKS ──────────────────────────────────────────────────────────
  // Email sending is intentionally NOT wired up here — the Apps Script version uses
  // GmailApp under the club's Google account. Sending real email from Netlify needs
  // a separate provider (Resend / Postmark / SendGrid). For now we record the entry
  // with status='Logged' so the UI keeps working; flip to status='Sent' once an
  // email provider is wired in.
  'thanks.send': async (body, user) => {
    const data = body.data || body;
    const [r] = await sql`
      INSERT INTO thanks_emails (member_id, project_id, recipient_email, subject, message, status, sent_by)
      VALUES (${data.member_id || null}, ${data.project_id || null},
              ${data.recipient_email || null}, ${data.subject}, ${data.message},
              'Logged', ${user.id})
      RETURNING id
    `;
    return { id: r.id };
  },

  'thanks.bulkSend': async ({ project_id, subject, message }, user) => {
    const recipients = await sql`
      SELECT pa.member_id, pa.volunteer_email, m.email AS member_email
      FROM participants pa
      LEFT JOIN members m ON m.member_id = pa.member_id
      WHERE pa.project_id = ${project_id}
    `;
    let count = 0;
    for (const rec of recipients) {
      await sql`
        INSERT INTO thanks_emails (member_id, project_id, recipient_email, subject, message, status, sent_by)
        VALUES (${rec.member_id || null}, ${project_id},
                ${rec.member_email || rec.volunteer_email || null},
                ${subject}, ${message}, 'Logged', ${user.id})
      `;
      count++;
    }
    return { count };
  },

  'thanks.list': async ({ project_id, member_id }) => sql`
    SELECT t.*, m.full_name, m.preferred_name, p.project_name
    FROM thanks_emails t
    LEFT JOIN members  m ON m.member_id  = t.member_id
    LEFT JOIN projects p ON p.project_id = t.project_id
    WHERE 1=1
      ${project_id ? sql`AND t.project_id = ${project_id}` : sql``}
      ${member_id  ? sql`AND t.member_id  = ${member_id}`  : sql``}
    ORDER BY t.sent_at DESC
  `,

  // ─── CERTIFICATES ────────────────────────────────────────────────────
  'certs.issue': async (body, user) => {
    const data = body.data || body;
    const code = shortId('CRT', 8);
    const [r] = await sql`
      INSERT INTO certificates (cert_code, member_id, project_id, recipient_name, recipient_email,
                                role, hours, issued_by)
      VALUES (${code}, ${data.member_id || null}, ${data.project_id},
              ${data.recipient_name || null}, ${data.recipient_email || null},
              ${data.role || null}, ${data.hours || null}, ${user.id})
      RETURNING id
    `;
    return { id: r.id, cert_code: code };
  },

  'certs.bulkIssue': async ({ project_id, role }, user) => {
    const participants = await sql`
      SELECT pa.member_id, pa.volunteer_name, pa.volunteer_email,
             m.full_name, m.preferred_name, m.email AS member_email,
             COALESCE(SUM(h.total_hours), 0) AS hours
      FROM participants pa
      LEFT JOIN members m ON m.member_id = pa.member_id
      LEFT JOIN hours   h ON h.project_id = pa.project_id AND h.member_id = pa.member_id
                          AND h.notes IS DISTINCT FROM 'Deleted'
      WHERE pa.project_id = ${project_id}
        AND NOT EXISTS (
          SELECT 1 FROM certificates c
          WHERE c.project_id = ${project_id}
            AND ((c.member_id IS NOT NULL AND c.member_id = pa.member_id)
              OR (c.recipient_email IS NOT NULL AND c.recipient_email = pa.volunteer_email))
        )
      GROUP BY pa.id, pa.member_id, pa.volunteer_name, pa.volunteer_email,
               m.full_name, m.preferred_name, m.email
    `;
    let count = 0;
    for (const p of participants) {
      const code = shortId('CRT', 8);
      await sql`
        INSERT INTO certificates (cert_code, member_id, project_id, recipient_name, recipient_email,
                                  role, hours, issued_by)
        VALUES (${code}, ${p.member_id || null}, ${project_id},
                ${p.preferred_name || p.full_name || p.volunteer_name || null},
                ${p.member_email || p.volunteer_email || null},
                ${role || null}, ${p.hours || 0}, ${user.id})
      `;
      count++;
    }
    return { count };
  },

  'certs.list': async ({ project_id, member_id }) => sql`
    SELECT c.*, m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
           p.project_name
    FROM certificates c
    LEFT JOIN members  m ON m.member_id  = c.member_id
    LEFT JOIN projects p ON p.project_id = c.project_id
    WHERE 1=1
      ${project_id ? sql`AND c.project_id = ${project_id}` : sql``}
      ${member_id  ? sql`AND c.member_id  = ${member_id}`  : sql``}
    ORDER BY c.issued_at DESC
  `,

  'certs.verify': async ({ cert_code }) => {
    if (!cert_code) throw httpErr('Missing cert_code', 400);
    const [c] = await sql`
      SELECT c.cert_code, c.recipient_name, c.role, c.hours, c.issued_at,
             m.full_name AS member_full_name, m.preferred_name,
             p.project_name, p.event_date
      FROM certificates c
      LEFT JOIN members  m ON m.member_id  = c.member_id
      LEFT JOIN projects p ON p.project_id = c.project_id
      WHERE c.cert_code = ${cert_code}
      LIMIT 1
    `;
    if (!c) return { valid: false };
    return { valid: true, certificate: c };
  },

  // ─── DASHBOARD ───────────────────────────────────────────────────────
  getDashboardStats: async () => {
    const [counts] = await sql`
      SELECT
        (SELECT COUNT(*) FROM members WHERE status='Active')    AS active_members,
        (SELECT COUNT(*) FROM members)                          AS total_members,
        (SELECT COUNT(*) FROM projects)                         AS total_projects,
        (SELECT COALESCE(SUM(total_hours), 0) FROM hours WHERE notes IS DISTINCT FROM 'Deleted') AS total_hours,
        (SELECT COUNT(*) FROM committees WHERE status='Active') AS total_committees
    `;
    const topVolunteers = await sql`
      SELECT m.member_id, m.full_name, m.preferred_name, m.committee_id,
             COALESCE(m.preferred_name, m.full_name) AS name,
             COALESCE(SUM(h.total_hours), 0) AS hours
      FROM members m
      LEFT JOIN hours h ON h.member_id = m.member_id AND h.notes IS DISTINCT FROM 'Deleted'
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
      LEFT JOIN hours   h ON h.member_id    = m.member_id AND h.notes IS DISTINCT FROM 'Deleted'
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
  },

  'dashboard.projectDetail': async ({ project_id }) => {
    const [project] = await sql`SELECT * FROM projects WHERE project_id = ${project_id}`;
    if (!project) throw httpErr('Project not found', 404);
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
  },

  // ─── SETUP ───────────────────────────────────────────────────────────
  'setup.seedMembers': async () => ({ ok: true, note: 'Use `npm run seed` instead.' }),

  // One-shot seeder. Refuses if users already exist (so it can't be re-run by
  // accident or abused). Called by db/seed.js with the CSV text in the body.
  'setup.bulkSeed': async ({ csv_text }) => {
    if (!csv_text || typeof csv_text !== 'string') {
      throw httpErr('Missing csv_text', 400);
    }
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users`;
    if (count > 0) {
      throw httpErr('Already seeded — refusing to re-run. Wipe `users` first if you really mean to re-seed.', 409);
    }

    const committeeNames = {
      COM_001: 'لجنة العلاقات العامة',
      COM_002: 'لجنة الفعاليات',
      COM_003: 'لجنة الإعلام والتسويق',
      COM_004: 'لجنة العائلات',
      COM_005: 'أكاديمية الأصالة',
      COM_006: 'لجنة الرياضة',
      COM_007: 'لجنة الأكاديمية والمهنية',
      COM_008: 'لجنة الموارد المالية',
    };
    for (const [id, name] of Object.entries(committeeNames)) {
      await sql`
        INSERT INTO committees (committee_id, committee_name, status)
        VALUES (${id}, ${name}, 'Active')
        ON CONFLICT (committee_id) DO NOTHING
      `;
    }

    const lines = csv_text.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift());
    const rows = lines.map((l) =>
      Object.fromEntries(parseCsvLine(l).map((v, i) => [headers[i], v])));

    let inserted = 0;
    for (const r of rows) {
      await sql`
        INSERT INTO members (member_id, full_name, preferred_name, email, phone, gender,
                             profile_photo_url, committee_id, club_role, status, join_date, total_hours)
        VALUES (${r.member_id}, ${r.full_name}, ${r.preferred_name || null},
                ${r.email || null}, ${r.phone || null}, ${r.gender || null},
                ${r.profile_photo_url || null}, ${r.committee_id || null},
                ${r.club_role || 'Member'}, ${r.status || 'Active'},
                ${r.join_date || null}, ${parseFloat(r.total_hours) || 0})
        ON CONFLICT (member_id) DO NOTHING
      `;
      inserted++;
    }

    await sql`
      UPDATE committees c SET committee_head_member_id = m.member_id
      FROM members m
      WHERE m.committee_id = c.committee_id AND m.club_role = 'Committee Head'
        AND c.committee_head_member_id IS NULL
    `;
    await sql`
      UPDATE committees c SET committee_vice_head_member_id = m.member_id
      FROM members m
      WHERE m.committee_id = c.committee_id AND m.club_role = 'Committee Vice Head'
        AND c.committee_vice_head_member_id IS NULL
    `;

    const leadership = await sql`
      SELECT member_id, full_name, email, club_role, committee_id
      FROM members
      WHERE club_role IN ('President','Vice President','Deputy Vice President',
                          'Committee Head','Committee Vice Head')
      ORDER BY club_role, full_name
    `;

    const accounts = [];
    for (const m of leadership) {
      const username = (m.email && m.email.includes('@'))
        ? m.email.split('@')[0].toLowerCase()
        : m.member_id.toLowerCase();
      const access = (m.club_role === 'President'
                   || m.club_role === 'Vice President'
                   || m.club_role === 'Deputy Vice President')
        ? 'superadmin' : 'head';
      const tempPw = randomBytesB64Url(6);
      const hash = await bcrypt.hash(tempPw, 10);
      await sql`
        INSERT INTO users (username, password_hash, member_id, access_level)
        VALUES (${username}, ${hash}, ${m.member_id}, ${access})
      `;
      accounts.push({ username, access, name: m.full_name, temp_password: tempPw });
    }

    return {
      committees: Object.keys(committeeNames).length,
      members_inserted: inserted,
      accounts,
    };
  },
};

// CSV + crypto helpers used only by setup.bulkSeed.
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function randomBytesB64Url(n) {
  const arr = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(arr);
  else { for (let i = 0; i < n; i++) arr[i] = Math.floor(Math.random() * 256); }
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function httpErr(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
