// ─── analysis/bundler-check.js ──────────────────────────────────────────────
// Bundled launch + sniper check via GMGN (replaces Helius largest-accounts heuristic).
//
// GMGN sources:
//   - GMGN token holders list (has wallet_tag_v2 = "bundler" / "sniper" tags)
//   - GMGN trending has bundler_rate (0-1)
//
// Interface preserved: checkBundledLaunch() / checkMultipleBundled()
// so callers (e.g. core/hard-rules.js) keep working.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../core/logger.js';
import { acquire } from '../core/rate-limiter.js';

const execFileP = promisify(execFile);
const log = createLogger('bundler-check');

const TIMEOUT_MS = 10_000;

async function runGmgn(args) {
  await acquire('gmgn');
  const { stdout } = await execFileP(process.env.GMGN_CLI_PATH || '/home/elzanom/.npm-global/bin/gmgn-cli', args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY },
  });
  return JSON.parse(stdout);
}

/**
 * @typedef {object} BundledLaunchResult
 * @property {string}  token_address
 * @property {boolean} bundled
 * @property {number}  bundle_pct
 * @property {number}  sniper_pct
 * @property {number}  top_wallet_concentration
 * @property {number}  scanned_accounts
 * @property {number}  fetched_at
 */

/**
 * Check if a token launch was bundled or sniped.
 * @param {string} tokenAddress
 * @returns {Promise<BundledLaunchResult>}
 */
export async function checkBundledLaunch(tokenAddress) {
  try {
    const data = await runGmgn([
      'token', 'holders',
      '--chain', 'sol',
      '--address', tokenAddress,
      '--raw',
    ]);
    const list = data?.list || [];

    if (list.length === 0) {
      return {
        token_address: tokenAddress,
        bundled: false, bundle_pct: 0, sniper_pct: 0,
        top_wallet_concentration: 0, scanned_accounts: 0,
        fetched_at: Date.now(),
      };
    }

    // Count wallets tagged as bundler or sniper
    let bundlerCount = 0, sniperCount = 0;
    let bundlerUsd = 0, sniperUsd = 0;
    let totalUsd = 0;
    for (const h of list) {
      const tags = [h.wallet_tag_v2, h.addr_type_str].filter(Boolean);
      const usd = h.usd_value ? parseFloat(h.usd_value) : 0;
      totalUsd += usd;
      if (tags.some(t => /bundler/i.test(t))) {
        bundlerCount++;
        bundlerUsd += usd;
      }
      if (tags.some(t => /sniper/i.test(t))) {
        sniperCount++;
        sniperUsd += usd;
      }
    }

    const bundlePct = totalUsd > 0 ? (bundlerUsd / totalUsd) * 100 : 0;
    const sniperPct = totalUsd > 0 ? (sniperUsd / totalUsd) * 100 : 0;
    const topConcentration = list[0]?.amount_percentage
      ? parseFloat(list[0].amount_percentage) * 100
      : 0;

    return {
      token_address: tokenAddress,
      // Threshold: > 20% bundled = flagged
      bundled: bundlePct > 20,
      bundle_pct: bundlePct,
      sniper_pct: sniperPct,
      top_wallet_concentration: topConcentration,
      scanned_accounts: list.length,
      fetched_at: Date.now(),
    };
  } catch (err) {
    log.error(`[bundler-check] GMGN error for ${tokenAddress}: ${err.message}`);
    return {
      token_address: tokenAddress,
      bundled: false, bundle_pct: 0, sniper_pct: 0,
      top_wallet_concentration: 0, scanned_accounts: 0,
      fetched_at: Date.now(),
      error: err.message,
    };
  }
}

export async function checkMultipleBundled(tokenAddresses) {
  const results = await Promise.all(tokenAddresses.map(addr => checkBundledLaunch(addr)));
  return results;
}
