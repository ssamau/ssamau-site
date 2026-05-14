// member.html logic — Phase 4 of Branch 4 (placeholder portal).
//
// Three responsibilities, all tiny:
//   1. Wrong-portal guard. If no session → /login.html. If session is
//      admin-tier (superadmin/head) → /admin.html. Only member /
//      volunteer-tier sessions are allowed to stay on this page.
//   2. Greeting. Pull the user's name from the session and personalise
//      the welcome.
//   3. Logout wiring. The button calls signOut() from lib/auth.js
//      which clears the localStorage session and redirects to /login.html.
//
// Once Phase 5 lands and this page grows into a real portal with
// tabs + data fetches, the guard logic stays the same — wrong-tier
// users still get bounced. Everything else gets layered on top.

import { applyStoredTheme } from './lib/theme.js';
applyStoredTheme();

import {
  isLoggedIn, getSession, signOut, landingPageForAccess,
} from './lib/auth.js';
import { callApi } from './lib/api.js';
import { $ } from './lib/dom.js';

// ── Guards (run synchronously before paint to avoid a flash of the
//    placeholder content for someone who's about to be redirected) ──
if (!isLoggedIn()) {
  window.location.href = 'login.html';
}

const session = getSession();
const access  = session?.access || '';

if (access !== 'member' && access !== 'volunteer') {
  // Admin-tier (superadmin/head) ended up here somehow — manual URL
  // typing, stale bookmark, etc. Send them to their actual portal.
  // landingPageForAccess returns 'admin.html' for any non-member
  // access value, so we route by re-using the same helper login.js
  // uses for new sign-ins. If access happens to be empty (corrupt
  // session) we default to admin.html and let admin's own RBAC do
  // the right thing.
  window.location.href = landingPageForAccess(access);
}

// ── Personalise the greeting once we know it's a legit member ──────
const greetingEl = $('#greeting');
if (greetingEl && session?.name) {
  greetingEl.textContent = `أهلًا ${session.name} 👋`;
}

// ── Contact section ────────────────────────────────────────────────
// QoL added with the role-system refactor (2026-05-15) so a member who
// just activated their account and needs to reach someone has a
// directory rendered right on the landing page. Two groups shown:
//   1. Presidency (President + VPs + DVPs) — visible to every member /
//      volunteer regardless of committee affiliation.
//   2. Own committee head + vice — only shown to members who are
//      committee-affiliated (members.committee_id IS NOT NULL).
//      Volunteers don't see committee-specific contacts since they
//      aren't tied to one.
//
// Uses getMembers (public action — anyone can call, no JWT needed)
// then filters client-side. Email-only display for privacy; phone /
// WhatsApp stay private. Renders into #contact-cards under the
// #contact-block (initially display:none until populated to avoid a
// flash of an empty heading on slow connections).
const LEADERSHIP_ROLES = new Set([
  'President', 'Vice President', 'Deputy Vice President',
]);
const HEAD_ROLES = new Set([
  'Committee Head', 'Committee Vice Head',
]);
const ROLE_LABEL_AR = {
  'President':              'الرئيس',
  'Vice President':         'نائب الرئيس',
  'Deputy Vice President':  'مساعد نائب الرئيس',
  'Committee Head':         'رئيس اللجنة',
  'Committee Vice Head':    'نائب رئيس اللجنة',
};

