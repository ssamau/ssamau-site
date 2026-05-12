// Session/token storage helpers.
//
// Currently uses sessionStorage so credentials don't survive a browser
// restart — fine for a desktop admin tool but will be moved to localStorage in
// the spa-and-pwa branch, because sessionStorage gets wiped when a mobile
// webview process is killed (which happens often) and we don't want members to
// log in every time they open the future native app.
//
// `ssam_last_user` lives in localStorage and is intentionally separate — it
// just pre-fills the username field across sessions, no secrets.

const SESSION_KEY = 'ssam_session';
const TOKEN_KEY   = 'ssam_token';
const LAST_USER   = 'ssam_last_user';

export function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function saveSession(user, token) {
  const session = {
    id:           user.id,
    name:         user.name,
    username:     user.username,
    role:         user.role,
    access:       user.access,
    member_id:    user.member_id,
    committee_id: user.committee_id,
    token,
    loginAt:      new Date().toISOString(),
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  sessionStorage.setItem(TOKEN_KEY, token);
  if (user.username) localStorage.setItem(LAST_USER, user.username);
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

export function getLastUsername() {
  return localStorage.getItem(LAST_USER) || '';
}

// True if a token is present in storage. Doesn't validate it — the server
// returns 401 if it's expired and the api client clears + redirects.
export function isLoggedIn() {
  return !!getToken();
}
