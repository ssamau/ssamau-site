// Hours tab — stub for sub-phase 5b. Full implementation in 5c (calls
// hours.listOwn from the Edge Function, groups by approval_status,
// renders a table). For 5b the stub just confirms wiring.

export async function loadHours() {
  const tbody = document.getElementById('hours-tbody');
  if (tbody) tbody.innerHTML = '<tr class="empty-row"><td colspan="5">قيد التطوير — Phase 5c</td></tr>';
}
