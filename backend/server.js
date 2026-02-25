import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import SteamUser from 'steam-user';
import TradeOfferManager from 'steam-tradeoffer-manager';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const APP_TREASURY_WALLET = process.env.APP_TREASURY_WALLET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DB_PATH = path.resolve(__dirname, 'caserush.sqlite');

app.use(cors());
app.use(express.json());

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    tg_user_id TEXT PRIMARY KEY,
    balance_nano_ton INTEGER NOT NULL DEFAULT 0,
    steam_trade_link TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inventory_items (
    id TEXT PRIMARY KEY,
    tg_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rarity TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (tg_user_id) REFERENCES users (tg_user_id)
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT NOT NULL UNIQUE,
    tg_user_id TEXT NOT NULL,
    amount_nano_ton INTEGER NOT NULL,
    confirmed_at INTEGER NOT NULL,
    chain TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    tg_user_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    item_rarity TEXT NOT NULL,
    steam_status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    price_nano_ton INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS case_pool_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rarity TEXT NOT NULL,
    chance REAL NOT NULL,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (case_id) REFERENCES cases (id) ON DELETE CASCADE
  );
`);

const countCases = db.prepare('SELECT COUNT(*) AS count FROM cases').get().count;
if (!countCases) {
  const now = Date.now();
  const seedCases = [
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

  const insertCase = db.prepare(`
    INSERT INTO cases (id, title, price_nano_ton, is_active, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `);
  const insertPool = db.prepare(`
    INSERT INTO case_pool_items (case_id, name, rarity, chance, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  runInTransaction(() => {
    for (const c of seedCases) {
      insertCase.run(c.id, c.title, c.priceNanoTon, now, now);
      c.pool.forEach((item, index) => {
        insertPool.run(c.id, item.name, item.rarity, item.chance, index);
      });
    }
  });
}

const SKIN_ASSET_MAP = process.env.SKIN_ASSET_MAP ? JSON.parse(process.env.SKIN_ASSET_MAP) : {};

function runInTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    callback();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
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

function ensureUser(tgUserId) {
  const now = Date.now();
  const exists = db.prepare('SELECT tg_user_id FROM users WHERE tg_user_id = ?').get(tgUserId);
  if (!exists) {
    db.prepare(`
      INSERT INTO users (tg_user_id, balance_nano_ton, steam_trade_link, updated_at)
      VALUES (?, 0, NULL, ?)
    `).run(tgUserId, now);
  }

  return db.prepare('SELECT * FROM users WHERE tg_user_id = ?').get(tgUserId);
}

function getInventory(tgUserId) {
  return db.prepare(`
    SELECT id, name, rarity, status, created_at AS createdAt
    FROM inventory_items
    WHERE tg_user_id = ?
    ORDER BY created_at DESC
  `).all(tgUserId);
}

function getCases(activeOnly = true) {
  const cases = db.prepare(`
    SELECT id, title, price_nano_ton AS priceNanoTon, is_active AS isActive
    FROM cases
    ${activeOnly ? 'WHERE is_active = 1' : ''}
    ORDER BY created_at ASC
  `).all();

  const poolByCaseId = new Map();
  const poolRows = db.prepare(`
    SELECT case_id AS caseId, name, rarity, chance
    FROM case_pool_items
    ORDER BY sort_order ASC
  `).all();

  for (const row of poolRows) {
    if (!poolByCaseId.has(row.caseId)) poolByCaseId.set(row.caseId, []);
    poolByCaseId.get(row.caseId).push({ name: row.name, rarity: row.rarity, chance: row.chance });
  }

  return cases.map((c) => ({ ...c, pool: poolByCaseId.get(c.id) || [] }));
}

function validateCasePayload(payload) {
  if (!payload?.id || !payload?.title || !payload?.priceNanoTon || !Array.isArray(payload?.pool)) {
    return 'id, title, priceNanoTon и pool обязательны';
  }

  const sum = payload.pool.reduce((acc, i) => acc + Number(i.chance || 0), 0);
  if (Math.abs(sum - 1) > 0.0001) return 'Сумма chance в pool должна быть равна 1';

  for (const item of payload.pool) {
    if (!item.name || !item.rarity || !Number(item.chance)) {
      return 'Каждый pool item должен иметь name, rarity, chance';
    }
  }

  return null;
}

function weightedPick(pool) {
  const rnd = Math.random();
  let sum = 0;
  for (const item of pool) {
    sum += Number(item.chance);
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
  res.json({ ok: true, steamReady, treasuryWallet: APP_TREASURY_WALLET, dbPath: DB_PATH });
});

app.get('/api/bootstrap', requireTelegramUser, (req, res) => {
  const user = ensureUser(req.tgUserId);
  res.json({
    balanceNanoTon: user.balance_nano_ton,
    inventory: getInventory(req.tgUserId),
    steamTradeLink: user.steam_trade_link,
    treasuryWallet: APP_TREASURY_WALLET,
    cases: getCases(true)
  });
});

app.post('/api/topup/confirm', requireTelegramUser, (req, res) => {
  const { txHash, amountNanoTon } = req.body;
  if (!txHash || !amountNanoTon) return res.status(400).json({ error: 'txHash and amountNanoTon are required' });

  const amount = Number(amountNanoTon);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amountNanoTon' });

  const existing = db.prepare('SELECT id FROM deposits WHERE tx_hash = ?').get(txHash);
  if (existing) return res.status(409).json({ error: 'Deposit already processed' });

  ensureUser(req.tgUserId);
  runInTransaction(() => {
    db.prepare('UPDATE users SET balance_nano_ton = balance_nano_ton + ?, updated_at = ? WHERE tg_user_id = ?')
      .run(amount, Date.now(), req.tgUserId);
    db.prepare('INSERT INTO deposits (tx_hash, tg_user_id, amount_nano_ton, confirmed_at, chain) VALUES (?, ?, ?, ?, ?)')
      .run(txHash, req.tgUserId, amount, Date.now(), 'TON');
  });

  const updated = db.prepare('SELECT balance_nano_ton FROM users WHERE tg_user_id = ?').get(req.tgUserId);
  res.json({ ok: true, balanceNanoTon: updated.balance_nano_ton });
});

app.post('/api/cases/open', requireTelegramUser, (req, res) => {
  const { caseId } = req.body;
  if (!caseId) return res.status(400).json({ error: 'caseId is required' });

  const gameCase = getCases(true).find((entry) => entry.id === caseId);
  if (!gameCase) return res.status(404).json({ error: 'Unknown caseId' });

  ensureUser(req.tgUserId);
  const user = db.prepare('SELECT balance_nano_ton FROM users WHERE tg_user_id = ?').get(req.tgUserId);
  if (Number(user.balance_nano_ton) < Number(gameCase.priceNanoTon)) {
    return res.status(400).json({ error: 'Not enough TON balance' });
  }

  const dropped = weightedPick(gameCase.pool);
  const item = {
    id: crypto.randomUUID(),
    name: dropped.name,
    rarity: dropped.rarity,
    status: 'in_inventory',
    createdAt: Date.now()
  };

  runInTransaction(() => {
    db.prepare('UPDATE users SET balance_nano_ton = balance_nano_ton - ?, updated_at = ? WHERE tg_user_id = ?')
      .run(gameCase.priceNanoTon, Date.now(), req.tgUserId);
    db.prepare('INSERT INTO inventory_items (id, tg_user_id, name, rarity, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(item.id, req.tgUserId, item.name, item.rarity, item.status, item.createdAt);
  });

  const balance = db.prepare('SELECT balance_nano_ton FROM users WHERE tg_user_id = ?').get(req.tgUserId);
  res.json({ item, balanceNanoTon: balance.balance_nano_ton, inventory: getInventory(req.tgUserId) });
});

app.post('/api/withdraw', requireTelegramUser, (req, res) => {
  const { itemId, tradeUrl } = req.body;
  if (!itemId || !tradeUrl) return res.status(400).json({ error: 'itemId and tradeUrl are required' });

  const item = db.prepare('SELECT id, name, rarity FROM inventory_items WHERE id = ? AND tg_user_id = ?').get(itemId, req.tgUserId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const assetId = SKIN_ASSET_MAP[item.name];
  if (!assetId) return res.status(400).json({ error: `No Steam asset mapping for ${item.name}` });
  if (!steamReady) return res.status(503).json({ error: 'Steam bot is not ready' });

  const offer = steamManager.createOffer(tradeUrl);
  offer.addMyItem({ appid: 730, contextid: '2', assetid: String(assetId) });
  offer.setMessage(`CaseRush withdrawal: ${item.name}`);

  offer.send((err, status) => {
    if (err) return res.status(500).json({ error: `Steam offer error: ${err.message}` });

    runInTransaction(() => {
      db.prepare('DELETE FROM inventory_items WHERE id = ?').run(itemId);
      db.prepare('UPDATE users SET steam_trade_link = ?, updated_at = ? WHERE tg_user_id = ?')
        .run(tradeUrl, Date.now(), req.tgUserId);
      db.prepare('INSERT INTO withdrawals (id, tg_user_id, item_name, item_rarity, steam_status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), req.tgUserId, item.name, item.rarity, String(status), Date.now());
    });

    return res.json({ ok: true, steamStatus: status, inventory: getInventory(req.tgUserId) });
  });
});

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const totals = {
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    depositsNanoTon: db.prepare('SELECT COALESCE(SUM(amount_nano_ton), 0) AS sum FROM deposits').get().sum,
    withdrawals: db.prepare('SELECT COUNT(*) AS count FROM withdrawals').get().count,
    cases: db.prepare('SELECT COUNT(*) AS count FROM cases').get().count
  };

  const users = db.prepare(`
    SELECT u.tg_user_id AS tgUserId, u.balance_nano_ton AS balanceNanoTon,
      (SELECT COUNT(*) FROM inventory_items i WHERE i.tg_user_id = u.tg_user_id) AS inventoryCount,
      u.updated_at AS updatedAt
    FROM users u
    ORDER BY u.updated_at DESC
    LIMIT 100
  `).all();

  const deposits = db.prepare(`
    SELECT tx_hash AS txHash, tg_user_id AS tgUserId, amount_nano_ton AS amountNanoTon, confirmed_at AS confirmedAt, chain
    FROM deposits ORDER BY confirmed_at DESC LIMIT 100
  `).all();

  const withdrawals = db.prepare(`
    SELECT id, tg_user_id AS tgUserId, item_name AS itemName, item_rarity AS itemRarity, steam_status AS steamStatus, created_at AS createdAt
    FROM withdrawals ORDER BY created_at DESC LIMIT 100
  `).all();

  res.json({ totals, users, deposits, withdrawals, cases: getCases(false) });
});

app.get('/api/admin/cases', requireAdmin, (_req, res) => {
  res.json({ cases: getCases(false) });
});

app.post('/api/admin/cases', requireAdmin, (req, res) => {
  const error = validateCasePayload(req.body);
  if (error) return res.status(400).json({ error });

  const exists = db.prepare('SELECT id FROM cases WHERE id = ?').get(req.body.id);
  if (exists) return res.status(409).json({ error: 'Case id already exists' });

  const now = Date.now();
  runInTransaction(() => {
    db.prepare('INSERT INTO cases (id, title, price_nano_ton, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.body.id, req.body.title, Number(req.body.priceNanoTon), req.body.isActive === false ? 0 : 1, now, now);

    req.body.pool.forEach((item, index) => {
      db.prepare('INSERT INTO case_pool_items (case_id, name, rarity, chance, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(req.body.id, item.name, item.rarity, Number(item.chance), index);
    });
  });

  res.json({ ok: true, cases: getCases(false) });
});

app.put('/api/admin/cases/:id', requireAdmin, (req, res) => {
  const caseId = req.params.id;
  const error = validateCasePayload({ ...req.body, id: caseId });
  if (error) return res.status(400).json({ error });

  const exists = db.prepare('SELECT id FROM cases WHERE id = ?').get(caseId);
  if (!exists) return res.status(404).json({ error: 'Case not found' });

  runInTransaction(() => {
    db.prepare('UPDATE cases SET title = ?, price_nano_ton = ?, is_active = ?, updated_at = ? WHERE id = ?')
      .run(req.body.title, Number(req.body.priceNanoTon), req.body.isActive === false ? 0 : 1, Date.now(), caseId);
    db.prepare('DELETE FROM case_pool_items WHERE case_id = ?').run(caseId);

    req.body.pool.forEach((item, index) => {
      db.prepare('INSERT INTO case_pool_items (case_id, name, rarity, chance, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(caseId, item.name, item.rarity, Number(item.chance), index);
    });
  });

  res.json({ ok: true, cases: getCases(false) });
});

app.delete('/api/admin/cases/:id', requireAdmin, (req, res) => {
  const caseId = req.params.id;
  const used = db.prepare('SELECT COUNT(*) AS count FROM inventory_items WHERE name IN (SELECT name FROM case_pool_items WHERE case_id = ?)').get(caseId);
  if (used.count > 0) {
    return res.status(400).json({ error: 'Нельзя удалить кейс: в инвентарях есть связанные предметы' });
  }

  runInTransaction(() => {
    db.prepare('DELETE FROM case_pool_items WHERE case_id = ?').run(caseId);
    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
  });

  res.json({ ok: true, cases: getCases(false) });
});

app.post('/api/admin/credit', requireAdmin, (req, res) => {
  const { tgUserId, amountNanoTon } = req.body;
  if (!tgUserId || !amountNanoTon) return res.status(400).json({ error: 'tgUserId and amountNanoTon are required' });
  const amount = Number(amountNanoTon);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amountNanoTon must be positive' });

  ensureUser(String(tgUserId));
  runInTransaction(() => {
    db.prepare('UPDATE users SET balance_nano_ton = balance_nano_ton + ?, updated_at = ? WHERE tg_user_id = ?')
      .run(amount, Date.now(), String(tgUserId));
    db.prepare('INSERT INTO deposits (tx_hash, tg_user_id, amount_nano_ton, confirmed_at, chain) VALUES (?, ?, ?, ?, ?)')
      .run(`admin-credit-${crypto.randomUUID()}`, String(tgUserId), amount, Date.now(), 'TON');
  });

  const user = db.prepare('SELECT balance_nano_ton FROM users WHERE tg_user_id = ?').get(String(tgUserId));
  res.json({ ok: true, balanceNanoTon: user.balance_nano_ton });
});

app.use(express.static(path.resolve(ROOT_DIR, 'www')));
app.get('/admin', (_req, res) => res.sendFile(path.resolve(ROOT_DIR, 'www/admin.html')));
app.get('*', (_req, res) => res.sendFile(path.resolve(ROOT_DIR, 'www/index.html')));

app.listen(PORT, () => {
  console.log(`CaseRush server is running at ${PUBLIC_URL}`);
});
