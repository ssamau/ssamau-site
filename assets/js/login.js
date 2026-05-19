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

import { applyStoredTheme } from './lib/theme.js';
applyStoredTheme();

// i18n side-effects on import: sets <html dir/lang> + applies the
// data-i18n attributes against the saved/detected language. Exported
// helpers below are used by the language-toggle buttons.
import { t, getLang, setLang, onLangChange } from './lib/i18n.js';

import { callApi, apiOrThrow } from './lib/api.js';
import {
  saveSession, clearSession,
  supabaseSignIn, bridgeSupabaseSession,
  getLastUsername, isLoggedIn,
  getSession, landingPageForAccess, signOut,
} from './lib/auth.js';
import { $ } from './lib/dom.js';

// Already logged in → straight to their portal. Runs on module load.
// Routing splits by access_level: superadmin/head → admin.html;
// member/volunteer → member.html. See landingPageForAccess in auth.js.
if (isLoggedIn()) {
  const session = getSession();
  window.location.href = landingPageForAccess(session?.access);
}

// Pre-fill the last successful identifier. Could be email/NID/username,
// whatever they used last time. Pure UX, no secrets.
const idInput  = $('#identifier');
const lastUser = getLastUsername();
if (idInput && lastUser) idInput.value = lastUser;

// Surface the "you've been marked inactive" message when the permission
// watcher (lib/permission-watcher.js) bounced the user here mid-session.
// We can't show the error before showError() is defined further down, so
// wrap in a microtask — runs after the rest of the module finishes parsing.
if (new URLSearchParams(window.location.search).get('inactive') === '1') {
  queueMicrotask(() => showError(t('err.access.member_inactive')));
}

// ── Language toggle wiring ──────────────────────────────────────────
// The two .lang-btn pills carry `data-action="setLang"` + a value.
// Sync the active-class indicator + flip language on click. The
// applyI18n() side of the work runs inside setLang() in lib/i18n.js.
function _syncLangButtons() {
  const cur = getLang();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === cur);
  });
}
document.querySelectorAll('[data-action="setLang"]').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.dataset.value));
});
onLangChange(_syncLangButtons);
_syncLangButtons();

// ── Wire handlers ───────────────────────────────────────────────────
$('#login-btn')?.addEventListener('click', doLogin);
$('#pw-eye')   ?.addEventListener('click', togglePw);
$('#forgot-link')      ?.addEventListener('click', showResetPane);
$('#forgot-link')      ?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') showResetPane(e); });
$('#reset-back-link')  ?.addEventListener('click', showLoginPane);
$('#reset-back-link')  ?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') showLoginPane(e); });
$('#reset-btn')        ?.addEventListener('click', doRequestReset);
// Enter-to-submit: which form depends on which pane is showing.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const mode = $('#lc-body')?.dataset.mode;
  if (mode === 'reset') doRequestReset();
  else                  doLogin();
});

