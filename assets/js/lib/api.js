// Shared API client for every page.
//
// Single POST endpoint at /.netlify/functions/api; the body is always
// { action, ...params }. Auth (when present) is sent as a Bearer token in the
// Authorization header.
//
// callApi() returns a flattened envelope so existing call sites that read
// either `result.data` (when the server returned an array) or `result.<field>`
// (when it returned a shaped object) both work without per-callsite branching.
//
// On 401 the helper clears the session and bounces the user to login.html —
// every page that imports this module gets that behaviour for free.

import { clearSession, getToken } from './auth.js';

export const API_URL = '/.netlify/functions/api';

export async function callApi(action, params = {}) {
  const token   = getToken();
  const headers = { 'Content-Type': 'application/json' };
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
