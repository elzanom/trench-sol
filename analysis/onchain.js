// ─── analysis/onchain.js ──────────────────────────────────────────────────
// Token data + security enrichment via HYBRID approach:
//   - DexScreener PRIMARY (price, liquidity, volume) — no rate limit
//   - GMGN for security (cached 10 min) + holder count (cached 5 min)
//   - Helius fallback for supply + top_holders
//
// Migrated from Birdeye → GMGN → HYBRID because:
//   1. GMGN free tier rate-limits aggressively (429 ban on burst)
//   2. DexScreener has no rate limit and covers price/liquidity/volume
//   3. GMGN still needed for security (renounced, taxes) + holder_count
//   4. smart_money_count + kol_count come from feed (gmgn.js) — not refetched
//
// Data flow:
//   DexScreener ─────────→ price, liquidity, volume, marketCap (PRIMARY)
//   GMGN security (cache)→ renounced, taxes, honeypot
//   GMGN holder count ───→ holder_count (cached, 5 min TTL)
//   Helius RPC ──────────→ supply, top_holders (if both above miss)
//   Feed (gmgn.js) ──────→ smart_money_count, kol_count

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../core/logger.js';
import { acquire } from '../core/rate-limiter.js';

const execFileP = promisify(execFile);
const log = createLogger('onchain');

const TIMEOUT_MS = 10_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── GMGN Cache (per-mint, in-memory) ──────────────────────────────────
// 2026-06-06: added for hybrid approach. Security rarely changes (10 min
// OK); holder count moderate (5 min). Per-mint Map<{ data, expires_at }>.
// Same mint re-enriched within TTL reuses cached data → ~90% fewer GMGN
// calls. Cache is per-process, lost on restart (acceptable).
const GMGN_SECURITY_TTL_MS = 10 * 60 * 1000; // 10 min
const GMGN_HOLDERS_TTL_MS = 5 * 60 * 1000;   // 5 min
const gmgnSecurityCache = new Map();   // mint → { data, expires_at }
const gmgnHoldersCache = new Map();    // mint → { data, expires_at }

function getCached(cache, mint) {
  const entry = cache.get(mint);
  if (entry && Date.now() < entry.expires_at) return entry.data;
  cache.delete(mint); // expired — evict
  return null;
}

function setCached(cache, mint, data, ttlMs) {
  cache.set(mint, { data, expires_at: Date.now() + ttlMs });
}

// ─── GMGN CLI runner ──────────────────────────────────────────────────────

async function runGmgnToken(args) {
  await acquire('gmgn');
  const { stdout } = await execFileP(process.env.GMGN_CLI_PATH || '/home/elzanom/.npm-global/bin/gmgn-cli', args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, GMGN_API_KEY: process.env.GMGN_API_KEY },
  });
  return JSON.parse(stdout);
}

// ─── Helius (for supply + top holders when GMGN holders fails) ────────────

async function fetchHeliusSupplyAndHolders(mintAddress) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { supply: null, topHolders: [], decimals: null };
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  try {
    await acquire('helius');
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const conn = new Connection(rpcUrl, 'confirmed');
    const mint = new PublicKey(mintAddress);
    const supplyResp = await conn.getTokenSupply(mint);
    const supply = parseFloat(supplyResp.value.amount) / Math.pow(10, supplyResp.value.decimals);

    const largest = await conn.getTokenLargestAccounts(mint);
    await acquire('helius');
    const topHolders = largest.value.slice(0, 10).map(a => ({
      address: a.address,
      amount: a.amount, // raw integer string
    }));
    return { supply, topHolders, decimals: supplyResp.value.decimals };
  } catch (err) {
    log.warn(`[onchain] Helius supply/holders failed: ${err.message}`);
    return { supply: null, topHolders: [], decimals: null };
  }
}

// ─── GMGN low-level fetchers (used by cache wrappers) ────────────────────

