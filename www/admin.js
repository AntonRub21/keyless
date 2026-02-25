const adminTokenInput = document.getElementById('adminToken');
const loadOverviewBtn = document.getElementById('loadOverview');
const creditUserIdInput = document.getElementById('creditUserId');
const creditAmountInput = document.getElementById('creditAmount');
const creditBtn = document.getElementById('creditBtn');
const overviewEl = document.getElementById('overview');

function getToken() {
  return adminTokenInput.value.trim();
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

async function loadOverview() {
  try {
    const data = await adminApi('/api/admin/overview');
    overviewEl.textContent = JSON.stringify(data, null, 2);
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

loadOverviewBtn.addEventListener('click', loadOverview);
creditBtn.addEventListener('click', creditUser);
