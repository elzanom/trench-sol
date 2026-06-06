import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadConfig() {
  // Allow test injection via path env var
  if (process.env.__TEST_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(process.env.__TEST_CONFIG_PATH, 'utf8'));
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── In-memory position store ─────────────────────────────────────────────────

const positions = new Map();

// ─── SQLite helpers ────────────────────────────────────────────────────────────

function getDbPath() {
  const config = loadConfig();
  return config.memory?.ledger?.db_path || path.join(__dirname, '..', 'memory', 'db', 'trades.db');
}

function getDb() {
  const { initializeDb, getDbInstance } = require('../memory/ledger.js');
  try {
    initializeDb();
    return getDbInstance();
  } catch {
    return null;
  }
}

// ─── Position interface ────────────────────────────────────────────────────────

/**
 * @typedef {Object} Position
 * @property {string} token_address
 * @property {string} side - 'buy' or 'sell'
 * @property {number} amount_sol
 * @property {number} entry_price
 * @property {number} entry_time
 * @property {number} stop_loss_pct
 * @property {number} take_profit_pct
 * @property {number} pnl_sol
 * @property {string} signal
 * @property {number} sub_wallet_index
 */

// ─── Load existing positions from DB ────────────────────────────────────────

/**
 * Load positions from database (re-runs DB query to repopulate in-memory map)
 */
export function loadPositionsFromDb() {
  positions.clear();
  loadExistingPositions();
}

loadExistingPositions();

function loadExistingPositions() {
  const db = getDb();
  if (!db) return;

  try {
    // Get positions from trades table where still open
    const trades = db.prepare(`
      SELECT * FROM trades ORDER BY timestamp DESC
    `).all();

    // Simple: just track by mint_address, keep most recent
    for (const trade of trades) {
      if (!positions.has(trade.mint_address)) {
        positions.set(trade.mint_address, {
          token_address: trade.mint_address,
          side: trade.side,
          amount_sol: trade.amount_sol,
          entry_price: trade.entry_price || trade.price,
          entry_time: trade.timestamp,
          stop_loss_pct: null,
          take_profit_pct: null,
          pnl_sol: trade.pnl_sol || 0,
          signal: trade.signal,
          sub_wallet_index: 0,
        });
      }
    }

    console.log(`[position] Loaded ${positions.size} active position(s) from DB`);
  } catch (err) {
    console.warn(`[position] Failed to load positions from DB: ${err.message}`);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Open a new position
 */
export async function openPosition(data) {
  const id = require('crypto').randomUUID();

  const position = {
  id,
  token_address: data.mint_address || data.token_address,
  symbol: data.symbol || null,
  side: data.side || 'buy',  // 'buy' for long positions, 'sell' for shorts
    amount_sol: data.amount_sol,
    entry_price: data.entry_price ?? data.entry_price_usd ?? null,
    entry_price_usd: data.entry_price_usd ?? null,
    entry_time: Date.now(),
    stop_loss_pct: data.stop_loss_pct ?? data.hard_stop_loss_pct ?? null,
    take_profit_pct: data.take_profit_pct || null,
    pnl_sol: 0,
    signal: data.signal || null,
    sub_wallet_index: data.sub_wallet_index ?? 0,
    hard_stop_loss_pct: data.hard_stop_loss_pct ?? null,
    source: data.source ?? null,
    feed_source: data.feed_source ?? null,
    entry_reasoning: data.entry_reasoning || null,
    llm_confidence: data.llm_confidence ?? null,
    signal_tags: data.signal_tags || [],
    status: 'open',
  };

  positions.set(position.token_address, position);

  return position;
}

/**
 * Close a position
 */
export async function closePosition(mintAddress) {
  const position = positions.get(mintAddress);

  if (!position) {
    throw new Error(`Position not found for ${mintAddress}`);
  }

  const holdDurationMinutes = (Date.now() - position.entry_time) / 60000;

  positions.delete(mintAddress);

  return {
    ...position,
    hold_duration_minutes: holdDurationMinutes,
    exit_time: Date.now(),
  };
}

/**
 * Get all active positions
 */
export async function getActivePositions() {
  return Array.from(positions.values());
}

/**
 * Update stop loss and take profit for a position
 */
export async function updatePositionTPSL(mintAddress, newSlPct, newTpPct) {
  const position = positions.get(mintAddress);

  if (!position) {
    throw new Error(`Position not found for ${mintAddress}`);
  }

  const config = loadConfig();
  const hardStopLossPct = config.tp_sl?.hard_stop_loss_pct ?? -20;

  // Clamp new stop loss: use MORE negative value (tighter stop)
  position.stop_loss_pct = Math.min(newSlPct, hardStopLossPct);
  position.take_profit_pct = newTpPct ?? position.take_profit_pct;

  return position;
}

/**
 * Get position count
 */
export async function getPositionCount() {
  return positions.size;
}

/**
 * Reset positions store for testing.
 */
export function resetPositions() {
  positions.clear();
}

/**
 * Clear all positions (also resets internal state)
 */
export function clearAllPositions() {
  positions.clear();
}

/**
 * Get position by mint address
 */
export async function getPosition(mintAddress) {
  return positions.get(mintAddress) || null;
}