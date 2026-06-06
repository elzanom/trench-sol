import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkEmergencyTriggers } from './decision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── In-memory position store ─────────────────────────────────────────────────

const _positions = new Map(); // mint_address → position

// ─── Position Manager ─────────────────────────────────────────────────────────

/**
 * @typedef {Object} Position
 * @property {string} token_address
 * @property {string} side - 'buy' | 'sell'
 * @property {number} amount_sol
 * @property {number} entry_price
 * @property {number} entry_time
 * @property {number} stop_loss_pct
 * @property {number} take_profit_pct
 * @property {number} pnl_sol
 * @property {string} signal
 * @property {number} sub_wallet_index
 */

/**
 * Check if a position should be exited due to hard stop loss
 * Pure function — NO LLM.
 * @param {Position} position
 * @param {number} currentPrice
 * @returns {{ triggered: boolean, reason: string }}
 */
export function checkHardStopLoss(position, currentPrice) {
  const config = loadConfig();
  const hardStopLossPct = position.hard_stop_loss_pct
    ?? config.hard_rules?.hard_stop_loss_pct
    ?? -20;

  // Default side to 'buy' if not specified
  const side = position.side || 'buy';

  if (side !== 'buy') {
    return { triggered: false, reason: 'not a buy position' };
  }

  // Support both entry_price and entry_price_usd
  const entryPrice = position.entry_price ?? position.entry_price_usd;

  if (!entryPrice || !currentPrice) {
    return { triggered: false, reason: 'missing price data' };
  }

  const priceChangePct = ((currentPrice - entryPrice) / entryPrice) * 100;

  if (priceChangePct <= hardStopLossPct) {
    return {
      triggered: true,
      reason: `Hard stop loss triggered — price dropped ${priceChangePct.toFixed(2)}% below entry (limit: ${hardStopLossPct}%)`,
      price_change_pct: priceChangePct,
    };
  }

  return { triggered: false, reason: null, price_change_pct: priceChangePct };
}

/**
 * Determine exit action based on signals and PnL
 * Pure function — NO LLM.
 * @param {object} params
 * @returns {{ action: string, exit_pct: number, reasoning: string }}
 */
export function determineExitAction({ position, currentPrice, signals = {} }) {
  const config = loadConfig();
  const hardStopLossPct = config.hard_rules?.hard_stop_loss_pct ?? -20;
  const takeProfitPct = config.hard_rules?.take_profit_pct ?? 100;

  // Check hard stop loss first
  const stopLossCheck = checkHardStopLoss(position, currentPrice);
  if (stopLossCheck.triggered) {
    return {
      action: 'EXIT_FULL',
      exit_pct: 100,
      reasoning: stopLossCheck.reason,
    };
  }

  // Check take profit
  if (position.side === 'buy' && position.entry_price && currentPrice) {
    const priceChangePct = ((currentPrice - position.entry_price) / position.entry_price) * 100;
    if (priceChangePct >= takeProfitPct) {
      return {
        action: 'EXIT_FULL',
        exit_pct: 100,
        reasoning: `Take profit target reached: +${priceChangePct.toFixed(2)}% (target: ${takeProfitPct}%)`,
      };
    }
  }

  // Check dev wallet activity
  if (signals.dev_wallet_activity === 'selling') {
    return {
      action: 'EXIT_FULL',
      exit_pct: 100,
      reasoning: 'Dev wallet activity indicates potential rug',
    };
  }

  if (signals.liquidity_drain && signals.liquidity_drain < -30) {
    return {
      action: 'EXIT_PARTIAL',
      exit_pct: 50,
      reasoning: `Liquidity drain detected: ${signals.liquidity_drain}%`,
    };
  }

  // Check large wallet movement
  if (signals.large_wallet_movement === true) {
    return {
      action: 'EXIT_PARTIAL',
      exit_pct: 50,
      reasoning: 'Large wallet movement detected',
    };
  }

  // Check if mintable (dev can mint more tokens)
  if (signals.is_mintable === true && signals.dev_selling === true) {
    return {
      action: 'EXIT_FULL',
      exit_pct: 100,
      reasoning: 'Token is mintable and dev selling — rug suspected',
    };
  }

  // No exit signal
  return {
    action: 'HOLD',
    exit_pct: 0,
    reasoning: 'No exit conditions met',
  };
}

