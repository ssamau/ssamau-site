// Shared SQL client for all Netlify Functions.
// `getDatabase()` auto-selects the right driver:
//   - local `netlify dev` → standard Postgres over TCP (pg.Pool)
//   - production Netlify  → Neon serverless over HTTPS
// Both expose the same `sql` tagged-template, so call sites are identical.
// Lazy-initialized on first request (Netlify's esbuild emits CJS, no top-level await).

import { getDatabase } from '@netlify/database';

let _sql;

export async function getSql() {
  if (_sql) return _sql;
  const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  const db = url ? getDatabase({ connectionString: url }) : getDatabase();
  console.log('[_db] driver:', db.driver, '— host:', new URL(db.connectionString).host);
  // Wrap the underlying tagged-template so any `undefined` interpolation becomes
  // SQL NULL. JSON.stringify drops `undefined` keys, so missing form fields show
  // up as undefined here; pg/waddler rejects undefined params with
  // "you can't specify undefined as parameter". This makes the API tolerant.
  const raw = db.sql;
  // - undefined → NULL (JSON drops undefined keys, missing form fields land as undefined)
  // - ''        → NULL (combined with COALESCE in update queries, an empty form
  //                     field cleanly means "leave existing value alone" instead of
  //                     blowing up when Postgres tries to cast '' to date/time/numeric)
  _sql = (strings, ...values) => raw(strings, ...values.map(v => (v === undefined || v === '') ? null : v));
  return _sql;
}

// Generates a short, URL-safe ID. Used for member_id / project_id / cert_code.
export function shortId(prefix, len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return prefix ? `${prefix}_${s}` : s;
}

// JSON response helper.
export function ok(data) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function fail(error, status = 400) {
  return new Response(JSON.stringify({ success: false, error: String(error) }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
