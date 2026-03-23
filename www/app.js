const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

if (window.telegramAnalytics?.init) {
  window.telegramAnalytics.init({ appName: 'CaseRush CS2' });
}

const tonConnectEl = document.getElementById('ton-connect');
const tonBalanceEl = document.getElementById('tonBalance');
const casesEl = document.getElementById('cases');
const inventoryEl = document.getElementById('inventory');
const buyTonBtn = document.getElementById('buyTon');
const withdrawBtn = document.getElementById('withdraw');
const tradeLinkInput = document.getElementById('steamTradeLink');
const dropDialog = document.getElementById('dropDialog');
const dropText = document.getElementById('dropText');
const closeDialog = document.getElementById('closeDialog');

const tgUserId = String(tg?.initDataUnsafe?.user?.id || localStorage.getItem('caseRushFallbackUserId') || 'demo-user');
localStorage.setItem('caseRushFallbackUserId', tgUserId);

const state = {
  balanceNanoTon: 0,
  inventory: [],
  selectedItemId: null,
  cases: [],
  treasuryWallet: ''
};

let tonConnectUI;

function nanoToTon(nano) {
  return (Number(nano) / 1_000_000_000).toFixed(2);
}

function tonToNano(tonAmount) {
  return Math.floor(Number(tonAmount) * 1_000_000_000);
}

async function api(path, options = {}) {
  const response = await fetch(`${window.location.origin}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-init-data': tg?.initData || '',
      ...(options.headers || {})
    }
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Request failed: ${response.status}`);
  return json;
}

function toast(message, isError = false) {
  if (window.telegramAnalytics?.track) {
    window.telegramAnalytics.track(isError ? 'error' : 'event', { message });
  }
  if (tg?.showPopup) tg.showPopup({ title: isError ? 'Ошибка' : 'Готово', message, buttons: [{ type: 'ok' }] });
  else alert(message);
}

function renderBalance() {
  tonBalanceEl.textContent = `${nanoToTon(state.balanceNanoTon)} TON`;
}

function renderCases() {
  casesEl.innerHTML = '';
  state.cases.forEach((gameCase) => {
    const card = document.createElement('article');
    card.className = 'case';
    card.innerHTML = `
      <h3>${gameCase.title}</h3>
      <p class="price">${nanoToTon(gameCase.priceNanoTon)} TON</p>
      <ul>${gameCase.pool.map((i) => `<li>${i.name}</li>`).join('')}</ul>
      <button data-open="${gameCase.id}" class="primary">Открыть кейс</button>
    `;
    casesEl.append(card);
  });
}

function renderInventory() {
  inventoryEl.innerHTML = '';
  if (!state.inventory.length) {
    inventoryEl.classList.add('empty');
    inventoryEl.textContent = 'Пока нет дропов — открой кейс 👀';
    return;
  }
  inventoryEl.classList.remove('empty');
  state.inventory.forEach((item) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `item ${state.selectedItemId === item.id ? 'selected' : ''}`;
    row.innerHTML = `<span>${item.name}<br><small>${item.rarity}</small></span><small>${new Date(item.createdAt).toLocaleString('ru-RU')}</small>`;
    row.addEventListener('click', () => {
      state.selectedItemId = item.id;
      renderInventory();
    });
    inventoryEl.append(row);
  });
}

async function loadBootstrap() {
  const bootstrap = await api(`/api/bootstrap?tgUserId=${encodeURIComponent(tgUserId)}`);
  state.balanceNanoTon = bootstrap.balanceNanoTon;
  state.inventory = bootstrap.inventory;
  state.cases = bootstrap.cases;
  state.treasuryWallet = bootstrap.treasuryWallet;

  if (bootstrap.steamTradeLink) tradeLinkInput.value = bootstrap.steamTradeLink;

  renderBalance();
  renderCases();
  renderInventory();
}

async function openCase(caseId) {
  try {
    const result = await api('/api/cases/open', {
      method: 'POST',
      body: JSON.stringify({ tgUserId, caseId })
    });

    state.balanceNanoTon = result.balanceNanoTon;
    state.inventory = result.inventory;
    state.selectedItemId = result.item.id;

    renderBalance();
    renderInventory();

    dropText.textContent = `Тебе выпал: ${result.item.name} (${result.item.rarity})`;
    dropDialog.showModal();
  } catch (error) {
    toast(error.message, true);
  }
}

async function topupByTonConnect(tonAmount) {
  if (!tonConnectUI) {
    toast('TON Connect SDK не инициализирован', true);
    return;
  }
  if (!state.treasuryWallet) {
    toast('Не настроен APP_TREASURY_WALLET на сервере', true);
    return;
  }

  const amountNanoTon = tonToNano(tonAmount);

  try {
    const tx = await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 360,
      messages: [
        {
          address: state.treasuryWallet,
          amount: String(amountNanoTon)
        }
      ]
    });

    await api('/api/topup/confirm', {
      method: 'POST',
      body: JSON.stringify({
        tgUserId,
        txHash: tx.boc || `client-${Date.now()}`,
        amountNanoTon
      })
    });

    await loadBootstrap();
    toast(`Баланс пополнен на ${Number(tonAmount).toFixed(2)} TON`);
  } catch (error) {
    toast(error.message || 'Ошибка TON-транзакции', true);
  }
}

async function withdrawSelectedItem() {
  const tradeLink = tradeLinkInput.value.trim();
  if (!tradeLink.includes('steamcommunity.com/tradeoffer/new')) {
    toast('Укажи корректный Steam trade URL', true);
    return;
  }
  if (!state.selectedItemId) {
    toast('Сначала выбери предмет в инвентаре', true);
    return;
  }

  try {
    const result = await api('/api/withdraw', {
      method: 'POST',
      body: JSON.stringify({
        tgUserId,
        itemId: state.selectedItemId,
        tradeUrl: tradeLink
      })
    });

    state.inventory = result.inventory;
    state.selectedItemId = null;
    renderInventory();
    toast('Скин отправлен в Steam оффером');
  } catch (error) {
    toast(error.message, true);
  }
}

function initTonConnect() {
  if (!window.TON_CONNECT_UI?.TonConnectUI) {
    toast('TON Connect SDK не загружен', true);
    return;
  }

  tonConnectUI = new window.TON_CONNECT_UI.TonConnectUI({
    manifestUrl: `${window.location.origin}/tonconnect-manifest.json`,
    buttonRootId: 'ton-connect'
  });

  tonConnectEl.style.display = 'block';
}

casesEl.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const caseId = target.dataset.open;
  if (caseId) openCase(caseId);
});

buyTonBtn.addEventListener('click', () => topupByTonConnect(1));
withdrawBtn.addEventListener('click', withdrawSelectedItem);
closeDialog.addEventListener('click', () => dropDialog.close());

for (const btn of document.querySelectorAll('[data-ton]')) {
  btn.addEventListener('click', () => topupByTonConnect(Number(btn.dataset.ton)));
}

initTonConnect();
loadBootstrap().catch((error) => toast(`Ошибка инициализации: ${error.message}`, true));
