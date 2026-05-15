// Shared API client for every page.
//
// Single POST endpoint at the Supabase Edge Function; the body is always
// { action, ...params }. Auth (when present) is sent as a Bearer token in the
// Authorization header. The Supabase anon key is sent in the `apikey` header —
// Supabase requires this on every request to route it to the function (and
// it's safe to ship to the browser: RLS is the actual security boundary, the
// anon key only proves "this request is for this Supabase project").
//
// callApi() returns a flattened envelope so existing call sites that read
// either `result.data` (when the server returned an array) or `result.<field>`
// (when it returned a shaped object) both work without per-callsite branching.
//
// On 401 the helper clears the session and bounces the user to login.html —
// every page that imports this module gets that behaviour for free.

import { clearSession, getToken } from './auth.js';
import { t } from './i18n.js';

// ─── Server-error localization ──────────────────────────────────────
// Edge Function actions (supabase/functions/api/*) emit error CODES of
// the form `err.<namespace>.<name>` instead of human-readable strings.
// The dispatcher returns `{ success: false, error: '<code>', errorParams }`;
// localizeError() looks the code up in the i18n catalog and returns a
// translated string. Codes that aren't recognised (legacy errors from a
// not-yet-redeployed Edge Function, or anything else) fall through to
// their raw value so the user still sees *something* rather than a
// silent blank — Phase 6 ships in two halves and this is how the client
// stays useful while waiting on the Edge Function deploy.
//
// Safe to call with any input — null/undefined/empty → '' so call sites
// can do `toast(localizeError(res.error) || t('local.fallback'))`.
export function localizeError(raw, params) {
  if (!raw) return '';
  // Server-emitted code → catalog lookup.
  if (typeof raw === 'string' && /^err\./.test(raw)) return t(raw, params);
  // Anything else (legacy string, free-form message, etc.) — pass through.
  return raw;
}

// Supabase project URL + Edge Function endpoint. Same project hosts
// both — /functions/v1/api is our custom Edge Function (action
// dispatcher, replaces /.netlify/functions/api after the migration);
// /auth/v1/* is Supabase's built-in Auth API used by lib/auth.js for
// sign-in + password reset.
export const SUPABASE_URL = 'https://pfibxvwiulwiiuwerawe.supabase.co';
export const API_URL      = SUPABASE_URL + '/functions/v1/api';

// Supabase project anon key. PUBLIC — safe to commit + ship to the browser.
// This is not a secret; it identifies the project. Real auth is the Bearer
// JWT in `Authorization` (verified inside the Edge Function or by Supabase
// Auth), with RLS policies as the long-term security boundary.
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmaWJ4dndpdWx3aWl1d2VyYXdlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1ODI2NzEsImV4cCI6MjA5NDE1ODY3MX0.A0_w-iQQK-ozDiRWBS62ho_THvxEhzHWO-zgBcvfk78';

export async function callApi(action, params = {}) {
  const token   = getToken();
  const headers = {
    'Content-Type': 'application/json',
    'apikey':       SUPABASE_ANON_KEY,
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers,
    body:   JSON.stringify({ action, ...params }),
  });

  if (resp.status === 401) {
    clearSession();
    // Only redirect from authenticated pages — public pages (index, apply)
    // should surface the error to their own UI instead.
    if (!/^\/(index\.html|apply\.html|login\.html)?$/i.test(window.location.pathname)) {
      window.location.href = 'login.html';
    }
    return null;
  }

  const json = await resp.json().catch(() => null);
  if (!json) return null;

  // Flatten { success, data } → { success, error, errorParams, data, ...inner }
  // so callers can read either shape. errorParams carries {placeholder}
  // substitutions for the i18n catalog entry the `error` code points at.
  const inner = json.data;
  const flat  = {
    success:     json.success,
    error:       json.error,
    errorParams: json.errorParams,
    data:        inner,
  };
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    Object.assign(flat, inner);
  }
  return flat;
}

// Thin wrapper that throws on { success:false } so callers can use try/catch.
// Used by login/apply forms where we want explicit error handling.
// The thrown Error carries the localized message so existing
// `catch (e) { toast(e.message) }` call sites surface the right
// language without further changes.
export async function apiOrThrow(action, params = {}) {
  const r = await callApi(action, params);
  if (!r) throw new Error(t('err.unknown'));
  if (!r.success) throw new Error(localizeError(r.error, r.errorParams) || t('err.unknown'));
  return r;
}
