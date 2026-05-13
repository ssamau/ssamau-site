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

  // Flatten { success, data } → { success, error, data, ...inner } so callers
  // can read either shape.
  const inner = json.data;
  const flat  = { success: json.success, error: json.error, data: inner };
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    Object.assign(flat, inner);
  }
  return flat;
}

// Thin wrapper that throws on { success:false } so callers can use try/catch.
// Used by login/apply forms where we want explicit error handling.
export async function apiOrThrow(action, params = {}) {
  const r = await callApi(action, params);
  if (!r) throw new Error('network');
  if (!r.success) throw new Error(r.error || 'unknown error');
  return r;
}
