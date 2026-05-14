// Opportunities tab — stub for sub-phase 5b. Full implementation in 5c
// (calls opportunities.list, filters client-side to own-committee +
// open-to-all, renders rows with an "express interest" button that
// dispatches to interest.submit).

export async function loadOpportunities() {
  const tbody = document.getElementById('opps-tbody');
  if (tbody) tbody.innerHTML = '<tr class="empty-row"><td colspan="6">قيد التطوير — Phase 5c</td></tr>';
}

export async function expressInterest(_opportunityId, _label) {
  // No-op until 5c.
}
