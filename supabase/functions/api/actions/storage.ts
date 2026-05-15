// Member file upload + signed-URL fetch handlers.
//
// Two Storage buckets, both private (see post-beta-roadmap.md Phase A):
//   member-cvs    — application/pdf only,    5 MiB cap
//   member-photos — image/jpeg/png/webp,     3 MiB cap
//
// Every read/write goes through the api Edge Function (service role
// key, bypasses RLS). Direct anon/authenticated access is blocked by
// the migration 20260514120002_rls_lockdown defaults. On read we
// return a 1h signed URL scoped to a single object — short enough
// that a leaked URL is unusable in a day, long enough to survive a
// slow mobile connection on the member portal.
//
// Path scheme inside each bucket: <member_id>/<filename>
// e.g. member-cvs/MBR_ABCDE1/resume-2026.pdf
//      member-photos/MBR_ABCDE1/avatar.jpg
// Storing under member_id (not auth_user_id) keeps paths stable
// even if a member re-creates their auth row. The Edge Function
// resolves the member_id from the auth context — the caller never
// passes it directly, so they can't traverse out of their own
// folder.

import { sql } from '../_sql.ts';
import {
  httpErr, requireAuth, requireAdminScope,
  type Handler,
} from '../_helpers.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Bucket configs — kept in code so a typo in a bucket name throws at
// dispatch time (TypeScript) rather than at runtime (Storage 404).
const BUCKETS = {
  cv:    { id: 'member-cvs',    column: 'cv_url',            sizeCap: 5 * 1024 * 1024, mimes: ['application/pdf'] },
  photo: { id: 'member-photos', column: 'profile_photo_url', sizeCap: 3 * 1024 * 1024, mimes: ['image/jpeg', 'image/png', 'image/webp'] },
} as const;
type Kind = keyof typeof BUCKETS;

function svcClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw httpErr('Storage service not configured', 500);
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Decode a base64-encoded payload coming from the browser. We use base64
// (rather than raw FormData) because Supabase Edge Functions parse the
// JSON body once at index.ts; reading a multipart body afterwards
// would require re-architecting the dispatcher. base64 in a JSON
// field works for both file types under the size caps.
function b64ToBytes(b64: string): Uint8Array {
  // Strip a data URL prefix if the caller forgot to (defensive — the
  // member-portal uploader strips it, but admin-tab uploads might not).
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Sanitise a filename: strip path separators, normalise spaces,
// truncate to 80 chars. Suffix becomes the upload time so re-uploads
// don't clobber each other in the audit trail (Storage stores both
// versions; column points to the latest).
function safeFilename(raw: string, kind: Kind): string {
  const base = String(raw || '')
    .replace(/[\/\\]/g, '_')
    .replace(/\s+/g, '_')
    .slice(-80);
  const stamp = Date.now();
  return `${stamp}-${base || (kind === 'cv' ? 'cv.pdf' : 'photo.jpg')}`;
}

// Upload action — member uploads their own CV or photo. Replaces
// (well, supersedes — Storage keeps history) any existing file by
// repointing the members.<column> at the new path.
const uploadMemberFile: Handler = async (body, user) => {
  requireAuth(user);
  if (!user.member_id) throw httpErr('No member profile linked to this account.', 404);

  const data         = (body.data ?? body) as Record<string, unknown>;
  const kind         = data.kind as Kind | undefined;
  const filename     = data.filename as string | undefined;
  const contentType  = data.contentType as string | undefined;
  const base64Data   = data.base64Data as string | undefined;
  // Admin can upload on behalf of another member; defaults to own.
  const targetMember = (data.member_id as string) || user.member_id;

  if (!kind || !(kind in BUCKETS))       throw httpErr('Unknown kind. Must be "cv" or "photo".', 400);
  if (!filename || !contentType || !base64Data) {
    throw httpErr('filename, contentType, and base64Data are required', 400);
  }
  const cfg = BUCKETS[kind];
  if (!cfg.mimes.includes(contentType)) {
    throw httpErr(`Content-Type ${contentType} not allowed. Expected one of: ${cfg.mimes.join(', ')}`, 415);
  }

  // Self-only by default; admin/head can upload on behalf via the
  // optional `member_id` field, scope-checked against the target
  // member's committee.
  if (targetMember !== user.member_id) {
    const [target] = await sql`SELECT committee_id FROM members WHERE member_id = ${targetMember}` as Array<{ committee_id: string | null }>;
    if (!target) throw httpErr('Target member not found', 404);
    requireAdminScope(user, target.committee_id);
  }

  const bytes = b64ToBytes(base64Data);
  if (bytes.length > cfg.sizeCap) {
    throw httpErr(`File exceeds ${cfg.sizeCap} bytes`, 413);
  }

  const path = `${targetMember}/${safeFilename(filename, kind)}`;
  const sb = svcClient();
  const { error } = await sb.storage.from(cfg.id).upload(path, bytes, {
    contentType, upsert: false,
  });
  if (error) {
    console.error('[storage.upload]', error);
    throw httpErr(`Upload failed: ${error.message}`, 500);
  }

  // Repoint the row at the new path. We deliberately keep the OLD
  // storage object behind — Storage retains history; if a member
  // mis-uploads they can rollback by repointing manually. Cleanup
  // is a separate maintenance job.
  if (kind === 'cv') {
    await sql`UPDATE members SET cv_url = ${path}, updated_at = NOW() WHERE member_id = ${targetMember}`;
  } else {
    await sql`UPDATE members SET profile_photo_url = ${path}, updated_at = NOW() WHERE member_id = ${targetMember}`;
  }

  return { kind, path, size: bytes.length };
};

// Signed-URL fetch action — used by the frontend to render a member's
// CV link / avatar image. URL valid for 1h. Caller must be allowed
// to see the target: self always; admin/superadmin always; head if
// the target's committee_id matches theirs.
const getMemberFile: Handler = async (body, user) => {
  requireAuth(user);
  const data = (body.data ?? body) as Record<string, unknown>;
  const kind         = data.kind as Kind | undefined;
  const targetMember = (data.member_id as string) || user.member_id;

  if (!kind || !(kind in BUCKETS)) throw httpErr('Unknown kind', 400);
  if (!targetMember)               throw httpErr('member_id required', 400);

  // Permission check: self / admin / head (scoped).
  if (targetMember !== user.member_id) {
    const [target] = await sql`SELECT committee_id FROM members WHERE member_id = ${targetMember}` as Array<{ committee_id: string | null }>;
    if (!target) throw httpErr('Target member not found', 404);
    requireAdminScope(user, target.committee_id);
  }

  const cfg = BUCKETS[kind];
  const [row] = await sql`
    SELECT ${kind === 'cv' ? sql`cv_url` : sql`profile_photo_url`} AS path
    FROM members WHERE member_id = ${targetMember}
  ` as Array<{ path: string | null }>;
  if (!row || !row.path) return { url: null };

  const sb = svcClient();
  const { data: signed, error } = await sb.storage.from(cfg.id).createSignedUrl(row.path, 3600);
  if (error) {
    console.error('[storage.signedUrl]', error);
    throw httpErr(`Could not generate signed URL: ${error.message}`, 500);
  }
  return { url: signed.signedUrl, expires_in: 3600 };
};

// Delete action — clears the column AND removes the underlying object.
// Used by the member portal "remove file" button and admin tools.
const deleteMemberFile: Handler = async (body, user) => {
  requireAuth(user);
  const data         = (body.data ?? body) as Record<string, unknown>;
  const kind         = data.kind as Kind | undefined;
  const targetMember = (data.member_id as string) || user.member_id;
  if (!kind || !(kind in BUCKETS)) throw httpErr('Unknown kind', 400);
  if (!targetMember)               throw httpErr('member_id required', 400);

  if (targetMember !== user.member_id) {
    const [target] = await sql`SELECT committee_id FROM members WHERE member_id = ${targetMember}` as Array<{ committee_id: string | null }>;
    if (!target) throw httpErr('Target member not found', 404);
    requireAdminScope(user, target.committee_id);
  }

  const cfg = BUCKETS[kind];
  const [row] = await sql`
    SELECT ${kind === 'cv' ? sql`cv_url` : sql`profile_photo_url`} AS path
    FROM members WHERE member_id = ${targetMember}
  ` as Array<{ path: string | null }>;
  if (!row || !row.path) return { ok: true, deleted: false };

  const sb = svcClient();
  // Best-effort remove — even if Storage can't find the object, clear
  // the column so the UI stops trying to load it.
  await sb.storage.from(cfg.id).remove([row.path]);
  if (kind === 'cv') {
    await sql`UPDATE members SET cv_url = NULL, updated_at = NOW() WHERE member_id = ${targetMember}`;
  } else {
    await sql`UPDATE members SET profile_photo_url = NULL, updated_at = NOW() WHERE member_id = ${targetMember}`;
  }
  return { ok: true, deleted: true };
};

export const storageActions: Record<string, Handler> = {
  'storage.uploadMemberFile': uploadMemberFile,
  'storage.getMemberFile':    getMemberFile,
  'storage.deleteMemberFile': deleteMemberFile,
};
