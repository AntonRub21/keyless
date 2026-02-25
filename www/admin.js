const adminTokenInput = document.getElementById('adminToken');
const loadOverviewBtn = document.getElementById('loadOverview');
const creditUserIdInput = document.getElementById('creditUserId');
const creditAmountInput = document.getElementById('creditAmount');
const creditBtn = document.getElementById('creditBtn');
const overviewEl = document.getElementById('overview');
const casesListEl = document.getElementById('casesList');
const caseIdInput = document.getElementById('caseId');
const caseTitleInput = document.getElementById('caseTitle');
const casePriceInput = document.getElementById('casePrice');
const caseActiveInput = document.getElementById('caseActive');
const casePoolInput = document.getElementById('casePool');
const createCaseBtn = document.getElementById('createCase');
const updateCaseBtn = document.getElementById('updateCase');
const deleteCaseBtn = document.getElementById('deleteCase');

let lastOverview = null;

function getToken() {
  return adminTokenInput.value.trim();
}

function nanoToTon(nano) {
  return (Number(nano) / 1_000_000_000).toFixed(2);
}

async function adminApi(path, options = {}) {
  const response = await fetch(`${window.location.origin}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': getToken(),
      ...(options.headers || {})
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Request failed: ${response.status}`);
  return json;
}

function renderCases(cases) {
  const normalized = cases.map((c) => ({ ...c, priceTON: nanoToTon(c.priceNanoTon) }));
  casesListEl.textContent = JSON.stringify(normalized, null, 2);
}

function fillCaseForm(caseData) {
  caseIdInput.value = caseData.id;
  caseTitleInput.value = caseData.title;
  casePriceInput.value = caseData.priceNanoTon;
  caseActiveInput.checked = Boolean(caseData.isActive);
  casePoolInput.value = JSON.stringify(caseData.pool, null, 2);
}

function parseCaseForm() {
  const id = caseIdInput.value.trim();
  const title = caseTitleInput.value.trim();
  const priceNanoTon = Number(casePriceInput.value);
  const isActive = caseActiveInput.checked;
  const pool = JSON.parse(casePoolInput.value || '[]');

  return { id, title, priceNanoTon, isActive, pool };
}

async function loadOverview() {
  try {
    lastOverview = await adminApi('/api/admin/overview');
    overviewEl.textContent = JSON.stringify(lastOverview, null, 2);
    renderCases(lastOverview.cases || []);
  } catch (error) {
    overviewEl.textContent = error.message;
  }
}

async function creditUser() {
  try {
    await adminApi('/api/admin/credit', {
      method: 'POST',
      body: JSON.stringify({
        tgUserId: creditUserIdInput.value.trim(),
        amountNanoTon: Number(creditAmountInput.value)
      })
    });
    await loadOverview();
  } catch (error) {
    overviewEl.textContent = error.message;
  }
}

async function createCase() {
  try {
    const payload = parseCaseForm();
    await adminApi('/api/admin/cases', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    await loadOverview();
  } catch (error) {
    overviewEl.textContent = error.message;
  }
}

async function updateCase() {
  try {
    const payload = parseCaseForm();
    await adminApi(`/api/admin/cases/${encodeURIComponent(payload.id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    await loadOverview();
  } catch (error) {
    overviewEl.textContent = error.message;
  }
}

async function deleteCase() {
  try {
    const caseId = caseIdInput.value.trim();
    if (!caseId) throw new Error('Укажи case id для удаления');

    await adminApi(`/api/admin/cases/${encodeURIComponent(caseId)}`, {
      method: 'DELETE'
    });
    await loadOverview();
  } catch (error) {
    overviewEl.textContent = error.message;
  }
}

casesListEl.addEventListener('dblclick', () => {
  if (!lastOverview?.cases?.length) return;
  const selected = lastOverview.cases.find((c) => c.id === caseIdInput.value.trim()) || lastOverview.cases[0];
  fillCaseForm(selected);
});

loadOverviewBtn.addEventListener('click', loadOverview);
creditBtn.addEventListener('click', creditUser);
createCaseBtn.addEventListener('click', createCase);
updateCaseBtn.addEventListener('click', updateCase);
deleteCaseBtn.addEventListener('click', deleteCase);
