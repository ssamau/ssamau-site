// One-shot admin-account creator. Used to bootstrap superadmin accounts
// for the dev/maintainer of this project (or to rescue a locked-out site)
// without needing an existing admin login.
//
// Talks to the SAME `users.create` action the admin UI uses — except this
// script authenticates first using an EXISTING superadmin's credentials.
// If you're truly locked out (no surviving superadmin), use the SQL path
// at the bottom of this file as a comment instead.
//
// Usage:
//   ADMIN_USERNAME=faisal-admin \
//   ADMIN_ACCESS=superadmin \
//   ADMIN_AUTH_USERNAME=president \
//   ADMIN_AUTH_PASSWORD=<existing-superadmin-pw> \
//   npm run admin:create
//
// Optional:
//   ADMIN_PASSWORD=<plain>     — supply a password; otherwise one is generated
//   ADMIN_MEMBER_ID=<MBR_xxx>  — link to an existing member (default: no link)
//   ADMIN_ENDPOINT=<URL>       — override target (default: localhost dev server)

import { randomBytes } from 'node:crypto';

const ENDPOINT     = process.env.ADMIN_ENDPOINT      || 'http://localhost:8888/.netlify/functions/api';
const NEW_USERNAME = process.env.ADMIN_USERNAME;
const NEW_ACCESS   = process.env.ADMIN_ACCESS        || 'superadmin';
const NEW_MEMBER   = process.env.ADMIN_MEMBER_ID     || null;
const NEW_PASSWORD = process.env.ADMIN_PASSWORD      || randomBytes(7).toString('base64url');
const AUTH_USER    = process.env.ADMIN_AUTH_USERNAME;
const AUTH_PW      = process.env.ADMIN_AUTH_PASSWORD;

if (!NEW_USERNAME || !AUTH_USER || !AUTH_PW) {
  console.error('Required: ADMIN_USERNAME, ADMIN_AUTH_USERNAME, ADMIN_AUTH_PASSWORD');
  console.error('Optional: ADMIN_PASSWORD, ADMIN_ACCESS, ADMIN_MEMBER_ID, ADMIN_ENDPOINT');
  process.exit(1);
}

console.log(`[admin] Authenticating as ${AUTH_USER}…`);
const authResp = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'auth', username: AUTH_USER, password: AUTH_PW }),
});
const authJson = await authResp.json();
if (!authJson?.success) { console.error('Auth failed:', authJson?.error); process.exit(1); }
if (authJson.data.user.access !== 'superadmin') {
  console.error('The auth user is not a superadmin — cannot create accounts.');
  process.exit(1);
}
const token = authJson.data.token;
console.log(`[admin] ✓ authenticated as ${authJson.data.user.name || AUTH_USER}`);

console.log(`[admin] Creating ${NEW_ACCESS} "${NEW_USERNAME}"${NEW_MEMBER ? ` linked to ${NEW_MEMBER}` : ' (no member link)'}…`);
const createResp = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({
    action:       'users.create',
    username:     NEW_USERNAME,
    password:     NEW_PASSWORD,
    access_level: NEW_ACCESS,
    member_id:    NEW_MEMBER,
  }),
});
const createJson = await createResp.json();
if (!createResp.ok || !createJson.success) {
  console.error(`[admin] Server returned ${createResp.status}: ${createJson.error || JSON.stringify(createJson)}`);
  process.exit(1);
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  Account created');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  username:  ${NEW_USERNAME}`);
console.log(`  password:  ${NEW_PASSWORD}`);
console.log(`  access:    ${NEW_ACCESS}`);
if (NEW_MEMBER) console.log(`  linked to: ${NEW_MEMBER}`);
console.log('');
console.log('  Copy the password now — it is not stored anywhere recoverable.');

// ─── Truly-locked-out recovery path (not run by this script) ─────────────────
// If no superadmin survives, log in via `netlify db connect` and run:
//
//   INSERT INTO users (username, password_hash, access_level)
//   VALUES ('faisal-admin', '$2a$10$<bcrypt-hash-here>', 'superadmin');
//
// Generate the bcrypt hash from a plain password with:
//   node -e "import('bcryptjs').then(b=>b.default.hash('YOUR_PW',10).then(console.log))"
// (this script's normal path already handles that for you.)
