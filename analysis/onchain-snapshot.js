import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  // Allow test injection via path env var
  if (process.env.__TEST_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(process.env.__TEST_CONFIG_PATH, 'utf8'));
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── On-chain Snapshot SQLite ─────────────────────────────────────────────────

let _db = null;

function getDb() {
  if (_db) return _db;

  const config = loadConfig();
  const dbPath = config.memory?.ledger?.db_path || './memory/db/trades.db';

  _db = new Database(dbPath);

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS position_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint_address TEXT NOT NULL,
      signal_score REAL,
      pnl_sol REAL,
      timestamp INTEGER,
      price_usd REAL
    );

    CREATE TABLE IF NOT EXISTS trajectory (
      mint_address TEXT NOT NULL,
      entry_price REAL,
      current_price REAL,
      pnl_pct REAL,
      snapshots_count INTEGER DEFAULT 0,
      last_updated INTEGER
    );
  `);

  return _db;
}

/**
 * Reset DB for testing — closes connection so next getDb() call reopens it.
 * This is needed because cleanupTestFiles() may delete the DB file out from
 * under our open handle, but getDb() would return the stale cached _db.
 */
export function resetDb() {
  if (_db) {
    try { _db.close(); } catch {}
    _db = null;
  }
}

// ─── Snapshot Functions ────────────────────────────────────────────────────────

/**
 * Record a position snapshot
 * @param {string} mintAddress - Token mint address
 * @param {object} data - Snapshot data
 */
export async function recordSnapshot(mintAddress, data) {
  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT INTO position_snapshots (mint_address, signal_score, pnl_sol, timestamp, price_usd)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    mintAddress,
    data.signal_score || 0,
    data.pnl_sol || 0,
    now,
    data.price_usd || null
  );

  // Update trajectory
  const existing = db.prepare('SELECT * FROM trajectory WHERE mint_address = ?').get(mintAddress);

  if (existing) {
    const snapshots_count = (existing.snapshots_count || 0) + 1;
    const newPnlPct = data.pnl_pct !== undefined ? data.pnl_pct : existing.pnl_pct;

    db.prepare(`
      UPDATE trajectory SET
        current_price = ?,
        pnl_pct = ?,
        snapshots_count = ?,
        last_updated = ?
      WHERE mint_address = ?
    `).run(data.price_usd || existing.current_price, newPnlPct, snapshots_count, now, mintAddress);
  } else {
    db.prepare(`
      INSERT INTO trajectory (mint_address, entry_price, current_price, pnl_pct, snapshots_count, last_updated)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(mintAddress, data.entry_price || null, data.price_usd || null, data.pnl_pct || 0, now);
  }
}

/**
 * Get trajectory for a token
 * @param {string} mintAddress - Token mint address
 * @returns {object|null} Trajectory data
 */
export async function getTrajectoryForRAG(mintAddress) {
  const db = getDb();
  const trajectory = db.prepare('SELECT * FROM trajectory WHERE mint_address = ?').get(mintAddress);

  if (!trajectory) return null;

  const snapshots = db.prepare(
    'SELECT * FROM position_snapshots WHERE mint_address = ? ORDER BY timestamp DESC LIMIT 20'
  ).all(mintAddress);

  return {
    mint_address: mintAddress,
    entry_price: trajectory.entry_price,
    current_price: trajectory.current_price,
    pnl_pct: trajectory.pnl_pct,
    snapshots: snapshots,
    last_updated: trajectory.last_updated,
  };
}

/**
 * Get latest snapshot
 * @param {string} mintAddress - Token mint address
 * @returns {object|null} Latest snapshot
 */
export async function getLatestSnapshot(mintAddress) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM position_snapshots WHERE mint_address = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(mintAddress);
}

/**
 * Count total snapshots
 * @returns {number} Count
 */
export async function countSnapshots() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as cnt FROM position_snapshots').get();
  return row.cnt;
}

/**
 * Alias for recordSnapshot (test compatibility)
 */
export async function takeSnapshot(positionData) {
  return recordSnapshot(positionData.mint_address || positionData.token_address, positionData);
}

/**
 * Alias for getTrajectoryForRAG (test compatibility)
 */
export async function getTrajectory(mintAddress) {
  return getTrajectoryForRAG(mintAddress);
}

/**
 * Format trajectory snapshots for RAG/context display
 * @param {Array} snapshots - Array of snapshot objects
 * @param {string} [exit_reason] - Optional exit reason
 * @param {number} [exit_pnl_pct] - Optional exit PnL percentage
 * @returns {string} Formatted trajectory string
 */
export function formatTrajectoryForRAG(snapshots, exit_reason, exit_pnl_pct) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return 'No snapshots available for this position.';
  }

  const lines = ['Trajectory (every 5min):'];
  let sellDominant = false;
  for (const s of snapshots) {
    const sign = s.pnl_pct >= 0 ? '+' : '';
    const ratioLabel = s.buy_sell_ratio < 1 ? ' (sell dominant)' : (s.buy_sell_ratio > 1 ? ' (buy dominant)' : '');
    lines.push(`  [${s.minutes_since_entry}min] ${sign}${s.pnl_pct}% | holders: ${s.holder_count} | liq: $${(s.liquidity_usd / 1000).toFixed(0)}k | buy/sell: ${s.buy_sell_ratio}x${ratioLabel}`);
    if (s.buy_sell_ratio < 1) sellDominant = true;
  }

  if (exit_reason && exit_pnl_pct !== undefined) {
    const sign = exit_pnl_pct >= 0 ? '+' : '';
    lines.push(`Exit: ${exit_reason} at ${sign}${exit_pnl_pct}%`);
  }

  const result = lines.join('\n');
  return result;
}