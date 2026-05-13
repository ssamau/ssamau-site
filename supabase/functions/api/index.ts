// SSAM API — Supabase Edge Function port of netlify/functions/api.js.
//
// Single endpoint, action-dispatch pattern. Mirrors the Netlify Functions
// version one-to-one so the frontend (`assets/js/lib/api.js`) keeps making
// the same POST body shape — only the URL changes. The 40 actions land in
// supabase/functions/api/actions/*.ts in subsequent commits; this scaffold
// is the request envelope, auth gate, and dispatcher.
//
// Runtime: Deno (Supabase Edge Functions). All deps come from JSR / esm.sh
// per Supabase's recommended import style — no node_modules.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// ─── ENV ────────────────────────────────────────────────────────────────
// Set automatically by Supabase for every Edge Function deployment. We never
// hard-code these — the function adapts to whichever project it's deployed
// into, which is convenient when staging vs prod live in different projects.
const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Custom legacy JWT secret — kept transiently so the existing admin/login
// flow keeps working while we still use the `public.users` table. The auth
// migration commit later in this branch swaps this out for Supabase Auth
// (magic-link) and the user/JWT plumbing goes away.
const LEGACY_JWT_SECRET = Deno.env.get('JWT_SECRET') ?? '';

// ─── CORS ───────────────────────────────────────────────────────────────
// The frontend is served from a different origin (ssamau.com) than the
// function (functions.supabase.co), so we need proper CORS — Supabase
// recommends responding to OPTIONS preflights with these.
const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ─── Public (no-auth) actions ───────────────────────────────────────────
// Same allowlist shape as netlify/functions/_auth.js. Everything else
// requires a Bearer JWT validated against LEGACY_JWT_SECRET (or, post
// auth-migration, a Supabase Auth token).
const PUBLIC_ACTIONS = new Set([
  'auth',
  'getMembers', 'getCommittees', 'getAdvisors', 'getProjects',
  'certs.verify',
  'setup.bulkSeed',
  'applications.submit',
]);

const SUPERADMIN_ACTIONS = new Set([
  'createProject', 'deleteProject',
  'createAdvisor', 'updateAdvisor', 'deleteAdvisor',
  'createCommittee', 'updateCommittee', 'deleteCommittee',
  'deleteMember',
  'setup.seedMembers',
  'hours.finalApprove',
  'users.create', 'users.update', 'users.delete',
]);

// ─── Helpers ────────────────────────────────────────────────────────────
function ok(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function fail(error: string | Error, status = 400) {
  const msg = error instanceof Error ? error.message : String(error);
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Service-role client — bypasses RLS. Used by every action below; once we
// layer RLS policies on top we'll create a per-request anon client with the
// caller's JWT instead for SELECTs. For writes the service-role is
// appropriate (we do scope checks in JS based on the decoded JWT).
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// JWT verify against the legacy HS256 secret. Returns the decoded payload
// or null. Same shape the Netlify _auth.js verifyToken() returned:
//   { id, username, access, member_id, committee_id, iat, exp }
async function verifyLegacyJwt(authHeader: string | null): Promise<Record<string, unknown> | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];
  if (!LEGACY_JWT_SECRET) return null;
  try {
    const { jwtVerify } = await import('https://esm.sh/jose@5.6.3');
    const key = new TextEncoder().encode(LEGACY_JWT_SECRET);
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Action registry ────────────────────────────────────────────────────
// Each action handler gets the parsed body + the decoded user (or null for
// PUBLIC_ACTIONS). The registry is small for now — subsequent commits port
// the remaining 35+ actions from netlify/functions/api.js.
type Handler = (body: Record<string, unknown>, user: Record<string, unknown> | null) => Promise<unknown>;

const actions: Record<string, Handler> = {
  // Smoke-test endpoint — handy for confirming the function is live.
  'healthcheck': async () => ({
    ok: true,
    time: new Date().toISOString(),
    runtime: 'supabase-edge',
  }),

  // The 40 production actions land here as separate handler files imported
  // above. Stubbed for now so the dispatcher can be tested in isolation:
  // 'getMembers':       members.getMembers,
  // 'createMember':     members.createMember,
  // ...
};

// ─── HTTP entry ─────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (req.method !== 'POST') {
    return fail('Only POST is supported on this endpoint.', 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail('Request body must be JSON.', 400);
  }

  const action = String(body.action ?? '').trim();
  if (!action) return fail('`action` is required.', 400);

  const handler = actions[action];
  if (!handler) return fail(`Unknown action: ${action}`, 404);

  // Auth gate. Public actions are dispatched anonymously; everything else
  // requires a valid legacy JWT (until the Supabase Auth migration lands).
  let user: Record<string, unknown> | null = null;
  if (!PUBLIC_ACTIONS.has(action)) {
    user = await verifyLegacyJwt(req.headers.get('authorization'));
    if (!user) return fail('Unauthorized', 401);
    if (SUPERADMIN_ACTIONS.has(action) && user.access !== 'superadmin') {
      return fail('Forbidden — superadmin only', 403);
    }
  }

  try {
    const data = await handler(body, user);
    return ok(data);
  } catch (e) {
    const err = e as Error & { status?: number };
    console.error(`[${action}]`, err);
    return fail(err.message || 'Server error', err.status || 500);
  }
});
