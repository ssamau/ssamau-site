// Project photo upload action.
//
// Lives in its own file so it can be reviewed independently of the
// member-file uploaders (Phase A, on feature/storage-cv-photo). After
// both phases merge, this file can be folded into actions/storage.ts
// in a small consolidation PR — until then, keeping it separate
// avoids a merge conflict between two parallel feature branches.
//
// `project-photos` is a PUBLIC bucket — homepage anonymous visitors
// fetch the URLs directly without a signing round-trip. The Edge
// Function returns the public URL on upload and stores it on
// projects.cover_photo_url so renderRecentEvents() can use it
// straight from the joined row.

import { sql } from '../_sql.ts';
import {
  httpErr, requireAuth, requireAdminScope,
  type Handler,
} from '../_helpers.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const PROJECT_BUCKET     = 'project-photos';
const PROJECT_SIZE_CAP   = 4 * 1024 * 1024;          // 4 MiB
const PROJECT_MIMES      = ['image/jpeg', 'image/png', 'image/webp'];

function svcClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw httpErr('Storage service not configured', 500);
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const uploadProjectPhoto: Handler = async (body, user) => {
  requireAuth(user);
  const data        = (body.data ?? body) as Record<string, unknown>;
  const project_id  = data.project_id as string | undefined;
  const filename    = data.filename as string | undefined;
  const contentType = data.contentType as string | undefined;
  const base64Data  = data.base64Data as string | undefined;
  if (!project_id || !filename || !contentType || !base64Data) {
    throw httpErr('project_id, filename, contentType, and base64Data are required', 400);
  }
  if (!PROJECT_MIMES.includes(contentType)) {
    throw httpErr(`Content-Type ${contentType} not allowed.`, 415);
  }

  // Committee-scope check — head can only upload to projects owned by
  // their own committee; admin/superadmin pass through.
  const [project] = await sql`SELECT owning_committee_id FROM projects WHERE project_id = ${project_id}` as Array<{ owning_committee_id: string | null }>;
  if (!project) throw httpErr('Project not found', 404);
  requireAdminScope(user, project.owning_committee_id);

  const bytes = b64ToBytes(base64Data);
  if (bytes.length > PROJECT_SIZE_CAP) {
    throw httpErr(`Photo exceeds ${PROJECT_SIZE_CAP} bytes`, 413);
  }

  const path = `${project_id}/${Date.now()}-${String(filename).replace(/[\/\\\s]/g, '_').slice(-80)}`;
  const sb = svcClient();
  const { error } = await sb.storage.from(PROJECT_BUCKET).upload(path, bytes, {
    contentType, upsert: false,
  });
  if (error) {
    console.error('[storage_project.upload]', error);
    throw httpErr(`Upload failed: ${error.message}`, 500);
  }

  // Public bucket → stable URL stored directly on the row.
  const { data: pub } = sb.storage.from(PROJECT_BUCKET).getPublicUrl(path);
  const url = pub?.publicUrl || '';
  await sql`UPDATE projects SET cover_photo_url = ${url}, updated_at = NOW() WHERE project_id = ${project_id}`;
  return { project_id, cover_photo_url: url };
};

export const projectStorageActions: Record<string, Handler> = {
  'storage.uploadProjectPhoto': uploadProjectPhoto,
};
