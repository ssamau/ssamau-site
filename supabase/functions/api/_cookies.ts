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
// Same-origin notes (2026-05-20):
//   Frontend POSTs to https://ssamau.com/api; Netlify proxies the
//   request to the Edge Function (see netlify.toml). The browser sees
//   a same-origin response, so the cookie is first-party on
//   .ssamau.com. That lets us use SameSite=Lax — iOS Safari ITP only
//   targets SameSite=None third-party cookies, which is what broke
//   logins for some users in the cross-origin setup we ran before.
//
//   For non-proxied entry points (preview deploys outside the rewrite
//   path, or future iOS/Android clients calling Supabase directly), the
//   Authorization-header fallback in resolveUserContext still works —
//   the cookie isn't the only path.

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
    `; SameSite=Lax` +
    `; Path=/` +
    `; Max-Age=${MAX_AGE_SECONDS}`;
}

/** Build a Set-Cookie value that clears the session (logout). */
export function buildClearCookie(): string {
  return `${COOKIE_NAME}=` +
    `; HttpOnly` +
    `; Secure` +
    `; SameSite=Lax` +
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