// ── Logic ───────────────────────────────────────────────────────────
async function doLogin() {
  // Don't lowercase — the identifier might be a national_id (digits)
  // or an email (case-insensitive on server) or a username (server
  // already does LOWER() comparison). Preserve as typed.
  const identifier = $('#identifier').value.trim();
  const password   = $('#password').value;

  if (!identifier || !password) {
    showError(t('common.please_fill'));
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

    // ── Step 2A: Supabase path (H2-aware) ─────────────────────────
    // 1. Verify password via Supabase Auth → access_token (in memory only).
    // 2. Hand the token to our Edge Function's exchangeSupabaseToken
    //    action → server verifies, mints HS256, sets HttpOnly cookie,
    //    returns user metadata.
    // 3. Cache metadata locally for SPA shell rendering. The Supabase
    //    access_token never touches localStorage; it lives only on the
    //    stack of this function and is GC'd when login redirects.
    if (resolveResult.auth_provider === 'supabase') {
      const session = await supabaseSignIn(resolveResult.email, password);
      if (!session?.access_token) throw new Error('invalid');

      let user;
      try {
        user = await bridgeSupabaseSession(session.access_token);
      } catch (bridgeErr) {
        // Bridge can refuse for inactive members or any other policy
        // reason. Make sure nothing of the failed session lingers
        // locally, then re-throw so the outer catch shows the toast.
        clearSession();
        throw bridgeErr;
      }
      saveSession(user);
      window.location.href = landingPageForAccess(user.access);
      return;
    }

    // ── Step 2B: legacy path ──────────────────────────────────────
    // The `auth` action's response still includes `token` for one
    // rollout window (so pre-H2 clients keep working), but we ignore
    // it here — the HttpOnly cookie set on the response IS the
    // session going forward.
    if (resolveResult.auth_provider === 'legacy') {
      const r = await apiOrThrow('auth', {
        username: resolveResult.username,
        password,
      });
      if (!r.user) throw new Error('bad response shape');
      saveSession(r.user);
      window.location.href = landingPageForAccess(r.user.access);
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
    // Anything else came from apiOrThrow with a pre-localized message
    // (e.g. the Inactive gate's "حسابك غير نشط حالياً..." or future
    // server-side codes). Surface it verbatim instead of falling through
    // to the generic catch-all — the user needs the specific reason.
    const msg = isNetwork
      ? t('common.network_error')
      : isBadInvalid
        ? t('login.error_invalid').replace(/^❌\s*/, '')  // showError adds the ❌ prefix
        : (m || t('common.generic_error'));
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

// ── Forgot-password flow ────────────────────────────────────────────
// Pane toggle directly manipulates inline `display` styles on both
// panes. The CSS-only `data-mode` cascade is kept as a backup (still
// works), but inline styles win regardless of whether the stylesheet
// loaded — important because login.html is the user's first touchpoint
// and a missing CSS file used to leave both forms visible at once.
function _setPaneDisplay(login, reset) {
  const loginEl = document.querySelector('.login-pane');
  const resetEl = document.querySelector('.reset-pane');
  if (loginEl) loginEl.style.display = login;
  if (resetEl) resetEl.style.display = reset;
}

function showResetPane(e) {
  e?.preventDefault?.();
  $('#lc-body').dataset.mode = 'reset';
  _setPaneDisplay('none', '');
  const idVal = $('#identifier')?.value?.trim();
  if (idVal && !$('#reset-identifier').value) $('#reset-identifier').value = idVal;
  $('#reset-error')?.classList.remove('show');
  $('#reset-success')?.classList.remove('show');
  $('#reset-identifier')?.focus();
}

function showLoginPane(e) {
  e?.preventDefault?.();
  delete $('#lc-body').dataset.mode;
  _setPaneDisplay('', 'none');
}

async function doRequestReset() {
  const identifier = $('#reset-identifier').value.trim();
  if (!identifier) {
    showResetError('يرجى إدخال البريد أو الهوية الوطنية');
    return;
  }

  const btn = $('#reset-btn');
  btn.disabled  = true;
  btn.innerHTML = '<div class="spinner"></div>';
  $('#reset-error')?.classList.remove('show');
  $('#reset-success')?.classList.remove('show');

  try {
    // The action always returns { sent: true } — anti-enumeration.
    // We don't surface the email address back to the user either:
    // the success message just promises "if there's a match, you'll
    // get an email", same as every well-behaved reset endpoint.
    await callApi('auth.requestPasswordReset', {
      identifier,
      redirectTo: window.location.origin + '/reset-password.html',
    });
    showResetSuccess(
      'إذا كان هناك حساب مرتبط بهذا المعرّف، فستصلك رسالة بالرابط خلال دقائق. تحقق من بريدك (وصندوق الـ Spam).'
    );
    // Disable resubmit for a beat so the user doesn't spam.
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = '<span id="reset-btn-txt">إرسال رابط الاستعادة</span>';
    }, 4000);
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<span id="reset-btn-txt">إرسال رابط الاستعادة</span>';
    showResetError('تعذّر الاتصال بالخادم، حاول مجدداً');
  }
}

function showResetError(msg) {
  const el = $('#reset-error');
  el.textContent = '❌ ' + msg;
  el.classList.add('show');
}

function showResetSuccess(msg) {
  const el = $('#reset-success');
  el.textContent = '✅ ' + msg;
  el.classList.add('show');
}
