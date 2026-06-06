import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _db = null;
let _testMode = false;

/**
 * Reset DB for testing — deletes all rows from all tables, keeping schema.
 * Call this before each test to ensure clean state.
 */
export function resetDb() {
  let dbPath = null;
  const configPath = process.env.__TEST_CONFIG_PATH;
  if (configPath) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      dbPath = config.memory?.ledger?.db_path;
    } catch {}
  }

  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }

  if (dbPath && fs.existsSync(dbPath)) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM trades;
        DELETE FROM signals;
        DELETE FROM signal_stats;
        DELETE FROM daily_stats;
      `);
      db.close();
    } catch {}
  }

  _testMode = true;
}

function loadConfig() {
  // Allow test injection via path env var
  if (process.env.__TEST_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(process.env.__TEST_CONFIG_PATH, 'utf8'));
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── SQLite Setup ─────────────────────────────────────────────────────────────


function getDb() {
  if (_db) return _db;

  // Find DB path
  let dbPath;
  const configPath = process.env.__TEST_CONFIG_PATH;
  if (configPath) {
    if (require('fs').existsSync(configPath)) {
      try {
        const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
        dbPath = config.memory?.ledger?.db_path;
      } catch {}
    }
  }
  if (!dbPath) {
    const config = loadConfig();
    dbPath = config.memory?.ledger?.db_path || './memory/db/trades.db';
  }

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new (require('better-sqlite3'))(dbPath);

  // Recreate DB file if it was deleted (e.g., by cleanupTestFiles)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      token_address TEXT,
      symbol TEXT,
      side TEXT,
      sub_wallet_index INTEGER,
      amount_sol REAL,
      amount_sol_invested REAL,
      price REAL,
      pnl_sol REAL,
      pnl_pct REAL,
      timestamp INTEGER,
      entry_time INTEGER,
      exit_time INTEGER,
      signal TEXT,
      entry_price REAL,
      exit_price REAL,
      confidence REAL,
      conviction TEXT,
      exit_reason TEXT,
      signal_tags TEXT,
      entry_reasoning TEXT,
      llm_confidence REAL,
      hold_duration_minutes INTEGER,
      source TEXT,
      feed_source TEXT
    );
  `);

  // Migration: ensure column compatibility (older schema used mint_address)
  try {
    const cols = _db.prepare("PRAGMA table_info(trades)").all();
    const colNames = cols.map(c => c.name);
    if (colNames.includes('mint_address') && !colNames.includes('token_address')) {
      _db.exec("ALTER TABLE trades ADD COLUMN token_address TEXT");
      _db.exec("UPDATE trades SET token_address = mint_address WHERE token_address IS NULL");
    }
  } catch (e) { /* no-op */ }

  // Migration: ensure source column exists (for older DBs)
  try {
    _db.exec("ALTER TABLE trades ADD COLUMN source TEXT DEFAULT 'live'");
  } catch (e) { /* column already exists, skip */ }

  // Migration: ensure feed_source column exists
  try {
    _db.exec("ALTER TABLE trades ADD COLUMN feed_source TEXT DEFAULT NULL");
  } catch (e) { /* column already exists, skip */ }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      loss_sol_today REAL DEFAULT 0,
      trade_count_today INTEGER DEFAULT 0,
      is_tripped INTEGER DEFAULT 0,
      tripped_at INTEGER,
      tripped_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      mint_address TEXT,
      signal_type TEXT NOT NULL,
      confidence REAL,
      conviction TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_stats (
      signal_key TEXT PRIMARY KEY,
      total_trades INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      total_pnl_sol REAL DEFAULT 0
    );
  `);

  return _db;
}

/**
 * Get or create the database instance.
 * For testing: call resetDb() first to clear cache, then call this.
 */
export function getDbInstance() {
  return getDb();
}

function initializeDb() {
  getDb();
}

// ─── Trade Operations ───────────────────────────────────────────────────────────

/**
 * Record a completed trade
 */
export async function recordTrade(tradeData) {
  const db = getDb();
  const id = tradeData.id || randomUUID();
  const timestamp = tradeData.timestamp || Date.now();

  // Support field aliases from different naming conventions
  const token_address = tradeData.token_address || tradeData.mint_address;
  const amount_sol = tradeData.amount_sol ?? tradeData.amount_sol_invested ?? null;
  const amount_sol_invested = tradeData.amount_sol_invested ?? amount_sol;
  // Accept both entry_price_usd (used by callers) and entry_price (DB column name).
  const entry_price = tradeData.entry_price ?? tradeData.entry_price_usd ?? null;
  const exit_price = tradeData.exit_price ?? tradeData.exit_price_usd ?? null;
  const signal_tags = Array.isArray(tradeData.signal_tags)
    ? JSON.stringify(tradeData.signal_tags)
    : (tradeData.signal_tags || null);

  db.prepare(`
    INSERT OR REPLACE INTO trades (id, token_address, symbol, side, sub_wallet_index, amount_sol, amount_sol_invested, price, pnl_sol, pnl_pct, timestamp, entry_time, exit_time, signal, entry_price, exit_price, confidence, conviction, exit_reason, signal_tags, entry_reasoning, llm_confidence, hold_duration_minutes, source, feed_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    token_address,
    tradeData.symbol ?? null,
    tradeData.side ?? 'buy',
    tradeData.sub_wallet_index ?? null,
    amount_sol,
    amount_sol_invested,
    tradeData.price ?? null,
    tradeData.pnl_sol ?? 0,
    tradeData.pnl_pct ?? null,
    timestamp,
    tradeData.entry_time ?? null,
    tradeData.exit_time ?? null,
    tradeData.signal ?? null,
    entry_price,
    exit_price,
    tradeData.confidence ?? tradeData.llm_confidence ?? null,
    tradeData.conviction ?? null,
    tradeData.exit_reason ?? null,
    signal_tags,
    tradeData.entry_reasoning ?? null,
    tradeData.llm_confidence ?? null,
    tradeData.hold_duration_minutes ?? null,
    tradeData.source ?? 'live',
    tradeData.feed_source ?? null
  );

  return { id, success: true, symbol: tradeData.symbol ?? null };
}

