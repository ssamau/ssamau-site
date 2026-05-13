// Seed / setup handlers.
//
// Port of the SETUP section from netlify/functions/api.js (lines 1322–1624).
// `setup.seedMembers` is a no-op redirect to the local `npm run seed`
// script. `setup.bulkSeed` is the four-phase seeder driven by db/seed.js —
// see the long doc-comment on the handler itself for the phase flow.
//
// This module is the largest in the port (~250 lines) because bulkSeed
// is the largest single handler in the project. The phase split exists
// to keep each call inside Netlify Free-tier's 10s sync-function ceiling;
// Supabase Edge Functions are more generous (~150s) so on Supabase a
// monolithic seeder would also fit, but we keep the phased shape so
// db/seed.js stays unchanged across the migration.

import { sql } from '../_sql.ts';
import {
  httpErr, shortId, randomBytesB64Url,
  bcryptHash,
  type Handler,
} from '../_helpers.ts';

// ─── SETUP ───────────────────────────────────────────────────────────
const setupSeedMembers: Handler = async () => ({ ok: true, note: 'Use `npm run seed` instead.' });

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
const setupBulkSeed: Handler = async (body) => {
  const data = (body.data ?? body) as Record<string, unknown>;
  const phase = data.phase as string | undefined;
  if (!phase) throw httpErr('phase is required: "wipe" | "committees" | "members" | "finalize"', 400);

  // ─── PHASE 1: wipe ───────────────────────────────────────────────
  // force:true → wipe everything app-level so the seed runs from a clean
  // slate. DELETE in FK-safe order rather than TRUNCATE so this function's
  // connection doesn't fight a TRUNCATE's exclusive table lock against
  // other open sessions. Idempotent — safe to call on an empty db.
  if (phase === 'wipe') {
    if (!data.force) {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users` as Array<{ count: number }>;
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
    const committeeNames = Array.isArray(data.committees) ? data.committees as string[] : [];
    if (!committeeNames.length) throw httpErr('committees[] is required for phase=committees', 400);

    const [{ max_n }] = await sql`
      SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(committee_id, '\\D', '', 'g'), '')::INT), 0) AS max_n
      FROM committees
    ` as Array<{ max_n: number }>;
    let nextN = Math.max(1, (max_n || 0) + 1);
    const committeeIdByName: Record<string, string> = {};
    const createdCommittees: Array<{ committee_id: string; committee_name: string }> = [];
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
    const rows = Array.isArray(data.rows) ? data.rows as Array<Record<string, unknown>> : [];
    const committeeIdByName = (data.committee_id_by_name || {}) as Record<string, string>;
    if (!rows.length) throw httpErr('rows[] is required for phase=members', 400);

    let inserted = 0;
    const memberIdByXlsxRow: Record<string, string> = {};
    for (const r of rows) {
      const committeeId = r.new_committee_name
        ? committeeIdByName[r.new_committee_name as string] || null
        : ((r.committee_id as string | null) || null);

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
      memberIdByXlsxRow[r._xlsx_row as string] = memberId;
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
    const rows = Array.isArray(data.rows) ? data.rows as Array<Record<string, unknown>> : [];
    const committeeIdByName = (data.committee_id_by_name || {}) as Record<string, string>;
    const memberIdByXlsxRow = (data.member_id_by_xlsx_row || {}) as Record<string, string>;

    // ─── 4a. Committee head / vice-head FK wiring ─────────────────
    // xlsx rule: a club President/VP/DVP who is ALSO assigned to a
    // committee is that committee's head/vice. So someone whose
    // club_role is "Deputy Vice President" and whose committee_id is
    // Communications is Communications' vice-head, not just a board
    // member. Without this, the bulkSeed left the vice slot null for
    // four committees and the public homepage ended up showing 8 board
    // members instead of 3.
    //
    // Precedence on conflicts: a literal "Committee Head" / "Committee
    // Vice Head" role wins over a club VP/DVP coincidence — both should
    // resolve to the same person anyway, but if the xlsx disagrees with
    // itself the explicit committee role is the source of truth.
    const HEAD_ROLES = new Set(['Committee Head', 'President']);
    const VICE_ROLES = new Set(['Committee Vice Head', 'Vice President', 'Deputy Vice President']);

    let headsAssigned = 0;
    const headAssigned = new Set<string>();   // committee_ids that already got a head this batch
    const viceAssigned = new Set<string>();   // ditto for vice

    // First pass: explicit Committee Head / Committee Vice Head wins.
    for (const r of rows) {
      const committeeId = r.new_committee_name
        ? committeeIdByName[r.new_committee_name as string] || null
        : ((r.committee_id as string | null) || null);
      if (!committeeId) continue;
      const memberId = memberIdByXlsxRow[r._xlsx_row as string];
      if (!memberId) continue;
      if (r.club_role === 'Committee Head') {
        await sql`UPDATE committees SET committee_head_member_id = ${memberId} WHERE committee_id = ${committeeId}`;
        headAssigned.add(committeeId);
        headsAssigned++;
      } else if (r.club_role === 'Committee Vice Head') {
        await sql`UPDATE committees SET committee_vice_head_member_id = ${memberId} WHERE committee_id = ${committeeId}`;
        viceAssigned.add(committeeId);
        headsAssigned++;
      }
    }

    // Second pass: club President / VPs / DVPs who have a committee
    // assignment AND whose committee doesn't already have a head/vice
    // set by the first pass. This is what the user means by "anyone
    // with a committee + president role is the head of that committee,
    // anyone with a committee + vice role is its vice."
    for (const r of rows) {
      const committeeId = r.new_committee_name
        ? committeeIdByName[r.new_committee_name as string] || null
        : ((r.committee_id as string | null) || null);
      if (!committeeId) continue;
      const memberId = memberIdByXlsxRow[r._xlsx_row as string];
      if (!memberId) continue;
      if (HEAD_ROLES.has(r.club_role as string) && !headAssigned.has(committeeId)) {
        await sql`UPDATE committees SET committee_head_member_id = ${memberId} WHERE committee_id = ${committeeId}`;
        headAssigned.add(committeeId);
        headsAssigned++;
      } else if (VICE_ROLES.has(r.club_role as string) && !viceAssigned.has(committeeId)) {
        await sql`UPDATE committees SET committee_vice_head_member_id = ${memberId} WHERE committee_id = ${committeeId}`;
        viceAssigned.add(committeeId);
        headsAssigned++;
      }
      // Schema only stores one vice per committee, so subsequent VP/DVPs
      // for the same committee (e.g. Communications has both Hanan and
      // Ryan in the xlsx) are dropped silently. Multi-vice support is a
      // schema follow-up.
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
    ` as Array<{
      member_id: string; full_name: string; email: string | null;
      national_id: string | null; club_role: string;
    }>;

    const usernamesSeen = new Set<string>();
    const accounts: Array<{
      username: string; access: string; name: string; role: string; temp_password: string;
    }> = [];
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
      const hash = await bcryptHash(tempPw, 6);
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
    const devAdmin = data.dev_admin as { username?: string; password?: string } | undefined;
    if (devAdmin && devAdmin.username) {
      const devUsername = String(devAdmin.username).toLowerCase().trim();
      const [clash] = await sql`SELECT id FROM users WHERE LOWER(username) = ${devUsername}` as Array<{ id: number }>;
      if (clash) throw httpErr(`dev_admin username "${devUsername}" collides with a leadership account — pick a different one`, 409);
      const devPassword = devAdmin.password || randomBytesB64Url(7);
      const devHash = await bcryptHash(devPassword, 6);
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
};

export const setupActions: Record<string, Handler> = {
  'setup.seedMembers': setupSeedMembers,
  'setup.bulkSeed':    setupBulkSeed,
};
