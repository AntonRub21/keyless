import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import SteamUser from 'steam-user';
import TradeOfferManager from 'steam-tradeoffer-manager';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const APP_TREASURY_WALLET = process.env.APP_TREASURY_WALLET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

app.use(cors());
app.use(express.json());

const DB_PATH = path.resolve(process.cwd(), 'backend/data.json');
const CASES = [
  {
    id: 'budget',
    title: 'Budget Rush',
    priceNanoTon: 250_000_000,
    pool: [
      { name: 'USP-S | Cortex', rarity: 'Mil-Spec', chance: 0.58 },
      { name: 'Glock-18 | Vogue', rarity: 'Restricted', chance: 0.28 },
      { name: 'AK-47 | Neon Rider', rarity: 'Covert', chance: 0.1 },
      { name: '★ Gut Knife | Doppler', rarity: 'Knife', chance: 0.04 }
    ]
  },
  {
    id: 'pro',
    title: 'Pro Arena',
    priceNanoTon: 700_000_000,
    pool: [
      { name: 'M4A4 | The Emperor', rarity: 'Classified', chance: 0.45 },
      { name: 'AWP | Neo-Noir', rarity: 'Covert', chance: 0.32 },
      { name: 'AK-47 | Asiimov', rarity: 'Covert', chance: 0.18 },
      { name: '★ Karambit | Fade', rarity: 'Knife', chance: 0.05 }
    ]
  }
];

const SKIN_ASSET_MAP = process.env.SKIN_ASSET_MAP ? JSON.parse(process.env.SKIN_ASSET_MAP) : {};

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: {}, deposits: [], withdrawals: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  parsed.users ||= {};
  parsed.deposits ||= [];
  parsed.withdrawals ||= [];
  return parsed;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function verifyTelegramInitData(initData) {
  if (!TELEGRAM_BOT_TOKEN || !initData) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return calculatedHash === hash;
}

function requireTelegramUser(req, res, next) {
  const tgUserId = String(req.body.tgUserId || req.query.tgUserId || '');
  if (!tgUserId) return res.status(400).json({ error: 'tgUserId is required' });

  if (TELEGRAM_BOT_TOKEN) {
    const initData = req.header('x-telegram-init-data');
    if (!verifyTelegramInitData(initData)) {
      return res.status(401).json({ error: 'Invalid Telegram initData signature' });
    }
  }

  req.tgUserId = tgUserId;
  next();
}

function requireAdmin(req, res, next) {
  const token = req.header('x-admin-token');
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Admin access denied' });
  }
  next();
}

function ensureUser(db, tgUserId) {
  if (!db.users[tgUserId]) {
    db.users[tgUserId] = {
      balanceNanoTon: 0,
      inventory: [],
      steamTradeLink: null,
      updatedAt: Date.now()
    };
  }
  return db.users[tgUserId];
}

function weightedPick(pool) {
  const rnd = Math.random();
  let sum = 0;
  for (const item of pool) {
    sum += item.chance;
    if (rnd <= sum) return item;
  }
  return pool[pool.length - 1];
}

const steamClient = new SteamUser();
const steamManager = new TradeOfferManager({ steam: steamClient, language: 'en' });
let steamReady = false;

if (process.env.STEAM_USERNAME && process.env.STEAM_PASSWORD) {
  steamClient.logOn({
    accountName: process.env.STEAM_USERNAME,
    password: process.env.STEAM_PASSWORD,
    twoFactorCode: process.env.STEAM_2FA || undefined
  });

  steamClient.on('loggedOn', () => {
    steamClient.setPersona(SteamUser.EPersonaState.Online);
    steamReady = true;
  });

  steamClient.on('error', () => {
    steamReady = false;
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, steamReady, treasuryWallet: APP_TREASURY_WALLET });
});

app.get('/api/bootstrap', requireTelegramUser, (req, res) => {
  const db = readDb();
  const user = ensureUser(db, req.tgUserId);
  writeDb(db);
  res.json({
    balanceNanoTon: user.balanceNanoTon,
    inventory: user.inventory,
    steamTradeLink: user.steamTradeLink,
    treasuryWallet: APP_TREASURY_WALLET,
    cases: CASES
  });
});

app.post('/api/topup/confirm', requireTelegramUser, (req, res) => {
  const { txHash, amountNanoTon } = req.body;
  if (!txHash || !amountNanoTon) {
    return res.status(400).json({ error: 'txHash and amountNanoTon are required' });
  }

  const amount = Number(amountNanoTon);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amountNanoTon' });
  }

  const db = readDb();
  const existing = db.deposits.find((entry) => entry.txHash === txHash);
  if (existing) {
    return res.status(409).json({ error: 'Deposit already processed' });
  }

  const user = ensureUser(db, req.tgUserId);
  user.balanceNanoTon += amount;
  user.updatedAt = Date.now();

  db.deposits.unshift({
    txHash,
    tgUserId: req.tgUserId,
    amountNanoTon: amount,
    confirmedAt: Date.now(),
    chain: 'TON'
  });

  writeDb(db);
  res.json({ ok: true, balanceNanoTon: user.balanceNanoTon });
});

