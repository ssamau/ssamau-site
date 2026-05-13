// Login page logic.
//
// Two-step sign-in now that Supabase Auth coexists with the legacy
// bcrypt+HS256 path:
//
//   Step 1: ask the Edge Function (`auth.resolveIdentifier`) what
//           auth provider handles this identifier. The identifier can
//           be an email, a national ID, or the legacy username — the
//           server resolves any of them to a single user row.
//
//   Step 2 — Supabase path:
//           POST /auth/v1/token?grant_type=password directly to
//           Supabase Auth with the resolved email. On success, fetch
//           `auth.whoami` to get the app-level profile (access_level,
//           member_id, etc.) and save both.
//
//   Step 2 — legacy path:
//           POST `auth` action with the resolved username + password,
//           same as before. Returns { token, user }.
//
// Either way the result is a saved session and a redirect to admin.html.
//
// CSP note: all handlers wired via addEventListener — no inline onclick.

import { callApi, apiOrThrow } from './lib/api.js';
import {
  saveSession, saveSupabaseSession,
  supabaseSignIn, getLastUsername, isLoggedIn,
} from './lib/auth.js';
import { $ } from './lib/dom.js';

// Already logged in → straight to admin. Runs on module load.
if (isLoggedIn()) {
  window.location.href = 'admin.html';
}

// Pre-fill the last successful identifier. Could be email/NID/username,
// whatever they used last time. Pure UX, no secrets.
const idInput  = $('#identifier');
const lastUser = getLastUsername();
if (idInput && lastUser) idInput.value = lastUser;

// ── Wire handlers ───────────────────────────────────────────────────
$('#login-btn')?.addEventListener('click', doLogin);
$('#pw-eye')   ?.addEventListener('click', togglePw);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

// ── Logic ───────────────────────────────────────────────────────────
async function doLogin() {
  // Don't lowercase — the identifier might be a national_id (digits)
  // or an email (case-insensitive on server) or a username (server
  // already does LOWER() comparison). Preserve as typed.
  const identifier = $('#identifier').value.trim();
  const password   = $('#password').value;

  if (!identifier || !password) {
    showError('يرجى إدخال المعرّف وكلمة المرور');
    return;
  }

  const btn = $('#login-btn');
  btn.disabled  = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    // ── Step 1: resolve identifier to auth provider ───────────────
    const resolveResult = await callApi('auth.resolveIdentifier', { identifier });
    if (!resolveResult || !resolveResult.success || !resolveResult.found) {
      // Generic error message — don't leak whether the identifier matched
      // (rate-limit-friendly + slightly less account-enumeration-friendly).
      throw new Error('invalid');
    }

    // ── Step 2A: Supabase path ────────────────────────────────────
    if (resolveResult.auth_provider === 'supabase') {
      const session = await supabaseSignIn(resolveResult.email, password);
      if (!session?.access_token) throw new Error('invalid');

      // We have a Supabase session now. Fetch the app-level profile via
      // `auth.whoami` — needs to go through callApi() so the apikey
      // header is set and the Bearer token from the new session is
      // attached. Trick: getToken() reads sessionStorage, so we need
      // to save the Supabase session BEFORE the whoami call, then
      // augment with the profile after it returns.
      saveSupabaseSession(session, { username: identifier });
      const whoami = await apiOrThrow('auth.whoami');
      // Re-save with the full profile. saveSupabaseSession overwrites
      // the previous entry cleanly.
      saveSupabaseSession(session, whoami);
      window.location.href = 'admin.html';
      return;
    }

    // ── Step 2B: legacy path ──────────────────────────────────────
    if (resolveResult.auth_provider === 'legacy') {
      const r = await apiOrThrow('auth', {
        username: resolveResult.username,
        password,
      });
      if (!r.token || !r.user) throw new Error('bad response shape');
      saveSession(r.user, r.token);
      window.location.href = 'admin.html';
      return;
    }

    // Shouldn't reach here unless the server invents a new provider.
    throw new Error('Unknown auth provider: ' + resolveResult.auth_provider);
  } catch (e) {
    btn.disabled  = false;
    btn.innerHTML = '<span id="login-btn-txt">تسجيل الدخول</span>';
    const m = String(e?.message || '');
    const isNetwork    = m === 'network';
    const isBadInvalid = m === 'invalid' || /credentials|invalid/i.test(m);
    const msg = isNetwork
      ? 'تعذّر الاتصال بالخادم، حاول مجدداً'
      : isBadInvalid
        ? 'المعرّف أو كلمة المرور غير صحيحة'
        : 'حدث خطأ، حاول مجدداً';
    showError(msg);
    // Shake animation. Restart by removing + reflow + adding.
    const card = $('.login-card');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }
}

function showError(msg) {
  const el = $('#error-msg');
  el.textContent = '❌ ' + msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

function togglePw() {
  const inp = $('#password');
  const eye = $('#pw-eye');
  if (inp.type === 'password') {
    inp.type = 'text';
    eye.textContent = '🙈';
  } else {
    inp.type = 'password';
    eye.textContent = '👁️';
  }
}
