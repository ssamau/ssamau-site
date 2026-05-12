// Login page logic. Submits credentials to `auth`, stores the returned JWT
// + user object in sessionStorage, redirects to admin.html on success.
//
// Inline handlers in login.html (onclick="doLogin()" / onclick="togglePw()")
// have been replaced with addEventListener bindings here so a future strict
// CSP `script-src 'self'` works without exceptions.

import { apiOrThrow } from './lib/api.js';
import { saveSession, getLastUsername, isLoggedIn } from './lib/auth.js';
import { $ } from './lib/dom.js';

// Already logged in → bounce straight to admin. Runs on module load.
if (isLoggedIn()) {
  window.location.href = 'admin.html';
}

// Pre-fill the last successful username from localStorage. Pure UX —
// no secrets, just so people don't retype their name on every visit.
const userInput = $('#username');
const lastUser  = getLastUsername();
if (userInput && lastUser) userInput.value = lastUser;

// ── Wire handlers (replaces inline onclick="…") ─────────────────────
$('#login-btn')?.addEventListener('click', doLogin);
$('#pw-eye')   ?.addEventListener('click', togglePw);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

// ── Logic ───────────────────────────────────────────────────────────
async function doLogin() {
  const username = $('#username').value.trim().toLowerCase();
  const password = $('#password').value;

  if (!username || !password) {
    showError('يرجى إدخال اسم المستخدم وكلمة المرور');
    return;
  }

  const btn = $('#login-btn');
  btn.disabled  = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const r = await apiOrThrow('auth', { username, password });
    // The server returns { token, user } inside `data` — apiOrThrow flattens
    // that onto the result object so r.token and r.user are both present.
    if (!r.token || !r.user) throw new Error('bad response shape');
    saveSession(r.user, r.token);
    window.location.href = 'admin.html';
  } catch (e) {
    btn.disabled  = false;
    btn.innerHTML = '<span id="login-btn-txt">تسجيل الدخول</span>';
    const msg = e.message === 'network'
      ? 'تعذّر الاتصال بالخادم، حاول مجدداً'
      : 'اسم المستخدم أو كلمة المرور غير صحيحة';
    showError(msg);
    // Trigger shake animation. Restart it cleanly by removing + reflow + adding.
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
