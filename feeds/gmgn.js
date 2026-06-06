// ─── feeds/gmgn.js ──────────────────────────────────────────────────────────
// Unified GMGN feed — replaces screener.js + pumpfun.js.
// Uses gmgn-cli (https://www.npmjs.com/package/gmgn-cli) for all data sources.
// 4 signal streams polled in rotation:
//   1. market trending --interval 5m   → trending_5m (confidence 0.7)
//   2. trenches --type new_creation    → new_creation (confidence 0.6)
//   3. trenches --type near_graduation → near_graduation (confidence 0.75)
//   4. trenches --type kol_new         → kol_new (confidence 0.9)
//
// Note: trenches response always has 3 keys {completed, new_creation, pump}.
// The --type filter just specifies which one is populated.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../core/logger.js';
import { acquire } from '../core/rate-limiter.js';

const execFileP = promisify(execFile);
const log = createLogger('gmgn-feed');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  if (process.env.__TEST_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(process.env.__TEST_CONFIG_PATH, 'utf8'));
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// Source → confidence score (per user spec)
const SOURCE_CONFIDENCE = {
  kol_new: 0.9,
  smart_money: 0.85, // not a stream here, but reserved for track events
  near_graduation: 0.75,
  trending_5m: 0.7,
  new_creation: 0.6,
};

// ─── 429 Backoff (GMGN rate-limit ban guard) ──────────────────────────
// If gmgn-cli returns HTTP 429 (rate-limited), pause all 4 streams for
// `cooldownMs` ms. Without this, the 30s poll loop extends the ban by
// 5s per hit (capped at 5 min). With this, we honor the reset time.
// 2026-06-06: cooldown raised 5min → 15min (GMGN free-tier bans longer)
let _gmgnCooldownUntil = 0;
const _COOLDOWN_DEFAULT_MS = 15 * 60 * 1000; // 15 min
async function waitForGmgnCooldown() {
  const remaining = _gmgnCooldownUntil - Date.now();
  if (remaining > 0) {
    throw new Error(`GMGN cooldown: ${Math.ceil(remaining / 1000)}s remaining`);
  }
}

// ─── gmgn-cli runner ────────────────────────────────────────────────────────

/**
 * Run a gmgn-cli command and parse the JSON response.
 * @param {string[]} args
 * @returns {Promise<any>}
 */
async function runGmgn(args) {
  // Throttle via rate-limiter (config: rate_limits.gmgn_rps, default 3)
  await acquire('gmgn');
  await waitForGmgnCooldown();
  try {
    const { stdout } = await execFileP('gmgn-cli', args, {
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY },
    });
    // gmgn-cli --raw outputs pure JSON, no pretty-printing
    return JSON.parse(stdout);
  } catch (err) {
    // Detect HTTP 429 from gmgn-cli stderr and trigger cooldown
    const msg = err.message || '';
    if (msg.includes('429') || msg.includes('RATE_LIMIT') || msg.includes('rate limit')) {
      _gmgnCooldownUntil = Date.now() + _COOLDOWN_DEFAULT_MS;
      log.warn('gmgn-feed', `Rate-limited, entering 5min cooldown (until ${new Date(_gmgnCooldownUntil).toISOString()})`);
    }
    throw err;
  }
}

// ─── Normalizer ─────────────────────────────────────────────────────────────

/**
 * Map a raw GMGN token object to the unified internal token shape.
 * Used by both trending and trenches streams.
 */
