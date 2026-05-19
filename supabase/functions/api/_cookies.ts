// Session cookie helpers — security audit finding H2 (2026-05-19).
//
// Before: the frontend stored auth JWTs in localStorage and sent them
// in `Authorization: Bearer`. XSS-amplification risk — a single missed
// `esc()` call anywhere on a future PR could exfiltrate every admin's
// session.
//
// After: the Edge Function mints an HS256 JWT on successful login and
// sets it as an HttpOnly cookie. JavaScript can't read it (HttpOnly)
// and it's only transmitted over HTTPS (Secure). The browser attaches
// it automatically to every same-origin (or correctly-allowed cross-
// origin) fetch.
//
// Cross-origin notes:
//   Frontend = https://ssamau.com (Netlify)
//   Backend  = https://pfibxvwiulwiiuwerawe.supabase.co (Supabase)
//   These are different ETLD+1s, so the cookie MUST be SameSite=None
//   to travel between them. SameSite=None requires Secure. The
//   complement on the frontend side: every fetch needs
//   `credentials: 'include'` and the server's CORS response must
//   set `Access-Control-Allow-Credentials: true` + a specific
//   `Access-Control-Allow-Origin` (not `*`). The H3 fix already
//   locked the origin to an allowlist.

const COOKIE_NAME = 'ssam_session';

// 30 days — long enough that admins don't re-log mid-week, short enough
// that a stolen device session can't be revived months later. Refresh
// happens by the user simply re-logging in.
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Build a Set-Cookie value carrying the session JWT. */
export function buildSessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}` +
    `; HttpOnly` +
    `; Secure` +
    `; SameSite=None` +
    `; Path=/` +
    `; Max-Age=${MAX_AGE_SECONDS}`;
}

/** Build a Set-Cookie value that clears the session (logout). */
export function buildClearCookie(): string {
  return `${COOKIE_NAME}=` +
    `; HttpOnly` +
    `; Secure` +
    `; SameSite=None` +
    `; Path=/` +
    `; Max-Age=0`;
}

/** Extract the session JWT from the request's Cookie header. */
export function getSessionTokenFromCookie(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const raw of cookieHeader.split(/;\s*/)) {
    if (raw.startsWith(`${COOKIE_NAME}=`)) {
      const value = raw.slice(COOKIE_NAME.length + 1);
      return value || null;
    }
  }
  return null;
}
