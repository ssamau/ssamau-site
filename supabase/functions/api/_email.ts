// SMTP email sender for the Edge Function.
//
// Used for transactional notifications that aren't part of Supabase
// Auth's built-in email surface (signup/recovery/magic-link — those
// flow through Auth's own SMTP config). This module exists so we can
// send our OWN custom emails from action handlers — e.g. notifying
// info@ssamau.com when a new membership application lands.
//
// Connection: Deno's `denomailer` library handles the STARTTLS upgrade
// + auth handshake. We point at Google Workspace SMTP
// (smtp.gmail.com:465) using the same info@ssamau.com app password
// that Supabase Auth uses — but the credentials are stored separately
// as `SMTP_*` Edge Function secrets so this module doesn't need
// privileged Auth-config access.
//
// Required secrets (set via `supabase secrets set`):
//   SMTP_HOST      e.g. smtp.gmail.com
//   SMTP_PORT      e.g. 465
//   SMTP_USER      e.g. info@ssamau.com
//   SMTP_PASS      Google Workspace app password (16 chars, no spaces)
//   SMTP_FROM      Display name + email, e.g. "SSAM <info@ssamau.com>"
//
// If any are missing, sendEmail() logs a warning and returns null
// instead of throwing — so a missing SMTP config doesn't take down
// the application-submit flow that just succeeded.
//
// ── Subject-encoding workaround (denomailer 1.6.0 bug) ──────────────
// denomailer's `quotedPrintableEncodeInline` (config/mail/encoding.ts)
// encodes non-ASCII subjects by running the BODY-style QP encoder and
// wrapping the result in `=?utf-8?Q?…?=`. Two RFC violations follow:
//   1. Body QP soft-wraps at 74 cols by inserting `=\r\n`. Inside an
//      RFC 822 header, continuation lines MUST start with whitespace.
//      The `=` at the start of line 2 makes the line look like a new
//      (malformed) header, and strict parsers abandon header parsing
//      from that point on — so From/To/Date/MIME-Version/Content-Type
//      are all reclassified as body. Gmail then renders the entire
//      raw MIME structure as plain text. This was the real cause of
//      "the styling doesn't show up": Gmail never reached the HTML
//      part because it never realised the message had a HTML part.
//   2. Body QP keeps spaces literal. RFC 2047 §4.2 disallows literal
//      space inside an encoded-word — it must be `_` or `=20`.
//
// We can't pre-encode the subject and pass it through, because
// denomailer re-encodes anything starting with `=?` (see the second
// arm of the `if` in quotedPrintableEncodeInline). The clean escape
// is denomailer's `preprocessors` hook, which runs AFTER its broken
// encoder but BEFORE the SMTP write. We pass an ASCII placeholder
// (left untouched by the broken encoder), then the preprocessor
// swaps in our properly RFC 2047 + RFC 5322 encoded subject.

import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') ?? '587');
const SMTP_USER = Deno.env.get('SMTP_USER') ?? '';
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? '';
const SMTP_FROM = Deno.env.get('SMTP_FROM') ?? '';

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;     // plain-text fallback; auto-derived from html if absent
  // Optional BCC list — used by opportunities.notify when blasting an
  // announcement to ad-hoc emails. Recipients in `bcc` don't see each
  // other's addresses; `to` is required as the visible recipient
  // (we pass SMTP_USER as a placeholder so the message is technically
  // addressed to the sender's own inbox + delivered to everyone in BCC).
  bcc?: string[];
}

// Unique ASCII sentinel — kept ASCII so denomailer's broken encoder
// leaves it alone (hasNonAsciiCharacters=false + doesn't start with
// `=?`), but distinctive enough that our preprocessor can spot it
// unambiguously even if some other field happens to contain it.
const SUBJECT_PLACEHOLDER = 'SSAM_PLACEHOLDER_SUBJECT_DO_NOT_USE_AS_REAL_SUBJECT';

