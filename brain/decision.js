import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Conviction Tiers ───────────────────────────────────────────────────────────

const convictionTiers = [
  { tier: 'high', min_confidence: 0.9, max_multiplier: 2.0 },
  { tier: 'medium', min_confidence: 0.7, max_multiplier: 1.5 },
  { tier: 'low', min_confidence: 0.5, max_multiplier: 0.5 },
];

/**
 * Map confidence score to conviction tier
 * @param {number} confidence - Confidence score (0-1)
 * @param {Array} [tiers] - Optional tiers array to override defaults
 */
export function mapConfidenceToTier(confidence, tiers) {
  const convictionTiers = tiers || [
    { tier: 'high', min_confidence: 0.9, max_multiplier: 2.0 },
    { tier: 'medium', min_confidence: 0.7, max_multiplier: 1.5 },
    { tier: 'low', min_confidence: 0.5, max_multiplier: 0.5 },
  ];

  for (const tier of convictionTiers) {
    if (confidence >= tier.min_confidence) {
      return tier;
    }
  }
  // Below lowest tier threshold — return a special 'none' tier
  return { tier: 'none', min_confidence: 0, max_multiplier: 0 };
}

/**
 * Enforce tier-based multiplier cap
 */
export function enforceTierMultiplier(llmMultiplier, confidence, tiers) {
  const tier = mapConfidenceToTier(confidence, tiers);
  const capped = Math.min(llmMultiplier, tier.max_multiplier);
  return {
    finalMultiplier: Math.round(capped * 100) / 100,
    tier: tier.tier,
    capped: llmMultiplier > tier.max_multiplier,
  };
}

// ─── Decision Engine ────────────────────────────────────────────────────────────

/**
 * Make a trading decision based on feeds, LLM signal, and hard rules
 */
export async function makeTradeDecision(tokenData, llmSignal, hardRulesResult) {
  const config = loadConfig();

  // If hard rules fail, reject immediately
  if (!hardRulesResult.passed) {
    return {
      decision: 'REJECT',
      reason: hardRulesResult.failures.join('; '),
      confidence: 0,
      multiplier: 0,
    };
  }

  // If no LLM signal, skip
  if (!llmSignal || !llmSignal.signal) {
    return {
      decision: 'SKIP',
      reason: 'No LLM signal',
      confidence: 0,
      multiplier: 0,
    };
  }

  const { confidence = 0.5, conviction = 'medium', suggested_multiplier = 1.0 } = llmSignal;

  // Apply conviction tier multiplier
  const { finalMultiplier, tier } = enforceTierMultiplier(suggested_multiplier, confidence);

  // Decision thresholds
  const actionThreshold = config.brain?.action_threshold || 0.6;
  const minConfidence = config.brain?.min_confidence || 0.5;

  if (confidence < minConfidence) {
    return {
      decision: 'REJECT',
      reason: `Confidence ${confidence} below minimum ${minConfidence}`,
      confidence,
      multiplier: finalMultiplier,
      tier,
    };
  }

  const signal强度 = llmSignal.signal === 'STRONG_BUY' ? 1.0
    : llmSignal.signal === 'BUY' ? 0.8
    : llmSignal.signal === 'NEUTRAL' ? 0.5
    : llmSignal.signal === 'SELL' ? 0.3 : 0.1;

  const combinedScore = signal强度 * confidence;

  if (combinedScore >= actionThreshold) {
    return {
      decision: 'BUY',
      reason: `Signal: ${llmSignal.signal}, Confidence: ${confidence}, Conviction: ${tier}`,
      confidence,
      multiplier: finalMultiplier,
      tier,
    };
  }

  return {
    decision: 'SKIP',
    reason: `Combined score ${combinedScore.toFixed(2)} below threshold ${actionThreshold}`,
    confidence,
    multiplier: finalMultiplier,
    tier,
  };
}

// ─── Entry Decision ────────────────────────────────────────────────────────────

/**
 * Make entry decision — evaluates whether to enter a new position
 * @param {object} tokenData - Token data
 * @param {object} context - Context { dailyStats, activePositions, ... }
 * @returns {object} { decision: string, reasoning: string }
 */
export async function makeEntryDecision(tokenData, context = {}) {
  const config = loadConfig();

  // Circuit breaker check
  if (context.dailyStats?.is_tripped) {
    return {
      decision: 'SKIP',
      reasoning: `Circuit breaker — ${context.dailyStats.reason || 'daily limit exceeded'}`,
      tier: 'none',
    };
  }

  // Max concurrent positions check
  const maxConcurrent = config.position?.max_concurrent ?? 3;
  const activeCount = context.activePositions?.length ?? 0;
  if (activeCount >= maxConcurrent) {
    return {
      decision: 'SKIP',
      reasoning: 'Max concurrent positions reached',
      tier: 'none',
    };
  }

  // No token data means no trade
  if (!tokenData || !tokenData.address) {
    return {
      decision: 'SKIP',
      reasoning: 'No token data',
      tier: 'none',
    };
  }

  // Default: let the LLM decide
  return {
    decision: 'PROCEED',
    reasoning: 'All pre-checks passed',
  };
}

