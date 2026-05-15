// One-off cutover for the remaining legacy (HS256) leadership accounts.
//
// For each `public.users` row with `auth_user_id IS NULL`:
//   1. Create an `auth.users` row via Supabase admin SDK (email_confirm=true
//      so the user doesn't need to verify the email separately).
//   2. UPDATE public.users SET auth_user_id = <new id>, password_hash = NULL.
//   3. Fire a password-recovery email via resetPasswordForEmail so the user
//      lands on /reset-password.html and sets their own password.
//
// Behaviour:
//   - Dry-run by default. Pass `--execute` to actually run.
//   - Idempotent: skips users that already have auth_user_id set.
//   - Re-runnable: if step 1 succeeded but step 2 failed last time, the
//     orphan auth.users row gets reused on retry (createUser returns the
//     existing row when email collides).
//
// Usage:
//   node --env-file=.env.local db/migrate-legacy-to-auth.js              # dry run
//   node --env-file=.env.local db/migrate-legacy-to-auth.js --execute    # do it

import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

const EXECUTE      = process.argv.includes('--execute');
const REDIRECT_URL = process.env.RESET_REDIRECT_URL || 'https://ssamau.com/reset-password.html';

const DB_URL              = process.env.SUPABASE_DB_URL;
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DB_URL || !SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env: need SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const sql   = postgres(DB_URL, { ssl: 'require' });
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`Mode: ${EXECUTE ? 'EXECUTE (will mutate prod)' : 'DRY RUN (no changes)'}`);
console.log(`Recovery redirectTo: ${REDIRECT_URL}\n`);

const rows = await sql`
  SELECT u.id, u.username, u.access_level, u.member_id,
         m.full_name, m.email, m.national_id
  FROM public.users u
  LEFT JOIN public.members m ON m.member_id = u.member_id
  WHERE u.auth_user_id IS NULL AND u.password_hash IS NOT NULL
  ORDER BY u.id
`;

console.log(`Found ${rows.length} legacy account(s) to migrate.\n`);

if (rows.length === 0) {
  console.log('Nothing to do.');
  await sql.end();
  process.exit(0);
}

let migrated = 0, skipped = 0, failed = 0;

for (const r of rows) {
  console.log(`── User #${r.id}: ${r.username} (${r.full_name || '?'}) ${r.access_level}`);
  if (!r.email) {
    console.log('   ⏭  Skipping: no email on member row.');
    skipped++; continue;
  }
  console.log(`   Email: ${r.email}`);
  console.log(`   NID:   ${r.national_id}`);

  if (!EXECUTE) {
    console.log('   (dry-run) Would: createUser → UPDATE auth_user_id → resetPasswordForEmail');
    migrated++; continue;
  }

  // Step 1: create auth.users (or reuse if email already exists in auth).
  let authUserId;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: r.email,
    email_confirm: true,
  });
  if (createErr) {
    // If the email already exists in auth.users from a prior partial run,
    // look it up via listUsers and reuse.
    const isCollision = /already.*registered|duplicate|exists/i.test(createErr.message || '');
    if (!isCollision) {
      console.error(`   ✗ createUser failed: ${createErr.message}`);
      failed++; continue;
    }
    const { data: listed, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) { console.error(`   ✗ listUsers failed: ${listErr.message}`); failed++; continue; }
    const existing = listed.users.find(u => (u.email || '').toLowerCase() === r.email.toLowerCase());
    if (!existing) { console.error('   ✗ Email collision but no matching auth user found.'); failed++; continue; }
    authUserId = existing.id;
    console.log(`   ↺ Reusing existing auth.users row: ${authUserId}`);
  } else {
    authUserId = created.user.id;
    console.log(`   ✓ Created auth.users row: ${authUserId}`);
  }

  // Step 2: link + drop legacy hash. Wrapped in a transaction so a failure
  // here doesn't leave a half-migrated state.
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE public.users
           SET auth_user_id  = ${authUserId},
               password_hash = NULL
         WHERE id = ${r.id}
      `;
    });
    console.log('   ✓ Linked public.users → auth.users, cleared password_hash.');
  } catch (e) {
    console.error(`   ✗ DB link failed: ${e.message}`);
    failed++; continue;
  }

  // Step 3: send the recovery email so the user can set a password.
  const { error: resetErr } = await admin.auth.resetPasswordForEmail(r.email, {
    redirectTo: REDIRECT_URL,
  });
  if (resetErr) {
    console.error(`   ⚠ resetPasswordForEmail failed: ${resetErr.message}`);
    console.error('     User is migrated, but no email was sent. Re-run the action from admin UI.');
    failed++; continue;
  }
  console.log(`   ✓ Recovery email sent to ${r.email}.`);
  migrated++;
}

console.log(`\n──────────────────────────────`);
console.log(`Migrated: ${migrated}`);
console.log(`Skipped:  ${skipped}`);
console.log(`Failed:   ${failed}`);
console.log(`──────────────────────────────`);

await sql.end();
process.exit(failed > 0 ? 1 : 0);
