// ─── execution/paper.js ─────────────────────────────────────────────────────────
// Paper trading mock executor — drop-in replacement for jupiter.js when
// config.agent.paper_trading = true.
//
// Interface IDENTICAL to execution/jupiter.js (same function signatures).
// Behavior: fetch live price from Birdeye (fallback DexScreener), simulate
// realistic slippage, return mock txHash. NO actual wallet transactions.
//
// Spec: section 17 of solana-trench-agent-spec.md

import { createLogger } from '../core/logger.js';
import { acquire, resetAll } from '../core/rate-limiter.js';

const log = createLogger('paper');

// ─── Constants ─────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── Slippage Simulation ───────────────────────────────────────────────────────

/**
 * Simulate realistic slippage based on liquidity tier.
 * Smaller liquidity = larger slippage.
 *
 * @param {number} liquidityUsd
 * @returns {number} slippagePct between 0.5 and 5.0
 */
export function simulateSlippage(liquidityUsd) {
  if (liquidityUsd > 100_000) return 0.5 + Math.random() * 0.5;   // 0.5% - 1.0%
  if (liquidityUsd >  50_000) return 1.0 + Math.random() * 1.0;   // 1.0% - 2.0%
  if (liquidityUsd >  10_000) return 1.5 + Math.random() * 1.5;   // 1.5% - 3.0%
  return                       2.0 + Math.random() * 3.0;          // 2.0% - 5.0%
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function generateTxHash() {
  return `PAPER_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function isValidPrice(p) {
  return typeof p === 'number' && p > 0 && Number.isFinite(p);
}

function formatNum(n, decimals = 8) {
  return n.toFixed(decimals);
}

// ─── Price Fetchers ────────────────────────────────────────────────

import { execFile as _realExecFile } from 'child_process';
import { promisify } from 'util';

const _realExecFileP = promisify(_realExecFile);

// Allow tests to override the execFile function via globalThis.
// In production, falls through to the real child_process.execFile.
// The override is expected to return a Promise directly (no callback).
const _execFileP = (...args) => {
  if (globalThis.__gmgnExecFile) return globalThis.__gmgnExecFile(...args);
  return _realExecFileP(...args);
};

/**
 * Fetch live token price from GMGN (replaces Birdeye primary).
 * GMGN gives price + liquidity in one call.
 * @param {string} mintAddress
 * @returns {Promise<{price: number, source: string, liquidity: number|null}>}
 */
async function fetchGmgnPrice(mintAddress) {
  await acquire('gmgn');
  const { stdout } = await _execFileP(process.env.GMGN_CLI_PATH || '/home/elzanom/.npm-global/bin/gmgn-cli', [
    'token', 'info',
    '--chain', 'sol',
    '--address', mintAddress,
    '--raw',
  ], {
    timeout: TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY },
  });
  const data = JSON.parse(stdout);
  // Price is nested in data.price.price (object form)
  const price = parseFloat(data?.price?.price ?? data?.price);
  if (!isValidPrice(price)) {
    throw new Error('GMGN: invalid or missing price value');
  }
  return {
    price,
    source: 'gmgn',
    liquidity: data?.liquidity ? parseFloat(data.liquidity) : null,
  };
}

/**
 * Fetch live token price from DexScreener (fallback).
 * Also returns liquidity data needed for slippage simulation.
 *
 * @param {string} mintAddress
 * @returns {Promise<{price: number, source: string, liquidity: number}>}
 */
async function fetchDexScreenerPrice(mintAddress) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`DexScreener HTTP ${res.status}`);
  }

  const data = await res.json();
  const pairs = data?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error('DexScreener: no pairs found for token');
  }

  const pair = pairs[0];
  const price = parseFloat(pair.priceUsd);
  if (!isValidPrice(price)) {
    throw new Error('DexScreener: invalid priceUsd in pair');
  }

  return {
    price,
    source: 'dexscreener',
    liquidity: pair.liquidity?.usd || 0,
  };
}

/**
 * Fetch live price, with GMGN primary + DexScreener fallback.
 * All GMGN calls go through rate-limiter.
 *
 * @param {string} mintAddress
 * @returns {Promise<{price: number, source: string, liquidity: number}>}
 */
async function fetchPriceWithFallback(mintAddress) {
  // Primary: GMGN (no rate limit issues, has all data)
  try {
    const result = await fetchGmgnPrice(mintAddress);
    return result;
  } catch (gmgnErr) {
    log.warn(`GMGN price failed (${gmgnErr.message}), falling back to DexScreener`);
  }

  // Fallback: DexScreener (no rate limit, public API)
  return await fetchDexScreenerPrice(mintAddress);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Simulate buying a token with live price + slippage.
 * Drop-in replacement for jupiter.buyToken() in paper mode.
 *
 * @param {Keypair} keypair   — IGNORED in paper mode (no signing/transactions)
 * @param {string}  mintAddress
 * @param {number}  amountSol
 * @param {object}  options   — { symbol, useDevnet, useJito, slippageBps }
 *                              Accepted for interface compat with jupiter.js
 *
 * @returns {Promise<{
 *   txHash: string,
 *   amountIn: number,
 *   amountOut: number,
 *   priceImpactPct: number,
 *   entryPriceUsd: number
 * }>}
 */
export async function buyToken(keypair, mintAddress, amountSol, options = {}) {
  // For interface compat: accept but ignore these
  const {
    symbol = mintAddress.slice(0, 6),
    // useDevnet, useJito, slippageBps ignored in paper mode
  } = options;

  if (!isValidPrice(amountSol) || amountSol <= 0) {
    throw new Error(`Invalid amountSol: ${amountSol}`);
  }

  // Fetch live price
  const { price, source, liquidity } = await fetchPriceWithFallback(mintAddress);

  if (!isValidPrice(price)) {
    throw new Error(`Invalid live price for ${mintAddress}: ${price}`);
  }

  // Simulate slippage
  const liqForSim = typeof liquidity === 'number' ? liquidity : 0;
  const priceImpactPct = simulateSlippage(liqForSim);
  const entryPriceUsd = price * (1 + priceImpactPct / 100);
  const amountOut = amountSol / entryPriceUsd;
  const txHash = generateTxHash();

  log.info(
    `[PAPER] BUY ${symbol} — ${formatNum(amountSol, 3)} SOL → ${Math.floor(amountOut).toLocaleString()} tokens @ $${formatNum(entryPriceUsd)} (slippage: ${priceImpactPct.toFixed(1)}%) [SIMULATED]`
  );

  return {
    txHash,
    amountIn: amountSol,
    amountOut,
    priceImpactPct,
    entryPriceUsd,
  };
}

/**
 * Simulate selling a token with live price + slippage.
 * Drop-in replacement for jupiter.sellToken() in paper mode.
 *
 * @param {Keypair} keypair   — IGNORED in paper mode
 * @param {string}  mintAddress
 * @param {number}  amountPct — percentage of holdings to sell (0-100)
 * @param {object}  options   — { symbol, entryPriceUsd, amountSol, useDevnet, useJito, slippageBps }
 *
 * @returns {Promise<{
 *   txHash: string,
 *   amountIn: number,        // tokens sold
 *   amountOut: number,       // SOL received
 *   solReceived: number,     // alias for amountOut (compat)
 *   exitPriceUsd: number
 * }>}
 */
export async function sellToken(keypair, mintAddress, amountPct = 100, options = {}) {
  // For interface compat + realistic PnL calc
  const {
    symbol = mintAddress.slice(0, 6),
    entryPriceUsd = null,
    amountSol = 0,
  } = options;

  if (!isValidPrice(amountPct) || amountPct < 0 || amountPct > 100) {
    throw new Error(`Invalid amountPct: ${amountPct}`);
  }

  // Fetch live price
  const { price, source, liquidity } = await fetchPriceWithFallback(mintAddress);

  if (!isValidPrice(price)) {
    throw new Error(`Invalid live price for ${mintAddress}: ${price}`);
  }

  // Simulate slippage
  const liqForSim = typeof liquidity === 'number' ? liquidity : 0;
  const priceImpactPct = simulateSlippage(liqForSim);
  const exitPriceUsd = price * (1 - priceImpactPct / 100);

  // Compute tokens sold and SOL received
  //
  // 2026-06-07: BUG 2-latent fix — old formula `tokensHeld = amountSol / entryPriceUsd`
  // treated SOL as USD (unit error). Replaced with ratio-based math that is unitless
  // (USD-per-token / USD-per-token = dimensionless) — works without SOL/USD price feed.
  //
  // If we have entry info (realistic):
  //   priceRatio = exitPriceUsd / entryPriceUsd
  //   solReceived = amountSol × priceRatio × (1 - priceImpactPct/100)
  // If no entry info (fallback):
  //   Treat amountSol as a value-both-ways placeholder; the "loss" is just slippage.
  let amountIn, solReceived;
  if (entryPriceUsd && isValidPrice(entryPriceUsd) && amountSol > 0) {
    const priceRatio = exitPriceUsd / entryPriceUsd;  // unitless
    amountIn = amountSol * (amountPct / 100);  // proportional SOL sold
    solReceived = amountIn * priceRatio * (1 - priceImpactPct / 100);
  } else {
    // Fallback: simulate proportional SOL value
    amountIn = amountSol * (amountPct / 100);
    solReceived = amountIn * (1 - priceImpactPct / 100);
  }

  const txHash = generateTxHash();

  log.info(
    `[PAPER] SELL ${symbol} — exit ${amountPct}% @ $${formatNum(exitPriceUsd)} → ${formatNum(solReceived, 4)} SOL [SIMULATED]`
  );

  return {
    txHash,
    amountIn,
    amountOut: solReceived,
    solReceived,
    exitPriceUsd,
  };
}

// ─── Test Helpers (exported for testability) ───────────────────────────────────

/** Reset internal state. Useful for tests. */
export function resetPaperState() {
  resetAll();
  // Note: _priceCache and other module-level state would go here if added
}
