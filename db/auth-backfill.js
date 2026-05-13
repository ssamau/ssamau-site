// One-shot backfill: create auth.users rows for legacy public.users
// accounts that have a usable email, and link the two via
// public.users.auth_user_id.
//
// Sends ZERO emails. Each migrated account gets a throwaway random
// password — the only way to log in via the Supabase path is for a
// superadmin to click "Send password reset email" in the admin UI,
// which fires off a Supabase-issued recovery email the user clicks
// to set their real password. This separation is intentional: the
// backfill is reversible (delete the auth.users rows, set
// auth_user_id back to NULL) and doesn't ping users until you say so.
//
// Idempotent. Re-run as many times as needed:
//   - already-migrated rows (auth_user_id IS NOT NULL) are skipped
//   - rows without a usable email are skipped (the 4 leadership
//     accounts: president, lead_mbr_r82ypy, lead_mbr_enftku,
//     lead_mbr_22wj7q — they stay on legacy auth until you collect
//     their emails and re-run this script)
//
// Usage:
//   npm run auth:backfill
//
//   Requires .env.local to be present with:
//     SUPABASE_URL
//     SUPABASE_SERVICE_ROLE_KEY  (bypasses RLS, allows auth.admin API)
//     SUPABASE_DB_URL            (postgres connection string)
//
// Email resolution rules:
//   - If public.users.username has a corresponding member row with a
//     non-empty members.email → use that.
//   - Exception for faisal-admin (the dev/maintainer account that has
//     no member row): use xtlg511@icloud.com (Faisal's apple ID).
//     If a different dev later takes over, change the override below
//     or add a member row for them.
//
// Dry-run mode:
//   DRY_RUN=1 npm run auth:backfill
//   Prints the plan (which users would be created with which emails)
//   and exits without touching auth.users.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

// ─── Load .env.local ──────────────────────────────────────────────
// We deliberately don't use a dotenv lib — three vars, twelve lines.
const ENV_PATH = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const SUPABASE_URL              = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
// SUPABASE_DB_URL doesn't exist in .env.local — we already know the
// pooler URL from the migration step. Resolve in priority order.
const SUPABASE_DB_URL = env.SUPABASE_DB_URL || env.DB_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_DB_URL) {
  console.error('Missing one of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_DB_URL in .env.local');
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === '1';

// ─── Connections ──────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sql = postgres(SUPABASE_DB_URL, { ssl: 'require', prepare: false, max: 2 });

// ─── Email-override table for admin-only accounts ─────────────────
// faisal-admin has no member row, so members.email is null. Hardcode
// the dev/maintainer email here. Extend this map for any future
// admin-only accounts. Keys are public.users.username, lowercase.
const ADMIN_EMAIL_OVERRIDES = {
  'faisal-admin': 'xtlg511@icloud.com',
};

// ─── Plan: who can we migrate, who do we skip? ────────────────────
const rows = await sql`
  SELECT
    u.id,
    u.username,
    u.access_level,
    u.member_id,
    u.auth_user_id,
    m.full_name AS member_name,
    m.email     AS member_email
  FROM public.users u
  LEFT JOIN public.members m ON m.member_id = u.member_id
  ORDER BY
    CASE u.access_level
      WHEN 'superadmin' THEN 1 WHEN 'head' THEN 2 ELSE 3
    END,
    u.username
`;

const plan = rows.map(r => {
  if (r.auth_user_id) return { ...r, action: 'skip', reason: 'already migrated' };
  const overrideEmail = ADMIN_EMAIL_OVERRIDES[r.username.toLowerCase()];
  const email = overrideEmail || r.member_email || null;
  if (!email) return { ...r, action: 'skip', reason: 'no usable email' };
  return { ...r, action: 'migrate', email };
});

const toMigrate = plan.filter(p => p.action === 'migrate');
const skipped   = plan.filter(p => p.action === 'skip');

console.log(`\nPlan: ${toMigrate.length} to migrate, ${skipped.length} to skip\n`);
console.log('Migrate:');
for (const p of toMigrate) {
  console.log(`  ✓ ${p.username.padEnd(24)} ${p.access_level.padEnd(10)} → ${p.email}`);
}
if (skipped.length) {
  console.log('\nSkip:');
  for (const p of skipped) {
    console.log(`  · ${p.username.padEnd(24)} ${p.access_level.padEnd(10)} (${p.reason})`);
  }
}

if (DRY_RUN) {
  console.log('\n(DRY_RUN=1 — exiting without creating auth.users rows)');
  await sql.end();
  process.exit(0);
}

// ─── Execute: create auth.users + update public.users.auth_user_id ─
console.log('\nCreating auth.users rows…\n');
let ok = 0, fail = 0;
for (const p of toMigrate) {
  // Random throwaway password. Long enough to satisfy Supabase's
  // default password-strength policy (>= 6 chars). User can never
  // see or use this — the only login path is via password reset.
  const tempPassword = 'temp_' + crypto.randomUUID().replace(/-/g, '');

  // Two ways an existing auth.users row could already exist:
  //   1. Backfill was previously aborted mid-loop (some rows
  //      created, public.users.auth_user_id never written back).
  //   2. The same email was used for a different account.
  // Look up by email first; only create if missing.
  let authUser = null;
  const { data: existing, error: lookupErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (lookupErr) {
    console.error(`  ✗ ${p.username}: listUsers failed:`, lookupErr.message);
    fail++; continue;
  }
  authUser = existing.users.find(u => u.email?.toLowerCase() === p.email.toLowerCase()) || null;

  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email:         p.email,
      password:      tempPassword,
      email_confirm: true,           // skip the confirmation email
      user_metadata: {
        legacy_username: p.username,
        member_id:       p.member_id,
        full_name:       p.member_name || null,
      },
    });
    if (error) {
      console.error(`  ✗ ${p.username}: createUser failed:`, error.message);
      fail++; continue;
    }
    authUser = data.user;
    console.log(`  ✓ created auth.users for ${p.username} (${p.email})`);
  } else {
    console.log(`  ↻ found existing auth.users for ${p.email} — linking`);
  }

  await sql`UPDATE public.users SET auth_user_id = ${authUser.id} WHERE id = ${p.id}`;
  ok++;
}

console.log(`\nDone — ${ok} migrated, ${fail} failed, ${skipped.length} skipped (no email).\n`);
console.log('Reminder: NO password-reset emails have been sent. Use the admin UI');
console.log('to ping users one-by-one when you\'re ready.');

await sql.end();
process.exit(fail ? 1 : 0);
