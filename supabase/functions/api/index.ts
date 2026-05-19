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
import { resolveUserContext, PUBLIC_ACTIONS, ADMIN_ACTIONS, SUPERADMIN_ACTIONS, httpErr, type Handler } from './_helpers.ts';

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
import { headActions }          from './actions/head.ts';
import { setupActions }         from './actions/setup.ts';
// Phase A's storage actions (member CV / photo uploaders + signed-URL
// fetchers) + Phase B's project-photo uploader (kept in its own file
// during parallel development to avoid this exact merge conflict).
// Both are wired here; a follow-up consolidation can fold them into
// one file when convenient.
import { storageActions }        from './actions/storage.ts';
import { projectStorageActions } from './actions/storage_project.ts';
// Support tickets — in-product bug/feature/question intake. Submission
// is auth-only (any logged-in user); list/update/getAttachment are
// gated to superadmin so only the dev sees the inbox.
import { supportActions }        from './actions/support.ts';

// ─── CORS ───────────────────────────────────────────────────────────────
// Frontend (ssamau.com) and the function (functions.supabase.co) are
// different origins, so the function emits CORS headers on every
// response. Security audit 2026-05-19 (finding H3): the previous
// `Access-Control-Allow-Origin: '*'` allowed any origin to call the
// API. Combined with localStorage-stored JWTs, an XSS bug on an
// unrelated site could exfiltrate tokens AND call the API directly.
//
// Allowlist + Vary: Origin so the CDN doesn't conflate cached
// responses across origins. Requests from unknown origins still
// get a response — we just don't advertise the cross-origin grant,
// so the browser refuses to expose the result to the calling script.
const ALLOWED_ORIGINS = new Set<string>([
  'https://ssamau.com',
  'https://www.ssamau.com',
  'https://ssamau.netlify.app',  // Netlify default subdomain
  'http://localhost:8888',        // netlify dev
  'http://127.0.0.1:8888',
]);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow  = ALLOWED_ORIGINS.has(origin) ? origin : 'https://ssamau.com';
  return {
    'Access-Control-Allow-Origin':      allow,
    'Vary':                             'Origin',
    'Access-Control-Allow-Headers':     'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods':     'GET, POST, OPTIONS',
    // H2 (2026-05-19): credentials must be allowed for the
    // ssam_session cookie to travel cross-origin (ssamau.com ↔
    // pfibxvwiulwiiuwerawe.supabase.co). The frontend pairs this with
    // `credentials: 'include'` on every fetch. Browsers refuse to
    // honor this with a wildcard origin — the allowlist above is the
    // mechanism that satisfies "specific origin required".
    'Access-Control-Allow-Credentials': 'true',
  };
}

// ─── Response helpers ───────────────────────────────────────────────────
function ok(req: Request, data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  });
}

// Phase 6: emits { error: '<code>', errorParams: {...} } so the client
// can localize via assets/js/lib/api.js `localizeError()`. Accepts
// either a bare code string OR an Error (typically HttpError from
// _helpers.ts) — the HttpError's `.params` flows through to
// errorParams so messages like "Member not found ({id})" can
// interpolate runtime data.
function fail(req: Request, error: string | (Error & { params?: Record<string, unknown> }), status = 400) {
  const msg    = error instanceof Error ? error.message : String(error);
  const params = error instanceof Error ? (error.params ?? null) : null;
  const body: Record<string, unknown> = { success: false, error: msg };
  if (params) body.errorParams = params;
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
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
  ...headActions,
  ...setupActions,
  ...storageActions,
  ...projectStorageActions,
  ...supportActions,
};

// ─── HTTP entry ─────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(req) });

  if (req.method !== 'POST') {
    return fail(req, 'err.dispatcher.method_not_allowed', 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail(req, 'err.dispatcher.body_must_be_json', 400);
  }

  const action = String(body.action ?? '').trim();
  if (!action) return fail(req, 'err.dispatcher.action_required', 400);

  const handler = actions[action];
  if (!handler) {
    // Build a real HttpError so fail() picks up the `params` for
    // `errorParams` interpolation (a plain object wouldn't satisfy
    // `instanceof Error`).
    return fail(req, httpErr('err.dispatcher.unknown_action', 404, { action }), 404);
  }

  // Auth gate. Public actions are dispatched anonymously; everything
  // else requires a valid session — cookie first (the canonical post-H2
  // path) then Authorization header (transitional, drained as old
  // localStorage-token clients re-log).
  let user: Awaited<ReturnType<typeof resolveUserContext>> = null;
  if (!PUBLIC_ACTIONS.has(action)) {
    user = await resolveUserContext(req);
    if (!user) return fail(req, 'err.auth.unauthorized', 401);
    // Role-system refactor (2026-05-15): admin-tier and superadmin-tier
    // allowlists are checked separately. ADMIN_ACTIONS opens the action
    // to presidency-or-dev (most operational ops); SUPERADMIN_ACTIONS
    // stays dev-only (currently empty, reserved for future dev-shaped
    // ops like the dev-account-handover flow).
    if (ADMIN_ACTIONS.has(action) && user.access !== 'superadmin' && user.access !== 'admin') {
      return fail(req, 'err.access.admin_only', 403);
    }
    if (SUPERADMIN_ACTIONS.has(action) && user.access !== 'superadmin') {
      return fail(req, 'err.access.dev_only', 403);
    }
  }

  // H2 (2026-05-19): collect Set-Cookie values the handler may queue
  // for login / signOut / token-exchange flows. The handler ctx
  // exposes a single `setCookie` callback that pushes onto this list,
  // and the response builder emits one Set-Cookie header per entry.
  const queuedCookies: string[] = [];
  const ctx = { setCookie: (v: string) => queuedCookies.push(v) };

  try {
    const data = await handler(body, user, req, ctx);
    const resp = ok(req, data);
    for (const c of queuedCookies) resp.headers.append('Set-Cookie', c);
    return resp;
  } catch (e) {
    const err = e as Error & { status?: number; params?: Record<string, unknown> };
    console.error(`[${action}]`, err);
    const resp = fail(req, err.message ? err : 'err.server', err.status || 500);
    // Even on error, propagate any cookies the handler queued before
    // throwing — e.g. signOut wants the clear-cookie to land even if a
    // later step errors.
    for (const c of queuedCookies) resp.headers.append('Set-Cookie', c);
    return resp;
  }
});
