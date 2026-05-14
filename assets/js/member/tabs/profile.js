// Profile tab — stub for sub-phase 5b. Full implementation lands in 5c.
//
// loadProfile() is registered in main.js's loaderMap; saveProfile() is
// in the data-action handler map. Until 5c fills in the form rendering
// + the wire-up to members.getOwn / members.updateOwn, these are no-ops
// that just confirm the wiring works (page swaps in, "loading" text
// renders, save button click reaches here without throwing).

export async function loadProfile() {
  const wrap = document.getElementById('profile-form-wrap');
  if (wrap) wrap.innerHTML = '<p style="padding:1rem;color:var(--tl);font-size:.85rem">قيد التطوير — Phase 5c</p>';
}

export async function saveProfile() {
  // No-op until 5c.
}