/**
 * Adjust stop loss (trailing stop logic)
 * @param {Position} position
 * @param {number} currentPrice
 * @param {number} newSlPct
 * @returns {{ position: Position, adjusted: boolean }}
 */
export function adjustStopLoss(position, currentPrice, newSlPct) {
  const config = loadConfig();
  const hardStopLossPct = config.hard_rules?.hard_stop_loss_pct ?? -20;

  // Can't go below hard stop
  if (newSlPct > hardStopLossPct) {
    newSlPct = hardStopLossPct;
  }

  // Only adjust if it's a tighter stop (better for trader)
  if (position.stop_loss_pct && newSlPct <= position.stop_loss_pct) {
    return { position, adjusted: false };
  }

  // For trailing: if new stop would lock in more profit, allow it
  const entryToCurrent = position.entry_price
    ? ((currentPrice - position.entry_price) / position.entry_price) * 100
    : 0;

  // Stop loss must be below current price change
  if (newSlPct < entryToCurrent - 5) {
    // Allow trailing stop if it's at least 5% below current profit
    const updated = { ...position, stop_loss_pct: newSlPct };
    return { position: updated, adjusted: true };
  }

  return { position, adjusted: false };
}

/**
 * Validate exit percentage
 * @param {string} action
 * @param {number} exitPct
 * @returns {{ valid: boolean, clamped_pct: number }}
 */
export function validateExitPct(action, exitPct) {
  if (action === 'HOLD') {
    return { valid: true, clamped_pct: 0 };
  }

  if (action === 'EXIT_FULL') {
    return { valid: true, clamped_pct: 100 };
  }

  if (action === 'EXIT_PARTIAL') {
    if (exitPct < 10 || exitPct > 90) {
      return { valid: false, clamped_pct: 50 }; // default to 50%
    }
    return { valid: true, clamped_pct: Math.round(exitPct) };
  }

  return { valid: false, clamped_pct: 0 };
}

/**
 * Log position action (for audit trail)
 * @param {string} action
 * @param {object} position
 * @param {object} extra
 */
export function logPositionAction(action, position, extra = {}) {
  const actionStr = action.padEnd(12);
  const symbol = position.symbol || position.token_address;
  const adjStr = extra.adjusted ? ` [SL adjusted to ${position.stop_loss_pct}%]` : '';

  console.log(`[position-manager] ${symbol} — ${actionStr}${adjStr}`);
}

/**
 * Evaluate a position — should it be exited?
 * @param {object} position - Position to evaluate
 * @param {number} currentPrice - Current token price
 * @param {object} signals - On-chain signals
 * @returns {{ action: string, reason: string }}
 */
export function evaluatePosition(position, currentPrice, signals = {}) {
  // Check hard stop loss first
  const stopResult = checkHardStopLoss(position, currentPrice);
  if (stopResult.triggered) {
    return { action: 'EXIT_FULL', reason: stopResult.reason };
  }

  // Check emergency triggers
  const emergencyResult = checkEmergencyTriggers(position, signals);
  if (emergencyResult.triggered) {
    return { action: 'EXIT_FULL', reason: emergencyResult.reason };
  }

  // Determine exit based on signals and PnL
  const exitResult = determineExitAction({ position, currentPrice, signals });
  return { action: exitResult.action, reason: exitResult.reason };
}

// Re-export checkEmergencyTriggers for test compatibility
export { checkEmergencyTriggers } from './decision.js';
