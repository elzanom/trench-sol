// ─── analysis/rugcheck.js ──────────────────────────────────────────────────
// Rug pull check via GMGN token security (replaces rugcheck.xyz).
// GMGN has: is_honeypot, is_blacklist, renounced_mint, renounced_freeze_account,
//           buy_tax, sell_tax, can_sell, top_10_holder_rate, lockInfo.
//
// Interface preserved: checkRugscore() / checkMultipleRugscores()
// so callers (e.g. core/hard-rules.js, brain/decision.js) keep working.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../core/logger.js';
import { acquire } from '../core/rate-limiter.js';

const execFileP = promisify(execFile);
const log = createLogger('rugcheck');

const TIMEOUT_MS = 10_000;

async function runGmgn(args) {
  await acquire('gmgn');
  const { stdout } = await execFileP(process.env.GMGN_CLI_PATH || '/home/elzanom/.npm-global/bin/gmgn-cli', args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY },
  });
  return JSON.parse(stdout);
}

/**
 * @typedef {object} RugcheckResult
 * @property {string}  token_address
 * @property {number|null} score  — 0-100 (higher = safer). Derived from rug signals.
 * @property {string}  risk_level — "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN"
 * @property {string[]} tags
 * @property {boolean} rugged
 * @property {boolean} honeypot
 * @property {boolean} mint_authority_revoked
 * @property {boolean} freeze_authority_revoked
 * @property {number}  buy_tax
 * @property {number}  sell_tax
 * @property {boolean} can_sell
 * @property {number|null} top_10_holder_rate
 * @property {number}  fetched_at
 */

/**
 * Derive a 0-100 safety score from GMGN security fields.
 * Heuristic: 100 = perfectly safe, 0 = definite rug.
 */
function deriveScore(sec) {
  if (!sec) return null;
  let score = 100;
  if (sec.is_honeypot || !sec.can_sell) score -= 60;
  if (sec.is_blacklist) score -= 30;
  if (!sec.renounced_mint) score -= 15;
  if (!sec.renounced_freeze_account) score -= 10;
  if (sec.buy_tax > 5) score -= 10;
  if (sec.sell_tax > 5) score -= 10;
  if (sec.top_10_holder_rate && sec.top_10_holder_rate > 0.6) score -= 10;
  return Math.max(0, score);
}

function deriveRiskLevel(score) {
  if (score == null) return 'UNKNOWN';
  if (score >= 80) return 'LOW';
  if (score >= 60) return 'MEDIUM';
  if (score >= 30) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Check rug risk for a token using GMGN.
 * @param {string} tokenAddress
 * @returns {Promise<RugcheckResult>}
 */
export async function checkRugscore(tokenAddress) {
  try {
    const data = await runGmgn([
      'token', 'security',
      '--chain', 'sol',
      '--address', tokenAddress,
      '--raw',
    ]);
    if (!data || !data.address) {
      return {
        token_address: tokenAddress,
        score: null, risk_level: 'UNKNOWN', tags: [],
        rugged: false, honeypot: false,
        mint_authority_revoked: false, freeze_authority_revoked: false,
        buy_tax: 0, sell_tax: 0, can_sell: true, top_10_holder_rate: null,
        fetched_at: Date.now(),
        error: 'GMGN: no security data returned',
      };
    }

    const isHoneypot = data.is_honeypot === 1 || data.honeypot === 1;
    const isBlacklist = data.is_blacklist === 1 || data.blacklist === 1;
    const renouncedMint = data.renounced_mint === 1;
    const renouncedFreeze = data.renounced_freeze_account === 1;
    const canSell = data.can_sell === 1;
    const buyTax = data.buy_tax ? parseFloat(data.buy_tax) : 0;
    const sellTax = data.sell_tax ? parseFloat(data.sell_tax) : 0;
    const top10Rate = data.top_10_holder_rate ? parseFloat(data.top_10_holder_rate) : null;

    const sec = {
      is_honeypot: isHoneypot,
      is_blacklist: isBlacklist,
      renounced_mint: renouncedMint,
      renounced_freeze_account: renouncedFreeze,
      can_sell: canSell,
      buy_tax: buyTax,
      sell_tax: sellTax,
      top_10_holder_rate: top10Rate,
    };
    const score = deriveScore(sec);
    const riskLevel = deriveRiskLevel(score);

    const tags = [];
    if (isHoneypot) tags.push('honeypot');
    if (isBlacklist) tags.push('blacklist');
    if (!renouncedMint) tags.push('mint_active');
    if (!renouncedFreeze) tags.push('freeze_active');
    if (buyTax > 5) tags.push('high_buy_tax');
    if (sellTax > 5) tags.push('high_sell_tax');
    if (top10Rate && top10Rate > 0.6) tags.push('top_10_concentrated');

    return {
      token_address: tokenAddress,
      score,
      risk_level: riskLevel,
      tags,
      rugged: isHoneypot || (!canSell && data.can_sell !== null),
      honeypot: isHoneypot,
      mint_authority_revoked: renouncedMint,
      freeze_authority_revoked: renouncedFreeze,
      buy_tax: buyTax,
      sell_tax: sellTax,
      can_sell: canSell,
      top_10_holder_rate: top10Rate,
      fetched_at: Date.now(),
    };
  } catch (err) {
    log.error(`[rugcheck] GMGN error for ${tokenAddress}: ${err.message}`);
    return {
      token_address: tokenAddress,
      score: null, risk_level: 'ERROR', tags: [],
      rugged: false, honeypot: false,
      mint_authority_revoked: false, freeze_authority_revoked: false,
      buy_tax: 0, sell_tax: 0, can_sell: true, top_10_holder_rate: null,
      fetched_at: Date.now(),
      error: err.message,
    };
  }
}

export async function checkMultipleRugscores(tokenAddresses) {
  const results = await Promise.all(tokenAddresses.map(addr => checkRugscore(addr)));
  return results;
}