function normalizeToken(raw, signalType) {
  if (!raw || !raw.address) return null;
  return {
    mint: raw.address,
    address: raw.address,
    symbol: raw.symbol || raw.address.slice(0, 6),
    name: raw.name || raw.symbol || '',
    source: 'gmgn',
    signal_type: signalType,
    source_confidence: SOURCE_CONFIDENCE[signalType] ?? 0.5,
    // Price & valuation
    price_usd: raw.price ?? null,
    liquidity_usd: raw.liquidity ?? null,
    market_cap: raw.market_cap ?? null,
    total_supply: raw.total_supply ?? null,
    volume_24h_usd: raw.volume ?? null,
    // Holder / concentration
    holder_count: raw.holder_count ?? null,
    top_10_holder_rate: raw.top_10_holder_rate ?? null,
    // Smart money / KOL signals
    smart_money_count: raw.smart_degen_count ?? 0,
    kol_count: raw.renowned_count ?? 0,
    // Risk flags
    rug_ratio: raw.rug_ratio ?? 0,
    is_honeypot: raw.is_honeypot === 1 || raw.is_honeypot === true,
    renounced_mint: raw.renounced_mint === 1 || raw.renounced_mint === true,
    renounced_freeze_account:
      raw.renounced_freeze_account === 1 || raw.renounced_freeze_account === true,
    bundler_rate: raw.bundler_rate ?? null,
    sniper_count: raw.sniper_count ?? 0,
    // Activity
    buys_24h: raw.buys ?? raw.buys_24h ?? 0,
    sells_24h: raw.sells ?? 0,
    swaps: raw.swaps ?? 0,
    // Social
    has_social: Boolean(
      raw.twitter_username || raw.telegram || raw.website ||
      raw.has_at_least_one_social
    ),
    twitter_username: raw.twitter_username || '',
    telegram: raw.telegram || '',
    website: raw.website || '',
    // Misc
    creator: raw.creator || '',
    creator_token_status: raw.creator_token_status || '',
    is_wash_trading: raw.is_wash_trading === true,
    is_show_alert: raw.is_show_alert === true,
    discovered_at: new Date().toISOString(),
    raw_data: raw,
  };
}

// ─── Fetchers per stream ────────────────────────────────────────────────────

/**
 * Stream 1: market trending (5m default).
 * Returns trending_5m signals.
 */
export async function fetchGmgnTrending(options = {}) {
  const interval = options.interval || '5m';
  const limit = options.limit || 30;
  try {
    const data = await runGmgn([
      'market', 'trending',
      '--chain', 'sol',
      '--interval', interval,
      '--limit', String(limit),
      '--raw',
    ]);
    const rank = data?.data?.rank || [];
    return rank
      .map(t => normalizeToken(t, 'trending_5m'))
      .filter(Boolean);
  } catch (err) {
    log.error(`[GMGN-FEED] trending ${interval} error: ${err.message}`);
    return [];
  }
}

/**
 * Stream 2-4: trenches (3 sub-types in one call).
 * Always hits the same endpoint with --type filter; response always has
 * { completed, new_creation, pump } keys; only the one matching --type is populated.
 *
 * Returns { new_creation, near_graduation, kol_new } arrays.
 */
export async function fetchGmgnTrenches(options = {}) {
  const result = { new_creation: [], near_graduation: [], kol_new: [] };
  const config = loadConfig();
  const platforms = config.gmgn?.platforms?.length
    ? ['--launchpad-platform', ...config.gmgn.platforms]
    : [];

  // Type 1: new_creation
  if (config.gmgn?.platforms?.length !== 0) {
    try {
      const args = [
        'market', 'trenches',
        '--chain', 'sol',
        '--type', 'new_creation',
        ...platforms,
        '--raw',
      ];
      const data = await runGmgn(args);
      const arr = data?.data?.new_creation || [];
      result.new_creation = arr.map(t => normalizeToken(t, 'new_creation')).filter(Boolean);
    } catch (err) {
      log.error(`[GMGN-FEED] trenches new_creation error: ${err.message}`);
    }
  }

  // Type 2: near_graduation (returned in data.pump regardless of --type)
  if (config.gmgn?.include_near_graduation) {
    try {
      const data = await runGmgn([
        'market', 'trenches',
        '--chain', 'sol',
        '--type', 'near_graduation',
        '--raw',
      ]);
      const arr = data?.data?.pump || [];
      result.near_graduation = arr
        .map(t => normalizeToken(t, 'near_graduation'))
        .filter(Boolean);
    } catch (err) {
      log.error(`[GMGN-FEED] trenches near_graduation error: ${err.message}`);
    }
  }

  // Type 3: kol_new
  if (config.gmgn?.include_kol_bought) {
    try {
      const data = await runGmgn([
        'market', 'trenches',
        '--chain', 'sol',
        '--type', 'kol_new',
        '--raw',
      ]);
      const arr = data?.data?.pump || [];
      result.kol_new = arr.map(t => normalizeToken(t, 'kol_new')).filter(Boolean);
    } catch (err) {
      log.error(`[GMGN-FEED] trenches kol_new error: ${err.message}`);
    }
  }

  return result;
}