async function loadContactSection() {
  const res = await callApi('getMembers');
  if (!res || !res.success) return;          // fail-soft: silently skip
  const members = res.data || [];

  // Presidency — always shown.
  const presidency = members.filter(m => LEADERSHIP_ROLES.has(m.club_role));
  // Own committee head + vice — only if the current user belongs to a committee.
  const myCom    = session?.committee_id || null;
  const myHeads  = myCom
    ? members.filter(m => m.committee_id === myCom && HEAD_ROLES.has(m.club_role))
    : [];

  const cards = [...presidency, ...myHeads];
  if (!cards.length) return;                 // shouldn't happen but defensive

  const wrap = $('#contact-cards');
  const block = $('#contact-block');
  if (!wrap || !block) return;

  // Render each contact as a small card: name (Arabic + English subtitle),
  // role label, phone numbers (Australian + Saudi).
  //
  // Data shape per the live `members` table:
  //   phone     → Australian number (+61…) — used for calls
  //   whatsapp  → Saudi number      (+966…) — used for WhatsApp chat
  // Linking:
  //   tel:<num>          opens the dialer on mobile, gracefully no-ops
  //                      on desktop browsers that don't handle tel:
  //   https://wa.me/<digits>
  //                      opens WhatsApp web/app to start a chat. The
  //                      number in the URL must be digits-only (no +,
  //                      no spaces) so we strip non-digit characters.
  //
  // Rows that have neither phone nor whatsapp render a muted "no
  // number on file" message — better to surface that than silently
  // hide the contact (admin can then notice + fix the missing data).
  wrap.innerHTML = cards.map(m => {
    const role = ROLE_LABEL_AR[m.club_role] || m.club_role || '';
    const name = m.preferred_name || m.full_name || '—';
    const sub  = m.full_name && m.preferred_name && m.preferred_name !== m.full_name
      ? `<div style="font-size:.68rem;color:var(--tm,#9ca3af)">${escapeHtml(m.full_name)}</div>`
      : '';

    // Build the contact links. Both LTR-direction since the digits are
    // Latin and read left-to-right; otherwise the +966 prefix can flip
    // when adjacent to the RTL emoji icon.
    const links = [];
    if (m.phone) {
      links.push(
        `<a href="tel:${escapeHtml(m.phone)}" style="font-size:.74rem;color:var(--g,#1A5C2E);text-decoration:none;font-weight:700;direction:ltr;display:flex;align-items:center;gap:.3rem">
          <span>📱</span><span>${escapeHtml(m.phone)}</span>
        </a>`
      );
    }
    if (m.whatsapp) {
      const waDigits = String(m.whatsapp).replace(/[^\d]/g, '');
      links.push(
        `<a href="https://wa.me/${escapeHtml(waDigits)}" target="_blank" rel="noopener" style="font-size:.74rem;color:var(--g,#1A5C2E);text-decoration:none;font-weight:700;direction:ltr;display:flex;align-items:center;gap:.3rem">
          <span>💬</span><span>${escapeHtml(m.whatsapp)}</span>
        </a>`
      );
    }
    const contactBlock = links.length
      ? `<div style="display:flex;flex-direction:column;gap:.35rem">${links.join('')}</div>`
      : '<span style="font-size:.7rem;color:var(--tm,#9ca3af)">— لا يوجد رقم تواصل —</span>';

    return `
      <div style="background:var(--bg,#fff);border:1px solid var(--bd,#e5e7eb);border-radius:10px;padding:.75rem .85rem">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem;margin-bottom:.4rem">
          <div>
            <div style="font-size:.86rem;font-weight:700">${escapeHtml(name)}</div>
            ${sub}
          </div>
          <span style="font-size:.65rem;background:var(--gl,#e8f5e9);color:var(--g,#1A5C2E);padding:.15rem .45rem;border-radius:50px;font-weight:700;white-space:nowrap">${escapeHtml(role)}</span>
        </div>
        ${contactBlock}
      </div>`;
  }).join('');
  block.style.display = '';
}

// Cheap local HTML-escape (same pattern as index.js). Inlined so this
// module doesn't pull in lib/format.js for one helper.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

loadContactSection();

// ── Logout button ──────────────────────────────────────────────────
// signOut() handles both auth providers (Supabase + legacy) and
// clears localStorage. It does NOT redirect on its own — that's the
// caller's job (admin/main.js's logout() function does the same
// explicit redirect after await). Without the redirect below,
// signOut returns cleanly, this handler ends, and the user is left
// sitting on member.html with no session — the wrong-portal guards
// only run on page load, so the user has to refresh manually before
// the redirect kicks in. Bug reported during PR #19 testing.
//
// The redirect lives outside the try/catch so it fires on both the
// success and the network-blip paths.
$('#logout-btn')?.addEventListener('click', async () => {
  try {
    await signOut();
  } catch (err) {
    // Even if Supabase's revoke call fails (offline, server blip),
    // signOut clears localStorage first so the session is effectively
    // gone. Surface the error to console for debugging but proceed
    // to the redirect anyway.
    console.warn('[member] signOut error (ignored):', err);
  }
  window.location.href = 'login.html';
});