export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !SMTP_FROM) {
    console.warn('[email] SMTP secrets not configured — skipping send', {
      to: opts.to, subject: opts.subject,
    });
    return false;
  }

  // tls:true when port is 465 (implicit TLS — Gmail's SMTPS endpoint)
  // tls:false when port is 587 (STARTTLS — upgraded from plaintext).
  // denomailer auto-handles the protocol per the flag, but we infer
  // from the port to avoid relying on an extra env var.
  const useTls = SMTP_PORT === 465;

  // Encode the real subject ONCE per send. The preprocessor closure
  // captures it so denomailer's pipeline can substitute it in.
  const properSubject = rfc2047EncodeSubject(opts.subject);

  const client = new SMTPClient({
    connection: {
      hostname: SMTP_HOST,
      port:     SMTP_PORT,
      tls:      useTls,
      auth: { username: SMTP_USER, password: SMTP_PASS },
    },
    client: {
      preprocessors: [
        (mail) => {
          // denomailer left the ASCII placeholder unchanged (its
          // encoder only kicks in for non-ASCII or `=?`-prefixed
          // input). We swap in the properly encoded subject before
          // the SMTP writer reads `mail.subject`.
          if (mail.subject.includes(SUBJECT_PLACEHOLDER)) {
            mail.subject = properSubject;
          }
          return mail;
        },
      ],
    },
  });

  // Strip trailing whitespace from every line of both the HTML and the
  // plain-text body. This dodges a SECOND denomailer 1.6.0 QP bug:
  // its `quotedPrintableEncode` pre-replaces ` \r\n` → `=20\r\n` to
  // preserve trailing spaces per the QP spec, then runs the per-char
  // encoder which sees the `=` it just inserted and re-encodes it as
  // `=3D`, producing `=3D20\r\n` on the wire. The receiver decodes
  // `=3D` to `=` and then reads `20` as literal text, so the email
  // renders with visible "=20" strings wherever a line had trailing
  // whitespace. Our template literals indent for readability, so
  // every blank-line-between-sections turns into a stray `=20` line
  // in Gmail. Easiest fix: trim per-line trailing whitespace before
  // handing the body to denomailer.
  const cleanHtml = opts.html.replace(/[ \t]+(\r?\n)/g, '$1');
  const cleanText = (opts.text ?? stripHtml(opts.html)).replace(/[ \t]+(\r?\n)/g, '$1');

  try {
    const message: Record<string, unknown> = {
      from:    SMTP_FROM,
      to:      Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: SUBJECT_PLACEHOLDER,
      content: cleanText,
      html:    cleanHtml,
    };
    if (opts.bcc && opts.bcc.length) {
      message.bcc = opts.bcc;
    }
    await client.send(message);
    console.log(`[email] sent ok: subject="${opts.subject}" to=${Array.isArray(opts.to) ? opts.to.join(',') : opts.to}${opts.bcc?.length ? ` bcc=${opts.bcc.length}` : ''}`);
    return true;
  } catch (err) {
    // Log but don't throw — callers (like applications.submit) should
    // never have their primary work fail just because an email blip
    // happened. The app's database row still landed; the admin can
    // see it in the dashboard regardless.
    console.error('[email] send failed:', err);
    return false;
  } finally {
    await client.close();
  }
}

// RFC 2047 Q-encoding for header values containing non-ASCII text,
// with RFC 5322 header folding for values that don't fit in one
// encoded-word. Each encoded-word fits in ≤75 chars total including
// the `=?utf-8?Q?…?=` wrapper (12 chars), so we cap encoded-text at
// 60 chars per word to leave safety margin.
//
// Rules (RFC 2047 §4.2):
//   * space (0x20) → "_"
//   * "=", "?", "_"  → "=XX" (must be escaped because they're meta)
//   * 0x00–0x20 and 0x7F+ (incl. all UTF-8 bytes of multi-byte chars)
//     → "=XX"
//   * anything else (printable ASCII) → literal byte
//
// Multi-byte UTF-8 sequences are ATOMIC — a single source code point
// must not be split across two encoded-words, or the decoder fails.
// We iterate via `for...of` which yields one full code point at a time.
//
// Adjacent encoded-words separated by whitespace are concatenated by
// the decoder WITHOUT inter-word whitespace (RFC 2047 §6.2 — "any
// linear-white-space that separates a pair of adjacent encoded-words
// is ignored"). So our `\r\n ` fold doesn't inject phantom spaces
// inside Arabic words.
function rfc2047EncodeSubject(s: string): string {
  // ASCII-only with no `=?` prefix → pass through. RFC 2047 encoding
  // is only required for non-ASCII or content that could be mistaken
  // for an existing encoded-word.
  if (!/[^\x00-\x7E]/.test(s) && !s.startsWith('=?')) return s;

  const encoder = new TextEncoder();
  const MAX_TEXT_LEN = 60;

  const words: string[] = [];
  let current = '';
  for (const ch of s) {  // iterates by code point (handles surrogate pairs)
    const bytes = encoder.encode(ch);
    let chunk = '';
    for (const b of bytes) {
      if (b === 0x20) {
        chunk += '_';
      } else if (b === 0x3D || b === 0x3F || b === 0x5F || b < 0x21 || b > 0x7E) {
        chunk += '=' + b.toString(16).toUpperCase().padStart(2, '0');
      } else {
        chunk += String.fromCharCode(b);
      }
    }
    // If appending this character would push the current word past the
    // safe limit, flush it and start a new one. Because `chunk` is
    // computed from a single source code point, this never splits a
    // multi-byte UTF-8 sequence.
    if (current.length + chunk.length > MAX_TEXT_LEN) {
      words.push(`=?utf-8?Q?${current}?=`);
      current = chunk;
    } else {
      current += chunk;
    }
  }
  if (current) words.push(`=?utf-8?Q?${current}?=`);

  // RFC 5322 header folding: a CRLF followed by WSP marks a folded
  // continuation. denomailer's `writeCmd("Subject: ", subj)` will
  // therefore emit:
  //   Subject:  =?utf-8?Q?…?=\r\n
  //    =?utf-8?Q?…?=\r\n
  // — which Gmail/Apple Mail/Outlook all parse correctly as a single
  // Subject value composed of multiple decoded encoded-words.
  return words.join('\r\n ');
}

// Crude HTML → text fallback. Good enough for plaintext readers that
// don't render HTML; they get a stripped version of the body. Full
// markdown-style rendering would be overkill — the HTML body has the
// real content and 99% of clients render it.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