/**
 * Fetch token info via GMGN. Low-level helper — NOT called by getTokenData
 * anymore (replaced by DexScreener primary). Kept for tests + cache wrappers.
 * Returns { price, marketCap, liquidity, holderCount, totalSupply, decimals, ... }
 */
async function fetchGmgnInfo(mintAddress) {
  try {
    const data = await runGmgnToken(['token', 'info', '--chain', 'sol', '--address', mintAddress, '--raw']);
    if (!data || !data.address) return null;

    // Price is nested in data.price (object) or root depending on version
    const price = parseFloat(data.price?.price ?? data.price ?? '') || null;
    const marketCap = price && data.circulating_supply
      ? price * parseFloat(data.circulating_supply)
      : null;

    return {
      symbol: data.symbol || '',
      name: data.name || '',
      price,
      liquidity: data.liquidity ? parseFloat(data.liquidity) : null,
      marketCap,
      holderCount: data.holder_count ?? null,
      totalSupply: data.total_supply ? parseFloat(data.total_supply) : null,
      circulatingSupply: data.circulating_supply ? parseFloat(data.circulating_supply) : null,
      decimals: data.decimals ?? null,
      launchpad: data.launchpad || '',
      launchpadPlatform: data.launchpad_platform || '',
      website: data.website || '',
      twitter: data.twitter_username || '',
      telegram: data.telegram || '',
      logo: data.logo || '',
    };
  } catch (err) {
    log.warn(`[onchain] GMGN info error for ${mintAddress}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch token security via GMGN. Low-level — wrapped by getCachedSecurity().
 * Returns { isHoneypot, isBlacklist, renouncedMint, renouncedFreeze,
 *           top10HolderRate, buyTax, sellTax, canSell }
 */
async function fetchGmgnSecurity(mintAddress) {
  try {
    const data = await runGmgnToken(['token', 'security', '--chain', 'sol', '--address', mintAddress, '--raw']);
    if (!data || !data.address) return null;
    return {
      isHoneypot: data.is_honeypot === 1 || data.honeypot === 1,
      isBlacklist: data.is_blacklist === 1 || data.blacklist === 1,
      renouncedMint: data.renounced_mint === 1,
      renouncedFreeze: data.renounced_freeze_account === 1,
      top10HolderRate: data.top_10_holder_rate ? parseFloat(data.top_10_holder_rate) : null,
      buyTax: data.buy_tax ? parseFloat(data.buy_tax) : 0,
      sellTax: data.sell_tax ? parseFloat(data.sell_tax) : 0,
      canSell: data.can_sell === 1,
      avgTax: data.average_tax ? parseFloat(data.average_tax) : 0,
      burnRatio: data.burn_ratio ? parseFloat(data.burn_ratio) : 0,
    };
  } catch (err) {
    log.warn(`[onchain] GMGN security error for ${mintAddress}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch top holders via GMGN. Low-level — kept for tests / direct access.
 * Returns { topHolders: [{ address, amount, usdValue, percentage, tags }],
 *           smartDegenCount, renownedCount }
 */
async function fetchGmgnHolders(mintAddress) {
  try {
    const data = await runGmgnToken(['token', 'holders', '--chain', 'sol', '--address', mintAddress, '--raw']);
    const list = data?.list || [];
    return {
      topHolders: list.slice(0, 20).map(h => ({
        address: h.account_address || h.address,
        amount: h.amount_cur?.toString() || h.native_balance || '0',
        usdValue: h.usd_value ? parseFloat(h.usd_value) : 0,
        percentage: h.amount_percentage ? parseFloat(h.amount_percentage) * 100 : 0,
        tags: [h.wallet_tag_v2, h.addr_type_str].filter(Boolean),
      })),
      smartDegenCount: list.filter(h => h.wallet_tag_v2 === 'smart_degen').length,
      renownedCount: list.filter(h => h.wallet_tag_v2 === 'renowned').length,
    };
  } catch (err) {
    log.warn(`[onchain] GMGN holders error for ${mintAddress}: ${err.message}`);
    return null;
  }
}

// ─── GMGN cached wrappers (hybrid approach core) ─────────────────────────

/**
 * Cached GMGN security check. 10 min TTL. Returns null on miss/error.
 */
async function getCachedSecurity(mintAddress) {
  const cached = getCached(gmgnSecurityCache, mintAddress);
  if (cached !== null) return cached;
  const data = await fetchGmgnSecurity(mintAddress);
  if (data) setCached(gmgnSecurityCache, mintAddress, data, GMGN_SECURITY_TTL_MS);
  return data;
}

/**
 * Cached GMGN holder count. 5 min TTL. Uses GMGN `token info` endpoint
 * (which returns `holder_count` at top level). Note: `token holders`
 * endpoint only returns top-100 list, no aggregate count.
 * Verified 2026-06-06: gmgn-cli token info → {holder_count: 775, ...}.
 */
async function getCachedHolderCount(mintAddress) {
  const cached = getCached(gmgnHoldersCache, mintAddress);
  if (cached !== null) return cached;
  try {
    const data = await runGmgnToken(['token', 'info', '--chain', 'sol', '--address', mintAddress, '--raw']);
    // GMGN 1.4+ info endpoint returns top-level `holder_count` field (int)
    const holderCount = data?.holder_count != null ? parseInt(data.holder_count, 10) : null;
    const result = { holderCount };
    if (holderCount !== null) {
      setCached(gmgnHoldersCache, mintAddress, result, GMGN_HOLDERS_TTL_MS);
    }
    return result;
  } catch (err) {
    log.warn(`[onchain] GMGN holder_count error for ${mintAddress}: ${err.message}`);
    return { holderCount: null };
  }
}

// ─── DexScreener PRIMARY enrichment (no rate limit, but throttled) ──────

// 2026-06-06: serialize DexScreener calls (200ms gap). Node's HTTP agent
// chokes on 30 parallel fetch() to same domain (fetch failed / timeouts).
// Sequential queue keeps concurrent calls ≤ 1 → no socket exhaustion.
let dsQueue = Promise.resolve();
async function fetchDexScreenerThrottled(mintAddress) {
  const result = dsQueue.then(async () => {
    await sleep(200);
    return fetchDexScreener(mintAddress);
  });
  // Don't let one error block the queue for subsequent tokens
  dsQueue = result.catch(() => {});
  return result;
}

/**
 * PRIMARY enrichment: DexScreener. No rate limit, returns price/liquidity/
 * volume/marketCap from the highest-liquidity Solana pair for the token.
 * Returns { price, liquidity, marketCap, symbol, name,
 *           h24Buys, h24Sells, volume24h, priceChange24h,
 *           h1Buys, h1Sells, volume1h, priceChange1h, pairs }
 */
async function fetchDexScreener(mintAddress) {
  try {
    const resp = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const solPairs = (data?.pairs || []).filter(p => p?.chainId === 'solana');
    const pair = solPairs.sort(
      (a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0)
    )[0];
    if (!pair) return { pairs: solPairs.length }; // expose pair count even if no liquidity
    return {
      symbol: pair.baseToken?.symbol || '',
      name: pair.baseToken?.name || '',
      price: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
      liquidity: pair.liquidity?.usd ?? null,
      marketCap: pair.marketCap ?? pair.fdv ?? null,
      h24Buys: pair.txns?.h24?.buys || 0,
      h24Sells: pair.txns?.h24?.sells || 0,
      volume24h: pair.volume?.h24 || 0,
      h1Buys: pair.txns?.h1?.buys || 0,
      h1Sells: pair.txns?.h1?.sells || 0,
      volume1h: pair.volume?.h1 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      pairs: solPairs.length,
    };
  } catch (err) {
    log.warn(`[onchain] DexScreener error for ${mintAddress}: ${err.message}`);
    return null;
  }
}

// ─── Main API: getTokenData ────────────────────────────────────────────────

/**
 * Fetch complete token data with HYBRID flow:
 *   1. DexScreener PRIMARY — price, liquidity, volume, marketCap
 *   2. GMGN security (cached 10 min) — renounced, taxes, honeypot
 *   3. GMGN holder count (cached 5 min) — holder_count
 *   4. Helius RPC (fallback) — supply, top_holders
 *   5. feedToken (from gmgn.js feed) — smart_money_count, kol_count
 *
 * @param {string} mintAddress
 * @param {object} [feedToken={}] - feed token with smart_money_count, kol_count
 * @returns {Promise<TokenData>}
 */
export async function getTokenData(mintAddress, feedToken = {}) {
  if (!mintAddress || typeof mintAddress !== 'string') {
    throw new Error('Invalid mint address');
  }

  // Hybrid flow (2026-06-06):
  //   1. DexScreener PRIMARY — no rate limit
  //   2. GMGN security + holder count — CACHED, ~2 calls/unique token
  //   3. Helius only if we need supply/top_holders (for dev_wallet_pct)
  // Total GMGN calls per enrichment: 0-2 (cache hits = 0).
  const dex = await fetchDexScreenerThrottled(mintAddress);
  const gmgnSec = await getCachedSecurity(mintAddress);
  const gmgnHolders = await getCachedHolderCount(mintAddress);
  // Only call Helius if we don't have top_holders from GMGN
  const heliusData = await fetchHeliusSupplyAndHolders(mintAddress);

  // Field assembly. DexScreener is PRIMARY (price/liquidity/marketCap).
  // GMGN fills holder_count + security flags.
  // Feed provides smart_money_count + kol_count (not refetched).
  // Helius provides supply + top_holders.
  const symbol = dex?.symbol || '';
  const name = dex?.name || '';
  const priceUsd = dex?.price ?? null;
  const liquidityUsd = dex?.liquidity ?? null;
  const marketCap = dex?.marketCap ?? null;
  const holderCount = gmgnHolders?.holderCount ?? null;
  const totalSupply = heliusData?.supply ?? null;
  const decimals = heliusData?.decimals ?? null;

  // Top holders from Helius (GMGN holders list dropped in hybrid)
  const topHolders = heliusData.topHolders.map(h => ({
    address: h.address,
    amount: h.amount,
    percentage: 0,
    tags: [],
  }));

  // ── Dev wallet % ────────────────────────────────────────────────────────
  // Per user spec: dev_team_hold_rate (0-1) → dev_wallet_pct (0-100)
  // With hybrid: GMGN holders list dropped. Use top holder % as proxy.
  let devWalletPct = null;
  if (topHolders.length > 0 && totalSupply && totalSupply > 0) {
    devWalletPct = (parseFloat(topHolders[0].amount) / Math.pow(10, decimals || 9)) / totalSupply * 100;
  }

  // ── Bundler / sniper % (no longer available — GMGN holders dropped) ──
  // 2026-06-06 hybrid: dropped GMGN holders list (too expensive). Bundler
  // / sniper % cannot be computed without holder tags. Defaults to 0.
  // TODO: re-enable via rugcheck.js / bundler-check.js if needed.
  let bundlerCount = 0, sniperCount = 0, bundlerPct = 0, sniperPct = 0;

  // ── Smart money / KOL counts (from FEED, not GMGN) ────────────────────
  // gmgn.js feed emits tokens with smart_money_count + kol_count
  // already populated from trending/kol_new streams. feedToken is passed
  // by handleToken in index.js.
  const smartMoneyCount = feedToken?.smart_money_count ?? 0;
  const kolCount = feedToken?.kol_count ?? 0;

  // ── Data source tracking ────────────────────────────────────────────────
  const sources = [];
  if (dex) sources.push('dexscreener');
  if (gmgnSec) sources.push('gmgn-security');
  if (gmgnHolders?.holderCount != null) sources.push('gmgn-holders');
  if (heliusData?.supply != null) sources.push('helius');
  if (feedToken?.smart_money_count) sources.push('feed');

  // 24h volume + buy/sell ratio (DexScreener only)
  const volume24h = dex?.volume24h ?? null;
  const buys24h = dex?.h24Buys ?? null;
  const sells24h = dex?.h24Sells ?? null;
  const buySellRatio = (buys24h && sells24h) ? buys24h / Math.max(1, sells24h) : null;

  if (process.env.DEBUG_ONCHAIN === '1') {
    console.log(`[onchain] ${mintAddress}: sources=[${sources.join(',')}] price=${priceUsd} liq=${liquidityUsd} mc=${marketCap} holders=${holderCount} dev=${devWalletPct?.toFixed?.(2)}% smart_money=${smartMoneyCount} kol=${kolCount}`);
  }

  return {
    mint_address: mintAddress,
    address: mintAddress, // alias for hard rules
    symbol,
    name,
    supply: totalSupply,
    total_supply: totalSupply,
    decimals,
    top_holders: topHolders,
    market_cap: marketCap,
    liquidity_usd: liquidityUsd,
    holder_count: holderCount,
    dev_wallet_pct: devWalletPct,
    price_usd: priceUsd,

    // ── Smart money / KOL from feed ──
    smart_money_count: smartMoneyCount,
    kol_count: kolCount,

    // ── Bundler / sniper (no longer available) ──
    bundler_pct: bundlerPct,
    sniper_pct: sniperPct,
    bundler_count: bundlerCount,
    sniper_count: sniperCount,

    // Security flags (from GMGN security)
    is_honeypot: gmgnSec?.isHoneypot ?? false,
    is_blacklist: gmgnSec?.isBlacklist ?? false,
    renounced_mint: gmgnSec?.renouncedMint ?? null,
    renounced_freeze_account: gmgnSec?.renouncedFreeze ?? null,
    buy_tax: gmgnSec?.buyTax ?? 0,
    sell_tax: gmgnSec?.sellTax ?? 0,
    can_sell: gmgnSec?.canSell ?? null,
    top_10_holder_rate: gmgnSec?.top10HolderRate ?? null,
    burn_ratio: gmgnSec?.burnRatio ?? 0,

    // Activity
    volume_24h_usd: volume24h,
    buy_sell_ratio: buySellRatio,
    buys_24h: buys24h,
    sells_24h: sells24h,

    // 1h activity (DexScreener)
    volume_1h_usd: dex?.volume1h ?? null,
    buys_1h: dex?.h1Buys ?? null,
    sells_1h: dex?.h1Sells ?? null,
    price_change_1h_pct: dex?.priceChange1h ?? null,
    price_change_24h_pct: dex?.priceChange24h ?? null,

    // Social (NOT in DexScreener — empty defaults in hybrid)
    has_social: false,
    twitter: '',
    telegram: '',
    website: '',
    logo: '',

    // Meta (NOT in DexScreener — empty defaults in hybrid)
    launchpad: '',
    launchpad_platform: '',
    data_source: sources.join('+') || 'none',
    fetched_at: Date.now(),
  };
}

// ─── getPositionSignals (minimal shim) ────────────────────────────────
//
// Used by brain/position-manager.js → checkEmergencyTriggers.
// Returns the safe-default signals object (all false/0) so the monitor
// loop never crashes. The real-time emergency detection (dev sell /
// liquidity drain) is currently disabled — see TODO below.
//
// TODO: re-enable real-time signal enrichment via GMGN streaming or
//       Helius webhook subscription once trade volume warrants the cost.
//
// @param {string} mintAddress
// @param {object} position - position object from DB
// @returns {object} signals object consumed by checkEmergencyTriggers
export async function getPositionSignals(mintAddress, position = {}) {
  return {
    dev_wallet_activity: false,
    dev_selling: false,
    liquidity_drain: false,
    liquidity_delta_pct: 0,
    large_wallet_movement: false,
    is_mintable: false,
    fetched_at: Date.now(),
    source: 'minimal-shim',
  };
}
