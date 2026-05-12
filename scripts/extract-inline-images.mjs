// One-shot: find every `data:image/(png|jpeg);base64,...` URI in a list of
// source files, decode the base64 to disk under assets/img/, and rewrite the
// occurrence in place to reference the new file path.
//
// Dedupes by SHA-1 of the decoded bytes — the same image embedded multiple
// times across files collapses to a single asset.
//
// Usage:
//   node scripts/extract-inline-images.mjs index.html [more files...]
//
// Idempotent: running twice is a no-op (URIs are already gone after the
// first run).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const IMG_DIR = resolve(ROOT, 'assets/img');
mkdirSync(IMG_DIR, { recursive: true });

const RE = /data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)/g;

// Filename hints for known images — if a hash matches, use the hint instead
// of `img-<hash>.<ext>` so the resulting files are human-readable. Hints are
// computed on the fly from the first occurrence's surrounding context.
const seen = new Map();   // hash → { path, ext, refs }

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/extract-inline-images.mjs <file> [...]');
  process.exit(2);
}

let totalReplaced = 0;
let totalBytesIn  = 0;
let totalBytesOut = 0;

for (const rel of files) {
  const path = resolve(ROOT, rel);
  let src = readFileSync(path, 'utf8');
  const before = src.length;

  src = src.replace(RE, (match, mime, b64) => {
    const ext = mime === 'jpeg' ? 'jpg' : (mime === 'svg+xml' ? 'svg' : mime);
    const buf = Buffer.from(b64, 'base64');
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 10);

    let entry = seen.get(hash);
    if (!entry) {
      const name = `img-${hash}.${ext}`;
      const out  = resolve(IMG_DIR, name);
      writeFileSync(out, buf);
      entry = { name, ext, bytes: buf.length, refs: 0 };
      seen.set(hash, entry);
      totalBytesOut += buf.length;
    }
    entry.refs++;
    totalReplaced++;
    return `assets/img/${entry.name}`;
  });

  writeFileSync(path, src);
  const after = src.length;
  totalBytesIn += before - after;
  console.log(`  ${rel}: ${before.toLocaleString()} → ${after.toLocaleString()} bytes (-${(before - after).toLocaleString()})`);
}

console.log('');
console.log(`Extracted ${seen.size} unique images, ${totalReplaced} total references:`);
for (const [hash, e] of seen) {
  console.log(`  assets/img/${e.name}  ${e.bytes.toLocaleString()}b  ×${e.refs}`);
}
console.log('');
console.log(`HTML/JS source shrank by ${totalBytesIn.toLocaleString()} bytes total.`);
console.log(`assets/img/ grew by ${totalBytesOut.toLocaleString()} bytes (browser-cacheable).`);