/**
 * Generate deterministic paper-mode LLM signal based on token quality.
 * Used when paper_trading=true and no real LLM is configured.
 * Score 0-1 from: liquidity (0.3 max), holders (0.25), dev_wallet (0.25), market_cap (0.2).
 *   ≥0.7 = STRONG_BUY (high), 0.5-0.7 = BUY (med), 0.3-0.5 = NEUTRAL (low), <0.3 = SELL.
 * @param {object} tokenData - Token data with on-chain enrichment
 * @returns {object} { signal, confidence, conviction, suggested_multiplier }
 */
export function generatePaperSignal(tokenData = {}) {
  const liquidity = tokenData.liquidity_usd || 0;
  const holders = tokenData.holder_count || 0;
  const devPct = tokenData.dev_wallet_pct ?? 100;
  const mc = tokenData.market_cap || 0;
  const tags = [];
  let score = 0;
  if (liquidity >= 10000) { score += 0.3; tags.push('liq_strong'); }
  else if (liquidity >= 5000) { score += 0.2; tags.push('liq_mid'); }
  else if (liquidity >= 2000) { score += 0.1; tags.push('liq_weak'); }
  if (holders >= 200) { score += 0.25; tags.push('holders_dense'); }
  else if (holders >= 100) { score += 0.15; tags.push('holders_mid'); }
  else if (holders >= 50) { score += 0.05; tags.push('holders_sparse'); }
  if (devPct < 3) { score += 0.25; tags.push('dev_low'); }
  else if (devPct < 7) { score += 0.15; tags.push('dev_mid'); }
  else if (devPct < 10) { score += 0.05; tags.push('dev_acceptable'); }
  else tags.push('dev_high');
  if (mc >= 100000) { score += 0.2; tags.push('mc_large'); }
  else if (mc >= 50000) { score += 0.15; tags.push('mc_mid'); }
  else if (mc >= 10000) { score += 0.1; tags.push('mc_small'); }
  score = Math.min(1, score);
  // Tier tag based on final score
  let tier_tag = 'tier_skip';
  if (score >= 0.7) tier_tag = 'tier_strong';
  else if (score >= 0.5) tier_tag = 'tier_medium';
  else if (score >= 0.3) tier_tag = 'tier_weak';
  tags.push(tier_tag);

  if (score >= 0.7) return { signal: 'STRONG_BUY', confidence: 0.85, conviction: 'high', suggested_multiplier: 1.5, signal_tags: tags };
  if (score >= 0.5) return { signal: 'BUY', confidence: 0.7, conviction: 'medium', suggested_multiplier: 1.0, signal_tags: tags };
  if (score >= 0.3) return { signal: 'NEUTRAL', confidence: 0.5, conviction: 'low', suggested_multiplier: 0.5, signal_tags: tags };
  return { signal: 'SELL', confidence: 0.3, conviction: 'low', suggested_multiplier: 0, signal_tags: tags };
}

// ─── Emergency Triggers ────────────────────────────────────────────────────────

/**
 * Check emergency/exit triggers based on on-chain signals
 * @param {object} position - Position to check
 * @param {object} signals - On-chain signals { dev_wallet_activity, liquidity_drain, large_wallet_movement, is_mintable, dev_selling }
 * @returns {object} { triggered: boolean, reason: string }
 */
export function checkEmergencyTriggers(position, signals = {}) {
  const { dev_wallet_activity, liquidity_drain, large_wallet_movement, is_mintable, dev_selling } = signals;

  // Dev wallet selling
  if (dev_wallet_activity === 'selling' || dev_wallet_activity === 'transferred_out') {
    return {
      triggered: true,
      reason: `dev_wallet=${dev_wallet_activity} — rug_suspected`,
    };
  }

  // Large wallet movement
  if (large_wallet_movement === true) {
    return {
      triggered: true,
      reason: 'large_wallet_movement=true — potential exit',
    };
  }

  // Liquidity drain
  if (typeof signals.liquidity_delta_pct === 'number' && signals.liquidity_delta_pct < -30) {
    return {
      triggered: true,
      reason: `liquidity_drain=${signals.liquidity_delta_pct}% — potential rug`,
    };
  }

  // Mintable + dev selling = rug
  if (is_mintable === true && dev_selling === true) {
    return {
      triggered: true,
      reason: 'Token is mintable and dev is selling — rug confirmed',
    };
  }

  return { triggered: false, reason: null };
}