app.post('/api/cases/open', requireTelegramUser, (req, res) => {
  const { caseId } = req.body;
  const db = readDb();
  const user = ensureUser(db, req.tgUserId);
  const gameCase = CASES.find((entry) => entry.id === caseId);

  if (!gameCase) return res.status(404).json({ error: 'Unknown caseId' });
  if (user.balanceNanoTon < gameCase.priceNanoTon) {
    return res.status(400).json({ error: 'Not enough TON balance' });
  }

  user.balanceNanoTon -= gameCase.priceNanoTon;
  const drop = weightedPick(gameCase.pool);
  const item = {
    id: crypto.randomUUID(),
    name: drop.name,
    rarity: drop.rarity,
    createdAt: Date.now(),
    status: 'in_inventory'
  };
  user.inventory.unshift(item);
  user.updatedAt = Date.now();

  writeDb(db);
  res.json({ item, balanceNanoTon: user.balanceNanoTon, inventory: user.inventory });
});

app.post('/api/withdraw', requireTelegramUser, (req, res) => {
  const { itemId, tradeUrl } = req.body;
  if (!itemId || !tradeUrl) return res.status(400).json({ error: 'itemId and tradeUrl are required' });

  const db = readDb();
  const user = ensureUser(db, req.tgUserId);
  const item = user.inventory.find((entry) => entry.id === itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const assetId = SKIN_ASSET_MAP[item.name];
  if (!assetId) return res.status(400).json({ error: `No Steam asset mapping for ${item.name}` });
  if (!steamReady) return res.status(503).json({ error: 'Steam bot is not ready' });

  const offer = steamManager.createOffer(tradeUrl);
  offer.addMyItem({ appid: 730, contextid: '2', assetid: String(assetId) });
  offer.setMessage(`CaseRush withdrawal: ${item.name}`);

  offer.send((err, status) => {
    if (err) {
      return res.status(500).json({ error: `Steam offer error: ${err.message}` });
    }

    user.inventory = user.inventory.filter((entry) => entry.id !== itemId);
    user.steamTradeLink = tradeUrl;
    user.updatedAt = Date.now();
    db.withdrawals.unshift({
      id: crypto.randomUUID(),
      tgUserId: req.tgUserId,
      itemName: item.name,
      itemRarity: item.rarity,
      steamStatus: status,
      createdAt: Date.now()
    });
    writeDb(db);
    return res.json({ ok: true, steamStatus: status, inventory: user.inventory });
  });
});

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const db = readDb();
  const users = Object.entries(db.users).map(([tgUserId, user]) => ({
    tgUserId,
    balanceNanoTon: user.balanceNanoTon,
    inventoryCount: user.inventory.length,
    updatedAt: user.updatedAt
  }));

  const totals = {
    users: users.length,
    depositsNanoTon: db.deposits.reduce((acc, d) => acc + Number(d.amountNanoTon || 0), 0),
    withdrawals: db.withdrawals.length
  };

  res.json({ totals, users, deposits: db.deposits.slice(0, 50), withdrawals: db.withdrawals.slice(0, 50), cases: CASES });
});

app.post('/api/admin/credit', requireAdmin, (req, res) => {
  const { tgUserId, amountNanoTon } = req.body;
  if (!tgUserId || !amountNanoTon) return res.status(400).json({ error: 'tgUserId and amountNanoTon are required' });
  const amount = Number(amountNanoTon);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amountNanoTon must be positive' });

  const db = readDb();
  const user = ensureUser(db, String(tgUserId));
  user.balanceNanoTon += amount;
  user.updatedAt = Date.now();
  db.deposits.unshift({
    txHash: `admin-credit-${crypto.randomUUID()}`,
    tgUserId: String(tgUserId),
    amountNanoTon: amount,
    confirmedAt: Date.now(),
    chain: 'TON'
  });
  writeDb(db);

  res.json({ ok: true, balanceNanoTon: user.balanceNanoTon });
});

app.use(express.static(path.resolve(process.cwd(), 'www')));
app.get('/admin', (_req, res) => res.sendFile(path.resolve(process.cwd(), 'www/admin.html')));
app.get('*', (_req, res) => res.sendFile(path.resolve(process.cwd(), 'www/index.html')));

app.listen(PORT, () => {
  console.log(`CaseRush server is running at ${PUBLIC_URL}`);
});
