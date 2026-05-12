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

  // ─── USERS (admin account management) ────────────────────────────────
  // Superadmin-only CRUD over the `users` login table. Used by the
  // "حسابات المستخدمين" admin tab to pre-create accounts for members
  // who don't have one yet (e.g. heads + presidency for the beta), and
  // to maintain non-member admin accounts (devs, maintainers) that have
  // member_id = NULL.
  //
  // Linking semantics: an admin picks an EXISTING `members` row from
  // the dropdown — we never auto-create members from this flow, and we
  // refuse to attach a second user to a member that already has one
  // (one human, one login).

  'users.list': async (_body, user) => {
    requireAuth(user);
    // Heads see EVERY member in their committee + their account info if any.
    // The page acts as a roster: members without an account are shown with a
    // "no account yet" state so the head knows who to ask the admin to onboard.
    // (Admin-only accounts with member_id IS NULL stay invisible to heads —
    // those are the dev/maintainer rows the head has no business touching.)
    if (user.access === 'head') {
      return sql`
        SELECT u.id, u.username, u.access_level, u.created_at, u.last_login_at,
               m.member_id,
               m.full_name      AS member_full_name,
               m.preferred_name AS member_preferred_name,
               m.committee_id   AS member_committee_id,
               m.club_role      AS member_club_role,
               c.committee_name AS member_committee_name
        FROM members m
        LEFT JOIN users      u ON u.member_id      = m.member_id
        LEFT JOIN committees c ON c.committee_id   = m.committee_id
        WHERE m.committee_id = ${user.committee_id}
        ORDER BY
          CASE WHEN u.id IS NULL THEN 1 ELSE 0 END,  -- members with accounts first
          CASE m.club_role
            WHEN 'Committee Head'      THEN 1
            WHEN 'Committee Vice Head' THEN 2
            ELSE 9
          END,
          m.full_name
      `;
    }
    if (user.access !== 'superadmin') throw httpErr('Forbidden', 403);
    return sql`
      SELECT u.id, u.username, u.access_level, u.created_at, u.last_login_at,
             u.member_id,
             m.full_name      AS member_full_name,
             m.preferred_name AS member_preferred_name,
             m.committee_id   AS member_committee_id,
             m.club_role      AS member_club_role,
             c.committee_name AS member_committee_name
      FROM users u
      LEFT JOIN members    m ON m.member_id    = u.member_id
      LEFT JOIN committees c ON c.committee_id = m.committee_id
      ORDER BY
        CASE u.access_level
          WHEN 'superadmin' THEN 1
          WHEN 'head'       THEN 2
          WHEN 'member'     THEN 3
          WHEN 'volunteer'  THEN 4
        END,
        u.username
    `;
  },

  'users.create': async (body, user) => {
    requireSuperadmin(user);
    const data = body.data || body;
    const username = String(data.username || '').trim().toLowerCase();
    const password = String(data.password || '');
    const memberId = data.member_id || null;
    const access   = data.access_level || 'member';

    if (!username) throw httpErr('username is required', 400);
    if (!password || password.length < 6) throw httpErr('password must be at least 6 characters', 400);
    if (!['superadmin','head','member','volunteer'].includes(access)) {
      throw httpErr(`invalid access_level: ${access}`, 400);
    }

    // Uniqueness check (case-insensitive).
    const [existsByUser] = await sql`SELECT id FROM users WHERE LOWER(username) = ${username}`;
    if (existsByUser) throw httpErr(`Username "${username}" is already taken`, 409);

    if (memberId) {
      // The linked member must exist and must not already have a user account.
      const [member] = await sql`SELECT member_id, full_name FROM members WHERE member_id = ${memberId}`;
      if (!member) throw httpErr(`Member ${memberId} not found`, 404);
      const [existingForMember] = await sql`SELECT id, username FROM users WHERE member_id = ${memberId}`;
      if (existingForMember) {
        throw httpErr(`Member ${memberId} (${member.full_name}) already has an account: "${existingForMember.username}"`, 409);
      }
    }

    const hash = await bcrypt.hash(password, 10);
    const [r] = await sql`
      INSERT INTO users (username, password_hash, member_id, access_level)
      VALUES (${username}, ${hash}, ${memberId}, ${access})
      RETURNING id, username, access_level, member_id
    `;
    return { id: r.id, username: r.username, access_level: r.access_level, member_id: r.member_id };
  },

  'users.update': async (body, user) => {
    requireSuperadmin(user);
    const data = body.data || body;
    const id = data.id;
    if (!id) throw httpErr('id is required', 400);

    const [target] = await sql`SELECT * FROM users WHERE id = ${id}`;
    if (!target) throw httpErr('User not found', 404);

    // Safety: don't let the only superadmin demote themselves into being
    // demoted out of superadmin — keeps at least one root user alive.
    if (target.access_level === 'superadmin' && data.access_level && data.access_level !== 'superadmin') {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE access_level = 'superadmin'`;
      if (count <= 1) throw httpErr('Cannot demote the only remaining superadmin', 409);
    }

    if (data.username) {
      const newU = String(data.username).trim().toLowerCase();
      if (newU !== target.username.toLowerCase()) {
        const [clash] = await sql`SELECT id FROM users WHERE LOWER(username) = ${newU} AND id <> ${id}`;
        if (clash) throw httpErr(`Username "${newU}" is already taken`, 409);
      }
    }
    if (data.member_id && data.member_id !== target.member_id) {
      const [clash] = await sql`SELECT id, username FROM users WHERE member_id = ${data.member_id} AND id <> ${id}`;
      if (clash) throw httpErr(`That member already has an account: "${clash.username}"`, 409);
      const [member] = await sql`SELECT member_id FROM members WHERE member_id = ${data.member_id}`;
      if (!member) throw httpErr(`Member ${data.member_id} not found`, 404);
    }
    if (data.access_level && !['superadmin','head','member','volunteer'].includes(data.access_level)) {
      throw httpErr(`invalid access_level: ${data.access_level}`, 400);
    }

    await sql`
      UPDATE users SET
        username     = COALESCE(${data.username ? String(data.username).trim().toLowerCase() : null}, username),
        member_id    = COALESCE(${data.member_id}, member_id),
        access_level = COALESCE(${data.access_level}, access_level)
      WHERE id = ${id}
    `;
    return { id };
  },

  'users.delete': async ({ id }, user) => {
    requireSuperadmin(user);
    const [target] = await sql`SELECT id, username, access_level FROM users WHERE id = ${id}`;
    if (!target) return { id };
    // Same safety as update: at least one superadmin must survive.
    if (target.access_level === 'superadmin') {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users WHERE access_level = 'superadmin'`;
      if (count <= 1) throw httpErr('Cannot delete the only remaining superadmin', 409);
    }
    if (target.id === user.id) throw httpErr('You cannot delete your own account', 409);
    await sql`DELETE FROM users WHERE id = ${id}`;
    return { id };
  },

  'users.resetPassword': async ({ id }, user) => {
    requireAuth(user);
    // Look up the target with its member's committee — needed for head-scope.
    const [target] = await sql`
      SELECT u.id, u.username, u.access_level, u.member_id,
             m.committee_id AS member_committee_id
      FROM users u
      LEFT JOIN members m ON m.member_id = u.member_id
      WHERE u.id = ${id}
    `;
    if (!target) throw httpErr('User not found', 404);

    // Permission gates:
    //   - superadmin: can reset anyone (including other superadmins)
    //   - head: can reset a non-admin user IF the linked member is in their
    //     committee. Cannot reset other heads, superadmins, or admin-only
    //     accounts (those have member_id = NULL).
    //   - everyone else: forbidden
    if (user.access === 'head') {
      if (!target.member_id) throw httpErr('Forbidden', 403);
      if (target.access_level === 'superadmin' || target.access_level === 'head') {
        throw httpErr('Committee heads cannot reset admin or head passwords', 403);
      }
      if (target.member_committee_id !== user.committee_id) {
        throw httpErr('Forbidden — that member is not in your committee', 403);
      }
    } else if (user.access !== 'superadmin') {
      throw httpErr('Forbidden', 403);
    }

    // 9-char URL-safe random — shown once to the caller, never stored in plain.
    const tempPw = randomBytesB64Url(7);
    const hash = await bcrypt.hash(tempPw, 10);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id}`;
    return { id, username: target.username, temp_password: tempPw };
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
      INSERT INTO members (member_id, full_name, preferred_name, national_id,
                           email, phone, whatsapp, gender, date_of_birth,
                           profile_photo_url, committee_id, club_role, status, join_date, total_hours)
      VALUES (${id}, ${data.full_name}, ${data.preferred_name || null}, ${data.national_id || null},
              ${data.email || null},
              ${data.phone || null}, ${data.whatsapp || null}, ${data.gender || null},
              ${data.date_of_birth || null},
              ${data.profile_photo_url || null},
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
        national_id       = COALESCE(${data.national_id},       national_id),
        email             = COALESCE(${data.email},             email),
        phone             = COALESCE(${data.phone},             phone),
        whatsapp          = COALESCE(${data.whatsapp},          whatsapp),
        gender            = COALESCE(${data.gender},            gender),
        date_of_birth     = COALESCE(${data.date_of_birth},     date_of_birth),
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

    // Principle 2 — when an assignment is provided we refuse to log hours
    // unless attendance was confirmed. Direct (no-assignment) hour entries
    // remain allowed for legacy/admin-correction cases.
    if (data.assignment_id) {
      const [a] = await sql`
        SELECT a.attendance_status, a.member_id AS a_member_id, a.volunteer_email AS a_volunteer_email,
               o.project_id AS o_project_id
        FROM assignments a
        JOIN opportunities o ON o.opportunity_id = a.opportunity_id
        WHERE a.assignment_id = ${data.assignment_id}
      `;
      if (!a) throw httpErr('Assignment not found', 404);
      if (a.attendance_status !== 'Attended') {
        throw httpErr('Hours can only be recorded for assignments marked Attended (Principle 2).', 422);
      }
      // Backfill project_id / member from the assignment if the caller didn't supply them.
      if (!data.project_id)      data.project_id      = a.o_project_id;
      if (!data.member_id)       data.member_id       = a.a_member_id;
      if (!data.volunteer_email) data.volunteer_email = a.a_volunteer_email;
    }

    const [r] = await sql`
      INSERT INTO hours (project_id, assignment_id, member_id, volunteer_email, participant_type,
                         hours_before, hours_during, hours_after,
                         notes, recorded_by, recorded_by_member_id, approval_status)
      VALUES (${data.project_id}, ${data.assignment_id || null},
              ${data.member_id || null}, ${data.volunteer_email || null},
              ${data.participant_type || null},
              ${before}, ${during}, ${after},
              ${data.notes || null}, ${user.id}, ${data.recorded_by_member_id || null},
              'Draft')
      RETURNING id, total_hours
    `;
    await recomputeMemberTotalHours(data.member_id);
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
    await recomputeMemberTotalHours(row?.member_id);
    return { id };
  },

  // ─── HOURS APPROVAL (§7) ─────────────────────────────────────────────
  // Two-stage approval: committee head primary-approves Draft rows for
  // opportunities owned by their committee; presidency final-approves
  // PrimaryApproved rows. `members.total_hours` rollups count only
  // FinalApproved rows.
  'hours.primaryApprove': async ({ id }, user) => {
    const [row] = await sql`
      SELECT h.id, h.member_id, h.approval_status, o.owning_committee_id
      FROM hours h
      LEFT JOIN assignments  a ON a.assignment_id = h.assignment_id
      LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
      WHERE h.id = ${id}
    `;
    if (!row) throw httpErr('Hours row not found', 404);
    if (row.approval_status !== 'Draft') {
      throw httpErr(`Cannot primary-approve a row in status ${row.approval_status}`, 409);
    }
    requireAdminScope(user, row.owning_committee_id);
    await sql`
      UPDATE hours SET
        approval_status     = 'PrimaryApproved',
        primary_approver_id = ${user.id},
        primary_approved_at = NOW()
      WHERE id = ${id}
    `;
    await recomputeMemberTotalHours(row.member_id);
    return { id };
  },

  'hours.finalApprove': async ({ id }, user) => {
    requireSuperadmin(user);
    const [row] = await sql`SELECT id, member_id, approval_status FROM hours WHERE id = ${id}`;
    if (!row) throw httpErr('Hours row not found', 404);
    if (row.approval_status !== 'PrimaryApproved') {
      throw httpErr(`Final approval requires PrimaryApproved (currently ${row.approval_status})`, 409);
    }
    await sql`
      UPDATE hours SET
        approval_status   = 'FinalApproved',
        final_approver_id = ${user.id},
        final_approved_at = NOW()
      WHERE id = ${id}
    `;
    await recomputeMemberTotalHours(row.member_id);
    return { id };
  },

  'hours.reject': async ({ id, reason }, user) => {
    const [row] = await sql`
      SELECT h.id, h.member_id, h.approval_status, o.owning_committee_id
      FROM hours h
      LEFT JOIN assignments  a ON a.assignment_id = h.assignment_id
      LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
      WHERE h.id = ${id}
    `;
    if (!row) throw httpErr('Hours row not found', 404);
    // Anyone in the approval chain can reject:
    //   - committee head can reject Draft rows in their committee
    //   - presidency can reject anything pre-FinalApproved
    //   - presidency can also reject FinalApproved (rolls it back)
    if (user.access === 'head') {
      if (row.approval_status !== 'Draft') {
        throw httpErr('Committee heads can only reject Draft rows', 403);
      }
      requireAdminScope(user, row.owning_committee_id);
    } else if (user.access !== 'superadmin') {
      throw httpErr('Forbidden', 403);
    }
    await sql`
      UPDATE hours SET
        approval_status = 'Rejected',
        rejected_reason = ${reason || null}
      WHERE id = ${id}
    `;
    await recomputeMemberTotalHours(row.member_id);
    return { id };
  },

  getMemberHours: async ({ member_id, project_id, approval_status }) => sql`
    SELECT h.id AS hours_id, h.*,
           p.project_name, p.event_date,
           m.full_name           AS member_full_name,
           m.preferred_name      AS member_preferred_name,
           o.role_name           AS opportunity_role_name,
           o.owning_committee_id AS opportunity_committee_id,
           pa.full_name          AS primary_approver_name,
           fa.full_name          AS final_approver_name
    FROM hours h
    LEFT JOIN projects     p  ON p.project_id     = h.project_id
    LEFT JOIN members      m  ON m.member_id      = h.member_id
    LEFT JOIN assignments  a  ON a.assignment_id  = h.assignment_id
    LEFT JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN users        upa ON upa.id          = h.primary_approver_id
    LEFT JOIN members      pa ON pa.member_id     = upa.member_id
    LEFT JOIN users        ufa ON ufa.id          = h.final_approver_id
    LEFT JOIN members      fa ON fa.member_id     = ufa.member_id
    WHERE (h.notes IS DISTINCT FROM 'Deleted')
      ${member_id       ? sql`AND h.member_id       = ${member_id}`       : sql``}
      ${project_id      ? sql`AND h.project_id      = ${project_id}`      : sql``}
      ${approval_status ? sql`AND h.approval_status = ${approval_status}` : sql``}
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
        (SELECT COALESCE(SUM(total_hours), 0) FROM hours WHERE approval_status = 'FinalApproved') AS total_hours,
        (SELECT COUNT(*) FROM committees WHERE status='Active') AS total_committees
    `;
    const topVolunteers = await sql`
      SELECT m.member_id, m.full_name, m.preferred_name, m.committee_id,
             COALESCE(m.preferred_name, m.full_name) AS name,
             COALESCE(SUM(h.total_hours), 0) AS hours
      FROM members m
      LEFT JOIN hours h ON h.member_id = m.member_id AND h.approval_status = 'FinalApproved'
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
      LEFT JOIN hours   h ON h.member_id    = m.member_id AND h.approval_status = 'FinalApproved'
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

  // ─── OPPORTUNITIES (§4, §12) ─────────────────────────────────────────
  'opportunities.list': async ({ project_id, committee_id, status }) => sql`
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
  `,

  'opportunities.create': async (body, user) => {
    const data = body.data || body;
    if (!data.project_id || !data.role_name) {
      throw httpErr('project_id and role_name are required', 400);
    }
    requireAdminScope(user, data.owning_committee_id);
    const id = data.opportunity_id || shortId('OPP');
    await sql`
      INSERT INTO opportunities (opportunity_id, project_id, role_name, role_key,
                                 estimated_hours, headcount_needed, owning_committee_id,
                                 status, notes, created_by)
      VALUES (${id}, ${data.project_id}, ${data.role_name}, ${data.role_key || null},
              ${data.estimated_hours || 0}, ${data.headcount_needed || 1},
              ${data.owning_committee_id || null}, ${data.status || 'Open'},
              ${data.notes || null}, ${user.id})
    `;
    return { opportunity_id: id };
  },

  'opportunities.update': async ({ id, data }, user) => {
    const [existing] = await sql`SELECT owning_committee_id FROM opportunities WHERE opportunity_id = ${id}`;
    if (!existing) throw httpErr('Opportunity not found', 404);
    requireAdminScope(user, existing.owning_committee_id);
    if (data.owning_committee_id) requireAdminScope(user, data.owning_committee_id);
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
  },

  'opportunities.delete': async ({ id }, user) => {
    const [existing] = await sql`SELECT owning_committee_id FROM opportunities WHERE opportunity_id = ${id}`;
    if (!existing) return { opportunity_id: id };
    requireAdminScope(user, existing.owning_committee_id);
    await sql`DELETE FROM opportunities WHERE opportunity_id = ${id}`;
    return { opportunity_id: id };
  },

  // ─── ASSIGNMENTS ─────────────────────────────────────────────────────
  'assignments.list': async ({ opportunity_id, project_id, member_id }) => sql`
    SELECT a.*,
      o.role_name, o.role_key, o.estimated_hours, o.project_id, o.owning_committee_id,
      p.project_name, p.project_type, p.event_date,
      m.full_name AS member_full_name, m.preferred_name AS member_preferred_name,
      m.email AS member_email
    FROM assignments a
    JOIN opportunities o ON o.opportunity_id = a.opportunity_id
    LEFT JOIN projects p ON p.project_id     = o.project_id
    LEFT JOIN members  m ON m.member_id      = a.member_id
    WHERE 1=1
      ${opportunity_id ? sql`AND a.opportunity_id = ${opportunity_id}` : sql``}
      ${project_id     ? sql`AND o.project_id     = ${project_id}`     : sql``}
      ${member_id      ? sql`AND a.member_id      = ${member_id}`      : sql``}
    ORDER BY a.created_at DESC
  `,

  'assignments.add': async (body, user) => {
    const data = body.data || body;
    requireAuth(user);
    if (!data.opportunity_id) throw httpErr('opportunity_id is required', 400);
    if (!data.member_id && !data.volunteer_name) {
      throw httpErr('member_id or volunteer_name is required', 400);
    }
    const [r] = await sql`
      INSERT INTO assignments (opportunity_id, member_id, volunteer_name, volunteer_email,
                               assigned_by, attendance_status)
      VALUES (${data.opportunity_id}, ${data.member_id || null},
              ${data.volunteer_name || null}, ${data.volunteer_email || null},
              ${user.id}, 'Pending')
      RETURNING assignment_id
    `;
    return { id: r.assignment_id, assignment_id: r.assignment_id };
  },

  'assignments.remove': async ({ id }, user) => {
    requireAuth(user);
    await sql`DELETE FROM assignments WHERE assignment_id = ${id}`;
    return { id };
  },

  'assignments.markAttendance': async (body, user) => {
    const data = body.data || body;
    requireAuth(user);
    if (!data.assignment_id || !data.attendance_status) {
      throw httpErr('assignment_id and attendance_status are required', 400);
    }
    await sql`
      UPDATE assignments SET
        attendance_status    = ${data.attendance_status},
        attendance_notes     = ${data.attendance_notes || null},
        attendance_marked_by = ${user.id},
        attendance_marked_at = NOW()
      WHERE assignment_id = ${data.assignment_id}
    `;
    return { id: data.assignment_id };
  },

  // ─── MEMBERSHIP APPLICATIONS (§6) ────────────────────────────────────
  // Public submission. Anyone on the website can hit this without auth.
  // Accepts the expanded apply-form-v2 payload — see migration 0005 for the
  // column list and apply.html for the canonical value sets.
  'applications.submit': async (body) => {
    const data = body.data || body;

    // Display name: prefer the new structured name_ar; fall back to full_name
    // for any old/legacy callers still posting the original v1 schema.
    const displayName = data.name_ar || data.full_name;
    if (!displayName) throw httpErr('name_ar (or full_name) is required', 400);
    if (!data.email && !data.phone) {
      throw httpErr('email or phone is required', 400);
    }
    if (data.confirmation_accepted !== true) {
      throw httpErr('confirmation_accepted must be true', 400);
    }

    const id = data.application_id || shortId('APP');
    const interests = Array.isArray(data.interests)
      ? data.interests
      : (typeof data.interests === 'string' && data.interests
          ? data.interests.split(',').map(s => s.trim()).filter(Boolean)
          : []);

    await sql`
      INSERT INTO membership_applications (
        application_id, full_name, preferred_name, email, phone,
        university, major, gender, interests, pitch,
        national_id, name_ar, name_en, date_of_birth,
        address_melbourne, phone_country_code,
        whatsapp, whatsapp_country_code,
        scholarship_entity, scholarship_entity_other,
        study_level, degree_field, university_other,
        study_started_window, expected_graduation_window,
        cv_url, skills_hobbies, about_self,
        referral_source, referral_source_other, suggestions,
        confirmation_accepted, status
      ) VALUES (
        ${id}, ${displayName}, ${data.preferred_name || null},
        ${data.email || null}, ${data.phone || null},
        ${data.university || null}, ${data.degree_field || data.major || null},
        ${data.gender || null}, ${interests}, ${data.about_self || data.pitch || null},
        ${data.national_id || null}, ${data.name_ar || null}, ${data.name_en || null},
        ${data.date_of_birth || null},
        ${data.address_melbourne || null}, ${data.phone_country_code || null},
        ${data.whatsapp || null}, ${data.whatsapp_country_code || null},
        ${data.scholarship_entity || null}, ${data.scholarship_entity_other || null},
        ${data.study_level || null}, ${data.degree_field || null}, ${data.university_other || null},
        ${data.study_started_window || null}, ${data.expected_graduation_window || null},
        ${data.cv_url || null}, ${data.skills_hobbies || null}, ${data.about_self || null},
        ${data.referral_source || null}, ${data.referral_source_other || null},
        ${data.suggestions || null},
        ${data.confirmation_accepted === true},
        'PendingTriage'
      )
    `;
    return { application_id: id };
  },

  'applications.list': async ({ status, assigned_committee_id }, user) => {
    requireAuth(user);
    // Heads only see their committee's queue (plus untriaged ones, so they
    // can flag items presidency should triage). Presidency sees everything.
    if (user.access === 'head') {
      return sql`
        SELECT a.*, c.committee_name AS assigned_committee_name
        FROM membership_applications a
        LEFT JOIN committees c ON c.committee_id = a.assigned_committee_id
        WHERE 1=1
          AND (a.assigned_committee_id IS NULL OR a.assigned_committee_id = ${user.committee_id})
          ${status ? sql`AND a.status = ${status}` : sql``}
        ORDER BY a.created_at DESC
      `;
    }
    return sql`
      SELECT a.*, c.committee_name AS assigned_committee_name
      FROM membership_applications a
      LEFT JOIN committees c ON c.committee_id = a.assigned_committee_id
      WHERE 1=1
        ${status                ? sql`AND a.status                = ${status}`                : sql``}
        ${assigned_committee_id ? sql`AND a.assigned_committee_id = ${assigned_committee_id}` : sql``}
      ORDER BY a.created_at DESC
    `;
  },

  // Presidency triages a PendingTriage application to a committee.
  'applications.assignCommittee': async ({ id, committee_id }, user) => {
    requireSuperadmin(user);
    if (!committee_id) throw httpErr('committee_id is required', 400);
    const [row] = await sql`SELECT status FROM membership_applications WHERE application_id = ${id}`;
    if (!row) throw httpErr('Application not found', 404);
    if (row.status !== 'PendingTriage') {
      throw httpErr(`Cannot triage an application in status ${row.status}`, 409);
    }
    await sql`
      UPDATE membership_applications SET
        status                = 'AssignedToCommittee',
        assigned_committee_id = ${committee_id}
      WHERE application_id = ${id}
    `;
    return { application_id: id };
  },

  // Committee head flags that they want to interview before deciding.
  'applications.requestInterview': async ({ id, note }, user) => {
    const [row] = await sql`SELECT status, assigned_committee_id FROM membership_applications WHERE application_id = ${id}`;
    if (!row) throw httpErr('Application not found', 404);
    requireAdminScope(user, row.assigned_committee_id);
    if (row.status !== 'AssignedToCommittee' && row.status !== 'InterviewRequested') {
      throw httpErr(`Cannot request interview for status ${row.status}`, 409);
    }
    await sql`
      UPDATE membership_applications SET
        status          = 'InterviewRequested',
        decision_reason = COALESCE(${note}, decision_reason)
      WHERE application_id = ${id}
    `;
    return { application_id: id };
  },

  // Accept: creates a members row tied to the assigned committee. Per the
  // current decision, no users (login) row is created — login provisioning
  // is part of the upcoming member-portal restructure.
  'applications.accept': async ({ id, note }, user) => {
    const [app] = await sql`
      SELECT * FROM membership_applications WHERE application_id = ${id}
    `;
    if (!app) throw httpErr('Application not found', 404);
    requireAdminScope(user, app.assigned_committee_id);
    if (app.status !== 'AssignedToCommittee' && app.status !== 'InterviewRequested') {
      throw httpErr(`Cannot accept an application in status ${app.status}`, 409);
    }
    if (!app.assigned_committee_id) {
      throw httpErr('Application must be assigned to a committee before acceptance', 400);
    }
    const memberId = shortId('MBR');
    // Display name preference: structured Arabic name first, then full_name
    // (covers both v2 and any legacy v1 applications still in the queue).
    const displayName = app.name_ar || app.full_name;
    // Combine WhatsApp country code + number into the E.164 string that
    // `members.whatsapp` stores (the apply form keeps them split for UX).
    const whatsappE164 = app.whatsapp
      ? (app.whatsapp_country_code && !app.whatsapp.startsWith('+')
          ? `${app.whatsapp_country_code}${app.whatsapp}`
          : app.whatsapp)
      : null;
    await sql`
      INSERT INTO members
        (member_id, full_name, preferred_name, email, phone, whatsapp,
         gender, date_of_birth,
         committee_id, club_role, status, join_date, national_id)
      VALUES
        (${memberId}, ${displayName}, ${app.preferred_name || null},
         ${app.email || null}, ${app.phone || null}, ${whatsappE164},
         ${app.gender || null}, ${app.date_of_birth || null},
         ${app.assigned_committee_id}, 'Member', 'Active', CURRENT_DATE,
         ${app.national_id || null})
    `;
    await sql`
      UPDATE membership_applications SET
        status             = 'Accepted',
        decided_by_user_id = ${user.id},
        decided_at         = NOW(),
        decision_reason    = COALESCE(${note}, decision_reason),
        created_member_id  = ${memberId}
      WHERE application_id = ${id}
    `;
    return { application_id: id, member_id: memberId };
  },

  'applications.reject': async ({ id, reason }, user) => {
    const [app] = await sql`SELECT status, assigned_committee_id FROM membership_applications WHERE application_id = ${id}`;
    if (!app) throw httpErr('Application not found', 404);
    // Heads can reject only within their committee's scope, but only after
    // triage. Presidency can reject anything (including PendingTriage) for
    // obvious-spam cases.
    if (user.access === 'head') {
      if (!app.assigned_committee_id) throw httpErr('This application has not been triaged yet', 409);
      requireAdminScope(user, app.assigned_committee_id);
    } else if (user.access !== 'superadmin') {
      throw httpErr('Forbidden', 403);
    }
    if (app.status === 'Accepted' || app.status === 'Rejected') {
      throw httpErr(`Application already ${app.status}`, 409);
    }
    await sql`
      UPDATE membership_applications SET
        status             = 'Rejected',
        decided_by_user_id = ${user.id},
        decided_at         = NOW(),
        decision_reason    = ${reason || null}
      WHERE application_id = ${id}
    `;
    return { application_id: id };
  },

  'assignments.bulkMarkAttendance': async ({ records }, user) => {
    requireAuth(user);
    if (!Array.isArray(records)) throw httpErr('records[] required', 400);
    let count = 0;
    for (const r of records) {
      if (!r.assignment_id || !r.attendance_status) continue;
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
  },

  // ─── SETUP ───────────────────────────────────────────────────────────
  'setup.seedMembers': async () => ({ ok: true, note: 'Use `npm run seed` instead.' }),

  // Phased seeder. The setup workload (wipe + 98 member inserts + 20 bcrypts +
  // FK wiring) busts Netlify Free-tier's 10s sync-function ceiling when run
  // monolithically, so it's split into four phases the client orchestrates in
  // sequence. Each phase finishes well inside the timeout.
  //
  // Phases (pass via `phase` field in the request body):
  //   'wipe'       (force=true) — drops all app-level data so a clean reseed
  //                               can run. Idempotent. Returns {ok:true}.
  //   'committees' — inserts committee rows and returns the {name → id} map
  //                  the next phase needs. Refuses if users already exist
  //                  (unless force was used in 'wipe' just above).
  //   'members'    — inserts ONE BATCH of normalised member rows. Caller
  //                  passes the {name → id} map from 'committees' so each
  //                  row's committee_id resolves correctly. Returns {inserted}.
  //                  Call repeatedly with successive batches until done.
  //   'finalize'   — wires committee head/vice-head FKs, creates user accounts
  //                  for every leadership row (NID/email-local username, cost-6
  //                  bcrypt temp password), and optionally creates a dev/
  //                  maintainer superadmin from `dev_admin`. Refuses to commit
  //                  if zero superadmins would exist (lockout safety).
  //
  // Client orchestration lives in db/seed.js — typical call sequence:
  //   wipe → committees → members×N → finalize
  'setup.bulkSeed': async (body) => {
    const data = body.data || body;
    const phase = data.phase;
    if (!phase) throw httpErr('phase is required: "wipe" | "committees" | "members" | "finalize"', 400);

    // ─── PHASE 1: wipe ───────────────────────────────────────────────
    // force:true → wipe everything app-level so the seed runs from a clean
    // slate. DELETE in FK-safe order rather than TRUNCATE so this function's
    // connection doesn't fight a TRUNCATE's exclusive table lock against
    // other open sessions. Idempotent — safe to call on an empty db.
    if (phase === 'wipe') {
      if (!data.force) {
        const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users`;
        if (count > 0) {
          throw httpErr(`Already seeded (${count} users exist). Pass force:true to wipe + re-seed.`, 409);
        }
        return { ok: true, wiped: false, note: 'db was already empty' };
      }
      await sql`DELETE FROM users`;
      await sql`DELETE FROM hours`;
      await sql`DELETE FROM attendance`;
      await sql`DELETE FROM assignments`;
      await sql`DELETE FROM opportunities`;
      await sql`DELETE FROM thanks_emails`;
      await sql`DELETE FROM certificates`;
      await sql`DELETE FROM interest_requests`;
      await sql`DELETE FROM participants`;
      await sql`DELETE FROM membership_applications`;
      await sql`UPDATE committees SET committee_head_member_id = NULL, committee_vice_head_member_id = NULL`;
      await sql`UPDATE projects SET created_by_member_id = NULL, assigned_project_manager_member_id = NULL, assigned_event_manager_member_id = NULL`;
      await sql`DELETE FROM members`;
      await sql`DELETE FROM committees`;
      await sql`DELETE FROM projects`;
      return { ok: true, wiped: true };
    }

    // ─── PHASE 2: committees ─────────────────────────────────────────
    // Inserts committee rows and returns the {name → committee_id} map the
    // 'members' phase needs to resolve each row's committee_id FK. IDs are
    // assigned COM_001, COM_002, ... in the order they appear in the payload
    // (which is xlsx order).
    if (phase === 'committees') {
      const committeeNames = Array.isArray(data.committees) ? data.committees : [];
      if (!committeeNames.length) throw httpErr('committees[] is required for phase=committees', 400);

      const [{ max_n }] = await sql`
        SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(committee_id, '\\D', '', 'g'), '')::INT), 0) AS max_n
        FROM committees
      `;
      let nextN = Math.max(1, (max_n || 0) + 1);
      const committeeIdByName = {};
      const createdCommittees = [];
      for (const name of committeeNames) {
        const id = `COM_${String(nextN).padStart(3, '0')}`;
        nextN++;
        await sql`
          INSERT INTO committees (committee_id, committee_name, status)
          VALUES (${id}, ${name}, 'Active')
          ON CONFLICT (committee_id) DO NOTHING
        `;
        committeeIdByName[name] = id;
        createdCommittees.push({ committee_id: id, committee_name: name });
      }
      return { ok: true, committee_id_by_name: committeeIdByName, created: createdCommittees };
    }

    // ─── PHASE 3: members (one batch per call) ───────────────────────
    // Inserts a batch of normalised member rows. Caller passes the
    // {name → committee_id} map from the 'committees' phase so each row's
    // committee FK resolves correctly. Returns {inserted, member_id_by_xlsx_row}
    // — the latter is what the 'finalize' phase needs to wire head/vice FKs.
    // Call repeatedly with successive batches; on Free tier ~25 rows/call
    // keeps us well inside the 10s ceiling.
    if (phase === 'members') {
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const committeeIdByName = data.committee_id_by_name || {};
      if (!rows.length) throw httpErr('rows[] is required for phase=members', 400);

      let inserted = 0;
      const memberIdByXlsxRow = {};
      for (const r of rows) {
        const committeeId = r.new_committee_name
          ? committeeIdByName[r.new_committee_name] || null
          : (r.committee_id || null);

        const memberId = shortId('MBR');
        const displayName = r.name_ar || r.full_name;
        await sql`
          INSERT INTO members (
            member_id, full_name, preferred_name, name_en, national_id,
            email, phone, whatsapp, gender, date_of_birth, address_melbourne,
            committee_id, club_role, status, join_date,
            scholarship_entity, scholarship_entity_other,
            study_level, degree_field, university, university_other,
            study_started_window, expected_graduation_window,
            skills_hobbies, about_self, cv_url, linkedin_url, total_hours
          ) VALUES (
            ${memberId}, ${displayName}, ${r.preferred_name || null}, ${r.name_en || null}, ${r.national_id || null},
            ${r.email || null}, ${r.phone || null}, ${r.whatsapp || null},
            ${r.gender || null}, ${r.date_of_birth || null}, ${r.address_melbourne || null},
            ${committeeId}, ${r.club_role || 'Member'}, 'Active', CURRENT_DATE,
            ${r.scholarship_entity || null},
            ${r.scholarship_entity_raw && !r.scholarship_entity ? r.scholarship_entity_raw : null},
            ${r.study_level || null}, ${r.degree_field || null}, ${r.university || null}, ${r.university_other || null},
            ${r.study_started_window || null}, ${r.expected_graduation_window || null},
            ${r.skills_hobbies || null}, ${r.about_self || null}, ${r.cv_url || null}, ${r.linkedin || null}, 0
          )
        `;
        memberIdByXlsxRow[r._xlsx_row] = memberId;
        inserted++;
      }
      return { ok: true, inserted, member_id_by_xlsx_row: memberIdByXlsxRow };
    }

    // ─── PHASE 4: finalize ───────────────────────────────────────────
    // Wires committee head/vice-head FKs, creates user accounts for every
    // leadership row, optionally creates a dev/maintainer superadmin. The
    // bcrypts (cost 6) for ~20 leadership accounts dominate this phase —
    // ~1.5s on Lambda — well inside the 10s budget.
    if (phase === 'finalize') {
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const committeeIdByName = data.committee_id_by_name || {};
      const memberIdByXlsxRow = data.member_id_by_xlsx_row || {};

      // ─── 4a. Committee head / vice-head FK wiring ─────────────────
      let headsAssigned = 0;
      for (const r of rows) {
        const committeeId = r.new_committee_name
          ? committeeIdByName[r.new_committee_name] || null
          : (r.committee_id || null);
        if (!committeeId) continue;
        const memberId = memberIdByXlsxRow[r._xlsx_row];
        if (!memberId) continue;
        if (r.club_role === 'Committee Head') {
          await sql`UPDATE committees SET committee_head_member_id = ${memberId} WHERE committee_id = ${committeeId}`;
          headsAssigned++;
        } else if (r.club_role === 'Committee Vice Head') {
          await sql`UPDATE committees SET committee_vice_head_member_id = ${memberId} WHERE committee_id = ${committeeId}`;
          headsAssigned++;
        }
      }

      // ─── 4b. Leadership user accounts ─────────────────────────────
      // Username derivation: email-local-part first, fall back to NID. If
      // neither is available or there's a collision, derive from member_id
      // (last resort — should never trigger with real xlsx data).
      const leadership = await sql`
        SELECT member_id, full_name, email, national_id, club_role
        FROM members
        WHERE club_role IN ('President','Vice President','Deputy Vice President',
                            'Committee Head','Committee Vice Head')
        ORDER BY
          CASE club_role
            WHEN 'President' THEN 1
            WHEN 'Vice President' THEN 2
            WHEN 'Deputy Vice President' THEN 3
            WHEN 'Committee Head' THEN 4
            WHEN 'Committee Vice Head' THEN 5
          END,
          full_name
      `;

      const usernamesSeen = new Set();
      const accounts = [];
      let superadminCount = 0;
      for (const m of leadership) {
        let candidate = (m.email && m.email.includes('@'))
          ? m.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '')
          : (m.national_id || `lead_${m.member_id.toLowerCase()}`);
        let username = candidate, n = 2;
        while (usernamesSeen.has(username)) { username = `${candidate}-${n++}`; }
        usernamesSeen.add(username);

        const access = (m.club_role === 'President'
                     || m.club_role === 'Vice President'
                     || m.club_role === 'Deputy Vice President')
          ? 'superadmin' : 'head';
        if (access === 'superadmin') superadminCount++;

        const tempPw = randomBytesB64Url(7);
        // Cost 6 for seed temp passwords — users change them on first login
        // anyway, and cost 10 × 20 hashes blew past the 10s function timeout.
        // users.create + users.resetPassword keep cost 10 for normal use.
        const hash = await bcrypt.hash(tempPw, 6);
        await sql`
          INSERT INTO users (username, password_hash, member_id, access_level)
          VALUES (${username}, ${hash}, ${m.member_id}, ${access})
        `;
        accounts.push({
          username, access, name: m.full_name, role: m.club_role, temp_password: tempPw,
        });
      }

      // ─── 4c. Dev/maintainer superadmin (optional) ─────────────────
      // Created with member_id = NULL — it's not a club member, just a
      // separate-tier account for tech support and dev work.
      if (data.dev_admin && data.dev_admin.username) {
        const devUsername = String(data.dev_admin.username).toLowerCase().trim();
        const [clash] = await sql`SELECT id FROM users WHERE LOWER(username) = ${devUsername}`;
        if (clash) throw httpErr(`dev_admin username "${devUsername}" collides with a leadership account — pick a different one`, 409);
        const devPassword = data.dev_admin.password || randomBytesB64Url(7);
        const devHash = await bcrypt.hash(devPassword, 6);
        await sql`
          INSERT INTO users (username, password_hash, member_id, access_level)
          VALUES (${devUsername}, ${devHash}, NULL, 'superadmin')
        `;
        accounts.push({
          username: devUsername, access: 'superadmin', name: '(dev/maintainer)',
          role: 'dev', temp_password: devPassword,
        });
        superadminCount++;
      }

      // ─── 4d. Lockout safety check ─────────────────────────────────
      // If this trips, something is wrong with the input (no presidency rows
      // AND no dev_admin). Refuse to commit so the operator notices.
      if (superadminCount === 0) {
        throw httpErr('No superadmin account would be created — the xlsx contains no President/VP/DVP rows and no dev_admin was provided. Aborting to prevent lockout.', 500);
      }

      return {
        ok: true,
        heads_assigned: headsAssigned,
        accounts,
      };
    }

    throw httpErr(`Unknown phase: ${phase}. Expected one of: wipe, committees, members, finalize`, 400);
  },
};

// Crypto helper — generates short URL-safe random strings (used for temp
// passwords during seed and password reset).
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

// Single source of truth for `members.total_hours`: sum of FinalApproved hours
// only. Everything that records/edits/approves hours must call this with the
// affected member_id (or no-op on null) so the cache stays consistent.
async function recomputeMemberTotalHours(member_id) {
  if (!member_id) return;
  await sql`
    UPDATE members SET total_hours = (
      SELECT COALESCE(SUM(total_hours), 0)
      FROM hours
      WHERE member_id = ${member_id}
        AND approval_status = 'FinalApproved'
    )
    WHERE member_id = ${member_id}
  `;
}
