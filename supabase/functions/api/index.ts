// SSAM API — Supabase Edge Function port of netlify/functions/api.js.
//
// Single endpoint, action-dispatch pattern. The frontend POSTs
// `{ action, ...params }` and gets back `{ success, data }` or
// `{ success: false, error }`. The wire-protocol matches the Netlify
// Functions version exactly so `assets/js/lib/api.js` only needs its
// base URL bumped after this lands.
//
// Architecture:
//   _sql.ts           — postgres.js client + tagged-template sql.
//   _helpers.ts       — bcrypt, jose-based JWT, role guards, shortId.
//   actions/*.ts      — handlers, grouped one module per domain.
//   index.ts (this)   — request envelope, auth gate, action map merge.
//
// Runtime: Deno (Supabase Edge Functions). All deps come from JSR /
// esm.sh / deno.land — no node_modules.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { verifyToken, PUBLIC_ACTIONS, SUPERADMIN_ACTIONS, type Handler } from './_helpers.ts';

// Action modules. Each one exports a `Record<string, Handler>` keyed by
// the same action names the frontend uses (`getMembers`, `users.create`,
// `applications.submit`, etc.). Order doesn't matter — Object.assign
// flattens them into one lookup table.
import { authActions }          from './actions/auth.ts';
import { membersActions }       from './actions/members.ts';
import { advisorsActions }      from './actions/advisors.ts';
import { committeesActions }    from './actions/committees.ts';
import { projectsActions }      from './actions/projects.ts';
import { participantsActions }  from './actions/participants.ts';
import { attendanceActions }    from './actions/attendance.ts';
import { hoursActions }         from './actions/hours.ts';
import { interestActions }      from './actions/interest.ts';
import { thanksActions }        from './actions/thanks.ts';
import { certsActions }         from './actions/certs.ts';
import { dashboardActions }     from './actions/dashboard.ts';
import { opportunitiesActions } from './actions/opportunities.ts';
import { assignmentsActions }   from './actions/assignments.ts';
import { applicationsActions }  from './actions/applications.ts';
import { setupActions }         from './actions/setup.ts';

// ─── CORS ───────────────────────────────────────────────────────────────
// Frontend (ssamau.com) and the function (functions.supabase.co) are
// different origins, so respond to OPTIONS preflights with these.
const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ─── Response helpers ───────────────────────────────────────────────────
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

// ─── Action registry ────────────────────────────────────────────────────
// Flatten every action module's exports into a single lookup table. A
// duplicate key from two modules would silently overwrite — we trust the
// names are unique because they originate from netlify/functions/api.js
// (which also uses one flat object). The Bash diff in commit notes
// confirmed all 66 names are unique across modules.
const actions: Record<string, Handler> = {
  // Smoke-test endpoint — handy for confirming the function is live and
  // its DB connection is healthy. Not in PUBLIC_ACTIONS, so callers need
  // a valid JWT — that's fine, only ops uses it.
  'healthcheck': async () => ({
    ok: true,
    time: new Date().toISOString(),
    runtime: 'supabase-edge',
  }),
  ...authActions,
  ...membersActions,
  ...advisorsActions,
  ...committeesActions,
  ...projectsActions,
  ...participantsActions,
  ...attendanceActions,
  ...hoursActions,
  ...interestActions,
  ...thanksActions,
  ...certsActions,
  ...dashboardActions,
  ...opportunitiesActions,
  ...assignmentsActions,
  ...applicationsActions,
  ...setupActions,
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

  // Auth gate. Public actions are dispatched anonymously; everything
  // else requires a valid legacy JWT (until the Supabase Auth migration
  // commit later in this branch swaps it for Supabase-issued tokens).
  let user: Awaited<ReturnType<typeof verifyToken>> = null;
  if (!PUBLIC_ACTIONS.has(action)) {
    user = await verifyToken(req.headers.get('authorization'));
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
