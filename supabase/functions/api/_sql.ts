// Postgres connection for the api Edge Function.
//
// We deliberately use the postgres.js driver here instead of the
// @supabase/supabase-js client so the 56 handler bodies port near-verbatim
// from netlify/functions/api.js — same `sql\`SELECT ... ${value}\`` tagged
// template, same return shape (array of row objects). Switching every
// handler to the Supabase query builder (`supabase.from('x').select(...)`)
// would be a multi-day rewrite for zero functional gain on this branch.
//
// Connection target: the Supabase transaction pooler (port 6543, single
// shared connection per Edge Function instance — the pooler upstream
// handles real per-statement multiplexing into Postgres). The connection
// URL comes from the SUPABASE_DB_URL secret we set via
// `supabase secrets set`; service-role key isn't a substitute because
// postgres.js needs the real connection string.
//
// The wrapper rebinds the tagged template so that `undefined` and empty
// string interpolations become SQL NULL — the same compatibility shim
// the Netlify _db.js had, to keep form submissions with missing fields
// from blowing up.

// esm.sh/postgres works on Deno + Supabase Edge Functions. The
// alternative `https://deno.land/x/postgresjs/mod.ts` would also work
// but the project's deno.land/x slug is currently 404 (stale at the
// time of writing) — esm.sh is the same upstream Porsager/postgres.
import postgres from 'https://esm.sh/postgres@3.4.5';

// Note: NOT `SUPABASE_DB_URL` — Supabase reserves the SUPABASE_ prefix
// for its own auto-injected secrets and refuses to let you set one with
// `supabase secrets set`. So we use `DB_URL` as our own namespace.
const DB_URL = Deno.env.get('DB_URL');
if (!DB_URL) {
  // Loud failure at module load — better than a confusing 500 on first
  // request when a handler tries to query.
  throw new Error('DB_URL env var is required (run `supabase secrets set DB_URL=...`).');
}

// One client per Edge Function instance. The pooler handles the rest.
// `prepare: false` because the transaction pooler (port 6543) doesn't
// support prepared statements across statements — they'd live on a
// connection we don't own.
const raw = postgres(DB_URL, {
  ssl: 'require',
  prepare: false,
  // The pooler will multiplex; we don't need a deep local pool.
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});

// The tagged-template wrapper exposed to handlers. Identical signature
// to the Netlify side, including the undefined/'' → NULL coercion.
//
// Callers may also need `.unsafe(rawSql, params)` for the rare dynamic-
// SQL spots (none in the current handlers, but exposing it future-proofs
// the seed/maintenance scripts).
type SqlArg = unknown;
type TaggedSql = ((strings: TemplateStringsArray, ...values: SqlArg[]) => Promise<unknown[]>) & {
  unsafe: (text: string, params?: unknown[]) => Promise<unknown[]>;
  begin: typeof raw.begin;
};

export const sql: TaggedSql = ((strings: TemplateStringsArray, ...values: SqlArg[]) => {
  const coerced = values.map((v) => (v === undefined || v === '') ? null : v);
  // postgres.js's TS types insist on a `Parameter<T>` per slot where T is
  // inferred per-call. Coercing through `any` here keeps the runtime
  // semantics identical (the driver accepts plain JS values fine) while
  // sidestepping the generic constraint that Deno's tsc can't satisfy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (raw as any)(strings, ...coerced) as Promise<unknown[]>;
}) as TaggedSql;

// Expose `.unsafe` and `.begin` for transaction-style operations
// (bulkSeed uses sql.begin for atomicity).
sql.unsafe = raw.unsafe.bind(raw) as TaggedSql['unsafe'];
sql.begin = raw.begin.bind(raw);
