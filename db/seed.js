// Thin seed client. Reads the members CSV, POSTs it to the local dev server's
// `setup.bulkSeed` action, prints the temporary leadership passwords.
//
// Usage:
//   1. Make sure `netlify dev` is running in another terminal.
//   2. `npm run seed`
//
// Idempotent: the server-side action refuses to run if users already exist.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.SEED_ENDPOINT || 'http://localhost:8888/.netlify/functions/api';

const csvPath = resolve(here, '..', '..', 'SSAMwebmanagment - Members.csv');
const csvText = await readFile(csvPath, 'utf8');

console.log(`[seed] Posting ${csvText.length} bytes of CSV to ${ENDPOINT}…`);

let resp;
try {
  resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setup.bulkSeed', csv_text: csvText }),
  });
} catch (e) {
  console.error('[seed] Could not reach the dev server. Is `netlify dev` running?');
  console.error(e.message);
  process.exit(1);
}

const json = await resp.json();
if (!resp.ok || !json.success) {
  console.error(`[seed] Server returned ${resp.status}: ${json.error || JSON.stringify(json)}`);
  process.exit(1);
}

const { committees, members_inserted, accounts } = json.data;
console.log(`\n✓ Seeded ${committees} committees and ${members_inserted} members.\n`);
console.log('  ╔══════════════════════════════════════════════════════════════════════════');
console.log('  ║ TEMPORARY PASSWORDS — copy these now, they will not be retrievable again');
console.log('  ╚══════════════════════════════════════════════════════════════════════════');
for (const a of accounts) {
  const u = (a.username + '').padEnd(18);
  const r = (a.access  + '').padEnd(11);
  console.log(`  • ${u} ${r} ${a.temp_password.padEnd(10)}  ${a.name}`);
}
console.log('\n  Distribute through a secure channel — they cannot be recovered later.');
