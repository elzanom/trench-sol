import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const configPath = process.env.__TEST_CONFIG_PATH
    || path.join(__dirname, '..', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

// ─── Hard Rules ────────────────────────────────────────────────────────────────

/**
 * Check liquidity against hard rules
 */
export async function checkLiquidity(token) {
  const config = loadConfig();
  const rules = config.hard_rules || {};

  if (token.liquidity_usd === undefined || token.liquidity_usd === null) {
    return { pass: false, reason: 'liquidity_usd missing' };
  }

  if (rules.min_liquidity_usd && token.liquidity_usd < rules.min_liquidity_usd) {
    return { pass: false, reason: `liquidity_usd=${token.liquidity_usd} < min_liquidity_usd=${rules.min_liquidity_usd}` };
  }

  if (rules.max_liquidity_usd && token.liquidity_usd > rules.max_liquidity_usd) {
    return { pass: false, reason: `liquidity_usd=${token.liquidity_usd} > max_liquidity_usd=${rules.max_liquidity_usd}` };
  }

  return { pass: true, reason: null };
}

/**
 * Check holder count against hard rules
 */
export async function checkHolders(token) {
  const config = loadConfig();
  const rules = config.hard_rules || {};

  if (token.holder_count === undefined || token.holder_count === null) {
    return { pass: false, reason: 'holder_count missing' };
  }

  if (rules.min_holders && token.holder_count < rules.min_holders) {
    return { pass: false, reason: `holder_count=${token.holder_count} < min_holders=${rules.min_holders}` };
  }

  return { pass: true, reason: null };
}

/**
 * Check dev wallet percentage against hard rules
 */
export async function checkDevWallet(token) {
  const config = loadConfig();
  const rules = config.hard_rules || {};

  if (token.dev_wallet_pct === undefined || token.dev_wallet_pct === null) {
    return { pass: false, reason: 'dev_wallet_pct missing' };
  }

  if (rules.max_dev_wallet_pct && token.dev_wallet_pct > rules.max_dev_wallet_pct) {
    return { pass: false, reason: `dev_wallet_pct=${token.dev_wallet_pct.toFixed(1)}% > max_dev_wallet_pct=${rules.max_dev_wallet_pct}%` };
  }

  return { pass: true, reason: null };
}

/**
 * Check mint and freeze authorities
 */
export async function checkMintFreeze(token) {
  if (token.is_mintable === true) {
    return { pass: false, reason: 'token is mintable (dev can inflate supply)' };
  }

  if (token.is_freezable === true) {
    return { pass: false, reason: 'token is freezable (dev can freeze all accounts)' };
  }

  return { pass: true, reason: null };
}

/**
 * Check circuit breaker status (daily loss + trade count)
 * Context values override module state for testability
 */
export async function checkCircuitBreaker(context = {}) {
  const config = loadConfig();
  const rules = config.hard_rules || {};

  const maxDailyLossSol = rules.max_daily_loss_sol ?? 0.2;
  const maxDailyTrades = rules.max_daily_trades ?? 20;

  const dailyLossSol = context.dailyLossSol ?? 0;
  const dailyTradeCount = context.dailyTradeCount ?? 0;

  // Check daily loss limit
  if (dailyLossSol >= maxDailyLossSol) {
    return {
      pass: false,
      reason: `circuit breaker TRIPPED — dailyLossSol=${dailyLossSol} >= ${maxDailyLossSol}`,
    };
  }

  // Check daily trade count limit
  if (dailyTradeCount >= maxDailyTrades) {
    return {
      pass: false,
      reason: `circuit breaker TRIPPED — dailyTradeCount=${dailyTradeCount} >= ${maxDailyTrades}`,
    };
  }

  return { pass: true, reason: null };
}

/**
 * Check cooldown (consecutive losses)
 */
export async function checkCooldown(consecutiveLosses, context = {}) {
  const config = loadConfig();
  const rules = config.hard_rules || {};
  const cooldownMs = (rules.cooldown_minutes ?? 60) * 60 * 1000;

  if (!consecutiveLosses || consecutiveLosses === 0) {
    return { pass: true, reason: null };
  }

  const cooldownAfter = rules.cooldown_after_consecutive_losses ?? 3;

  if (consecutiveLosses < cooldownAfter) {
    return { pass: true, reason: null };
  }

  // At or above threshold — if no lastLossTime, fail-closed (can't verify cooldown elapsed)
  const lastLossTime = context.lastLossTime;
  if (!lastLossTime) {
    return { pass: false, reason: `cooldown active — consecutiveLosses=${consecutiveLosses} (no lastLossTime recorded)` };
  }

  // Check if cooldown period has elapsed
  const elapsed = Date.now() - lastLossTime;
  if (elapsed < cooldownMs) {
    return { pass: false, reason: `cooldown active — consecutiveLosses=${consecutiveLosses}, cooldown not elapsed (${Math.round(elapsed / 60000)}m < ${rules.cooldown_minutes ?? 60}m)` };
  }

  return { pass: true, reason: null };
}

/**
 * Check concurrent positions against max
 */
export async function checkConcurrentPositions(activeCount) {
  const config = loadConfig();
  const maxConcurrent = config.position?.max_concurrent ?? 3;

  if (activeCount >= maxConcurrent) {
    return { pass: false, reason: `activeCount=${activeCount} >= max_concurrent=${maxConcurrent}` };
  }

  return { pass: true, reason: null };
}

/**
 * Check total exposure against max
 */
export async function checkMaxExposure(currentExposureSol) {
  const config = loadConfig();
  const maxExposure = config.position?.max_total_exposure_sol ?? 0.5;

  if (currentExposureSol >= maxExposure) {
    return { pass: false, reason: `total exposure ${currentExposureSol} >= max_total_exposure_sol=${maxExposure}` };
  }

  return { pass: true, reason: null };
}

/**
 * Run all hard rules checks on a token
 */
export async function runAllChecks(tokenData, context = {}) {
  const results = await Promise.all([
    checkLiquidity(tokenData),
    checkHolders(tokenData),
    checkDevWallet(tokenData),
    checkMintFreeze(tokenData),
  ]);

  const failures = results.filter(r => !r.pass).map(r => r.reason);

  const cbCheck = await checkCircuitBreaker(context);
  if (!cbCheck.pass) {
    failures.push(`Circuit breaker: ${cbCheck.reason}`);
  }

  const cooldownCheck = await checkCooldown(context.consecutiveLosses ?? 0, context);
  if (!cooldownCheck.pass) {
    failures.push(`Cooldown: ${cooldownCheck.reason}`);
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Check bundled launch on-chain
 */
export async function checkBundledLaunchOnChain(tokenAddress) {
  const config = loadConfig();
  const rpcUrl = config.wallet?.rpc_endpoint || 'https://mainnet.helius-rpc.com';
  const apiKey = process.env.HELIUS_API_KEY || '';

  try {
    const { Connection, PublicKey } = require('@solana/web3.js');
    const connection = new Connection(rpcUrl + apiKey, 'confirmed');

    const mint = new PublicKey(tokenAddress);
    const largestAccounts = await connection.getTokenLargestAccounts(mint);

    if (!largestAccounts.value.length) {
      return { bundled: false, reason: null };
    }

    const topHolderPct = parseFloat(largestAccounts.value[0].amount) / 1e9;

    if (topHolderPct > 30) {
      return { bundled: true, reason: `top holder owns ${topHolderPct.toFixed(1)}% (>30% suspicious)` };
    }

    return { bundled: false, reason: null };
  } catch (err) {
    return { bundled: false, reason: `on-chain check failed: ${err.message}` };
  }
}