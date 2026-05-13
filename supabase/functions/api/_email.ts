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
// (smtp.gmail.com:587) using the same info@ssamau.com app password
// that Supabase Auth uses — but the credentials are stored separately
// as `SMTP_*` Edge Function secrets so this module doesn't need
// privileged Auth-config access.
//
// Required secrets (set via `supabase secrets set`):
//   SMTP_HOST      e.g. smtp.gmail.com
//   SMTP_PORT      e.g. 587
//   SMTP_USER      e.g. info@ssamau.com
//   SMTP_PASS      Google Workspace app password (16 chars, no spaces)
//   SMTP_FROM      Display name + email, e.g. "SSAM <info@ssamau.com>"
//
// If any are missing, sendEmail() logs a warning and returns null
// instead of throwing — so a missing SMTP config doesn't take down
// the application-submit flow that just succeeded.

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
}

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
  const client = new SMTPClient({
    connection: {
      hostname: SMTP_HOST,
      port:     SMTP_PORT,
      tls:      useTls,
      auth: { username: SMTP_USER, password: SMTP_PASS },
    },
  });

  try {
    await client.send({
      from:    SMTP_FROM,
      to:      Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      content: opts.text ?? stripHtml(opts.html),
      html:    opts.html,
    });
    console.log(`[email] sent ok: subject="${opts.subject}" to=${Array.isArray(opts.to) ? opts.to.join(',') : opts.to}`);
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
