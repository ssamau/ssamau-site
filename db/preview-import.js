// Prints a scannable, terminal-friendly summary of the normalised import data
// (uses the JSON produced by `npm run import:inspect`).
//
// Run with: npm run import:preview            → shows everyone
//           npm run import:preview <substring> → filters by name (Arabic or English)
//           npm run import:preview <xlsx-row>  → shows the single row from xlsx row N (full detail)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, 'import-preview.json');

const data = JSON.parse(await readFile(path, 'utf8'));
const arg = process.argv[2];

if (!arg) {
  console.log(`Showing ${data.rows.length} rows from ${data.source_xlsx}\n`);
  console.log('xlsx | Role            | Committee (xlsx)         | NID         | Phone           | Name');
  console.log('─────┼─────────────────┼──────────────────────────┼─────────────┼─────────────────┼──────────────────────');
  for (const r of data.rows) {
    const com  = r.new_committee_name || r.committee_id || '—';
    const cc   = r.phone_country_code ? r.phone_country_code + ' ' : '';
    const phone = r.phone ? cc + r.phone : '—';
    console.log(
      String(r._xlsx_row).padStart(4) + ' | ' +
      (r.club_role || '—').padEnd(15) + ' | ' +
      (com || '—').padEnd(24) + ' | ' +
      (r.national_id || '—').padEnd(11) + ' | ' +
      phone.padEnd(15) + ' | ' +
      (r.name_ar || '')
    );
  }
  console.log('');
  if (data.new_committees.length) {
    console.log('Will CREATE new committees:');
    for (const c of data.new_committees) console.log('  + ' + c);
  }
  console.log('');
  console.log('To view one row in full detail:  npm run import:preview <xlsx-row>');
  console.log('To filter by name:               npm run import:preview "احمد"');
} else if (/^\d+$/.test(arg)) {
  const row = data.rows.find(r => r._xlsx_row === Number(arg));
  if (!row) { console.error(`No row with _xlsx_row=${arg}`); process.exit(1); }
  console.log(JSON.stringify(row, null, 2));
} else {
  const needle = arg.toLowerCase();
  const matches = data.rows.filter(r =>
    (r.name_ar || '').toLowerCase().includes(needle) ||
    (r.name_en || '').toLowerCase().includes(needle)
  );
  console.log(`${matches.length} match(es) for "${arg}":\n`);
  for (const r of matches) {
    console.log(`xlsx ${r._xlsx_row}: ${r.name_ar} (${r.club_role}) — NID ${r.national_id || '—'}, phone ${(r.phone_country_code || '') + ' ' + (r.phone || '—')}`);
  }
}
