// JWT helpers + role guards.

import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  // Deliberately throw at import time so a missing secret is loud, not a silent vulnerability.
  throw new Error('JWT_SECRET env var is required.');
}

const TTL = '7d';

export function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      access: user.access_level,
      member_id: user.member_id,
      committee_id: user.committee_id || null,
    },
    SECRET,
    { expiresIn: TTL },
  );
}

export function verifyToken(authHeader) {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    return jwt.verify(m[1], SECRET);
  } catch {
    return null;
  }
}

// Public actions — no auth required.
export const PUBLIC_ACTIONS = new Set([
  'auth',
  'getMembers', 'getCommittees', 'getAdvisors', 'getProjects',
  'certs.verify',
  'setup.bulkSeed',  // gated server-side: refuses if users already exist
]);

// Actions that require superadmin (presidency-only).
export const SUPERADMIN_ACTIONS = new Set([
  'createProject', 'deleteProject',
  'createAdvisor', 'updateAdvisor', 'deleteAdvisor',
  'createCommittee', 'updateCommittee', 'deleteCommittee',
  'deleteMember',
  'setup.seedMembers',
]);

export function requireAuth(user) {
  if (!user) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
}

export function requireSuperadmin(user) {
  requireAuth(user);
  if (user.access !== 'superadmin') {
    const err = new Error('Forbidden — superadmin only');
    err.status = 403;
    throw err;
  }
}

// `head` is allowed to write within their own committee; `superadmin` everywhere.
export function requireAdminScope(user, committeeId) {
  requireAuth(user);
  if (user.access === 'superadmin') return;
  if (user.access === 'head') {
    if (!committeeId || user.committee_id === committeeId) return;
    const err = new Error('Forbidden — committee head can only modify their own committee');
    err.status = 403;
    throw err;
  }
  const err = new Error('Forbidden');
  err.status = 403;
  throw err;
}