// ─── GmgnFeed class (drop-in for Screener / PumpfunFeed) ──────────────────

let _singleton = null;

export class GmgnFeed {
  constructor(config = null) {
    this.config = config || loadConfig().gmgn || {};
    this.cache = []; // unified token list (latest fetch)
    this.lastFetch = null;
    this.running = false;
    this._interval = null;
    this._handlers = [];
    this._stats = {
      trending_5m: 0, new_creation: 0, near_graduation: 0, kol_new: 0,
      total_unique: 0, last_poll_ms: 0,
    };
  }

  onToken(handler) {
    this._handlers.push(handler);
  }

  _emit(token) {
    for (const h of this._handlers) {
      try { h(token); } catch (e) {
        log.error(`[GMGN-FEED] handler error: ${e.message}`);
      }
    }
  }

  /**
   * Fetch one round from all enabled streams, merge, dedupe, update cache.
   * @returns {Promise<{tokens: object[], stats: object}>}
   */
  async fetch() {
    const t0 = Date.now();
    const intervals = this.config.intervals || ['5m'];
    const trendingPromises = intervals.map(iv =>
      fetchGmgnTrending({ interval: iv, limit: 30 })
    );
    const [trendingAll, trenches] = await Promise.all([
      Promise.all(trendingPromises).then(arrs => arrs.flat()),
      fetchGmgnTrenches(this.config),
    ]);

    // Merge all streams. Dedupe by address, KEEP highest-confidence signal.
    const merged = new Map();
    const add = (t) => {
      const cur = merged.get(t.address);
      if (!cur || (t.source_confidence > cur.source_confidence)) {
        merged.set(t.address, t);
      }
    };
    for (const t of trendingAll) add(t);
    for (const t of trenches.new_creation) add(t);
    for (const t of trenches.near_graduation) add(t);
    for (const t of trenches.kol_new) add(t);

    const tokens = Array.from(merged.values());
    this.cache = tokens;
    this.lastFetch = Date.now();
    this._stats = {
      trending_5m: trendingAll.length,
      new_creation: trenches.new_creation.length,
      near_graduation: trenches.near_graduation.length,
      kol_new: trenches.kol_new.length,
      total_unique: tokens.length,
      last_poll_ms: Date.now() - t0,
    };
    return { tokens, stats: this._stats };
  }

  async getTokens() {
    if (!this.lastFetch || Date.now() - this.lastFetch > 60_000) {
      await this.fetch();
    }
    return this.cache;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    const intervalMs = this.config.poll_interval_ms || 30_000;
    await this.fetch();
    this._interval = setInterval(() => this.fetch().catch(() => {}), intervalMs);
    log.info(`[GMGN-FEED] started (poll every ${intervalMs}ms)`);
  }

  async stop() {
    this.running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  getStats() {
    return { ...this._stats };
  }
}

export function getGmgnFeed() {
  if (!_singleton) _singleton = new GmgnFeed();
  return _singleton;
}

export function createGmgnFeed(config) {
  return new GmgnFeed(config);
}

// Legacy compatibility shims (so callers using old names keep working)
export const Screener = GmgnFeed;
export const PumpfunFeed = GmgnFeed;
export const fetchDexScreener = fetchGmgnTrending; // best-effort alias
export const fetchBirdeyeTrending = fetchGmgnTrending;
export const fetchPumpfunTokens = fetchGmgnTrenches;
export const createScreener = createGmgnFeed;
export const getPumpfunFeed = getGmgnFeed;
export const createPumpfunFeed = createGmgnFeed;
export const fetchAllScreeners = async (opts) => {
  const feed = createGmgnFeed(opts);
  return (await feed.fetch()).tokens;
};