/**
 * Update signal statistics
 */
export async function updateSignalStats(mintAddressOrArray, signalOrConfidence, conviction) {
  // Support multiple call styles:
  // updateSignalStats(mintAddress, signal, confidence, conviction) - legacy positional
  // updateSignalStats(['high_volume', 'new_listing'], 0.025, true) - signal_tags array + pnl_sol + is_win
  // updateSignalStats({ mint_address, signal_tags, confidence, conviction }) - object style
  let mintAddress, signalKey, pnlSol, isWin;
  if (Array.isArray(mintAddressOrArray)) {
    // Array = signal_tags, second param is pnl_sol, third is is_win (bool)
    const signalTags = mintAddressOrArray;
    pnlSol = signalOrConfidence;
    isWin = conviction;
    signalKey = (signalTags || []).sort().join('|') || 'none';
    mintAddress = null;
  } else if (typeof mintAddressOrArray === 'object') {
    const obj = mintAddressOrArray;
    mintAddress = obj.mint_address || obj.mintAddress || null;
    signalKey = obj.signal_tags ? obj.signal_tags.sort().join('|') || 'none' : (obj.signal || 'none');
    pnlSol = obj.pnl_sol ?? obj.confidence ?? null;
    isWin = obj.is_win ?? obj.conviction ?? null;
  } else {
    mintAddress = mintAddressOrArray;
    signalKey = signalOrConfidence;
    pnlSol = conviction;
    isWin = arguments[3] ?? null;
  }

  const db = getDb();
  const id = randomUUID();
  const timestamp = Date.now();

  // Insert into signals log
  db.prepare(`
    INSERT INTO signals (id, mint_address, signal_type, confidence, conviction, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, mintAddress, signalKey, pnlSol, isWin ? 1 : 0, timestamp);

  // Upsert into signal_stats
  const isWinVal = isWin ? 1 : 0;
  db.prepare(`
    INSERT INTO signal_stats (signal_key, total_trades, wins, losses, total_pnl_sol)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(signal_key) DO UPDATE SET
      total_trades = total_trades + 1,
      wins = wins + excluded.wins,
      losses = losses + excluded.losses,
      total_pnl_sol = total_pnl_sol + excluded.total_pnl_sol
  `).run(signalKey, isWinVal, isWinVal ? 0 : 1, pnlSol || 0);

  // Return the updated stats
  const stats = db.prepare('SELECT * FROM signal_stats WHERE signal_key = ?').get(signalKey);
  return {
    combination: stats.signal_key,
    total_trades: stats.total_trades,
    wins: stats.wins,
    losses: stats.losses,
    total_pnl_sol: stats.total_pnl_sol,
  };
}

/**
 * Get ledger statistics
 */
export async function getLedgerStats() {
  const db = getDb();
  const totalTrades = db.prepare('SELECT COUNT(*) as cnt, SUM(pnl_sol) as total FROM trades').get();
  const wins = db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE pnl_sol > 0').get();

  const tradeCount = totalTrades?.cnt || 0;
  const winCount = wins?.cnt || 0;
  const winRate = tradeCount > 0 ? (winCount / tradeCount) * 100 : 0;
  const pnlTotal = totalTrades?.total ?? 0;
  const avgPnl = tradeCount > 0 ? pnlTotal / tradeCount : 0;

  // ── Breakdown per source (live, paper, backtest) ──────────────────────
  const bySourceRows = db.prepare(`
    SELECT
      COALESCE(source, 'unknown') as src,
      COUNT(*) as total,
      SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END) as wins,
      SUM(pnl_sol) as total_pnl_sol
    FROM trades
    GROUP BY COALESCE(source, 'unknown')
  `).all();

  const by_source = {
    live:     { total: 0, wins: 0, win_rate_pct: 0, total_pnl_sol: 0 },
    paper:    { total: 0, wins: 0, win_rate_pct: 0, total_pnl_sol: 0 },
    backtest: { total: 0, wins: 0, win_rate_pct: 0, total_pnl_sol: 0 },
  };

  for (const row of bySourceRows) {
    if (!by_source[row.src]) {
      by_source[row.src] = { total: 0, wins: 0, win_rate_pct: 0, total_pnl_sol: 0 };
    }
    const bucket = by_source[row.src];
    bucket.total = row.total || 0;
    bucket.wins = row.wins || 0;
    bucket.total_pnl_sol = row.total_pnl_sol || 0;
    bucket.win_rate_pct = bucket.total > 0
      ? Math.round((bucket.wins / bucket.total) * 10000) / 100
      : 0;
  }

  return {
    total_trades: tradeCount,
    win_rate_pct: Math.round(winRate * 100) / 100,
    avg_pnl_pct: Math.round(avgPnl * 10000) / 100,
    total_pnl_sol: pnlTotal,
    by_source,
  };
}

/**
 * Get signal accuracy stats for all signal combinations
 */
export async function getSignalAccuracy() {
  const db = getDb();

  const allStats = db.prepare('SELECT * FROM signal_stats').all();

  if (allStats.length === 0) return {};

  const result = {};
  for (const row of allStats) {
    result[row.signal_key] = {
      total_trades: row.total_trades,
      wins: row.wins,
      losses: row.losses,
      total_pnl_sol: row.total_pnl_sol,
    };
  }
  return result;
}

/**
 * Get recent performance (last N trades)
 */
export async function getRecentPerformance(limit = 10) {
  const db = getDb();

  const trades = db.prepare(
    'SELECT * FROM trades ORDER BY entry_time DESC, timestamp DESC LIMIT ?'
  ).all(limit);

  return trades.map(t => ({
    id: t.id,
    mint_address: t.mint_address,
    side: t.side,
    amount_sol: t.amount_sol,
    pnl_sol: t.pnl_sol,
    timestamp: t.timestamp,
    entry_time: t.entry_time,
    signal_tags: t.signal_tags ? JSON.parse(t.signal_tags) : null,
  }));
}

/**
 * Get trade by ID
 */
export async function getTradeById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
}

/**
 * Get daily stats (for circuit breaker)
 */
export async function getDailyStats() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  let row = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today);

  if (!row) {
    db.prepare(`
      INSERT OR IGNORE INTO daily_stats (date, loss_sol_today, trade_count_today, is_tripped, tripped_at, tripped_reason)
      VALUES (?, 0, 0, 0, NULL, NULL)
    `).run(today);
    row = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today);
  }

  return {
    date: row.date,
    loss_sol_today: row.loss_sol_today || 0,
    trade_count_today: row.trade_count_today || 0,
    is_tripped: !!row.is_tripped,
    tripped_at: row.tripped_at || null,
    tripped_reason: row.tripped_reason || null,
  };
}