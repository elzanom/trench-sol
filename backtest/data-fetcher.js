import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Birdeye historical OHLCV ─────────────────────────────────────────────────

/**
 * Fetch historical OHLCV candles for a given mint from Birdeye.
 * @param {string} mint
 * @param {number} days - lookback days
 * @returns {Promise<Array<{time, open, high, low, close, volume}>>}
 */
async function fetchBirdeyeOhlcv(mint, days = 30) {
  const config = loadConfig();
  const apiKey = config.feeds?.birdeye_api_key || process.env.BIRDEYE_API_KEY;
  if (!apiKey) return [];

  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const resolution = '1H';

  try {
    const resp = await axios.get(
      'https://api.birdeye.io/v1/market/candles',
      {
        params: { address: mint, resolution, from, to },
        headers: { 'X-API-KEY': apiKey },
        timeout: 10000,
      }
    );

    const data = resp.data?.data?.candles;
    if (!Array.isArray(data)) return [];

    return data.map(c => ({
      time: c.time,
      open: c.open ?? c.o ?? 0,
      high: c.high ?? c.h ?? 0,
      low: c.low ?? c.l ?? 0,
      close: c.close ?? c.c ?? 0,
      volume: c.volume ?? c.v ?? 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch top Solana tokens by volume from Birdeye.
 */
async function fetchBirdeyeTokenList(limit = 200) {
  const config = loadConfig();
  const apiKey = config.feeds?.birdeye_api_key || process.env.BIRDEYE_API_KEY;
  console.log(`[backtest] fetchBirdeyeTokenList: apiKey ${apiKey ? 'present' : 'MISSING'} (${apiKey?.slice(0,8)})`);
  if (!apiKey) {
    console.log('[backtest] fetchBirdeyeTokenList: no API key');
    return [];
  }

  try {
    const url = 'https://public-api.birdeye.so/defi/tokenlist';
    const config = {
      params: { chain_id: 'solana', sort_by: 'v24hUSD', sort_type: 'desc', offset: 0, limit },
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
      timeout: 15000,
    };
    console.log(`[backtest] fetchBirdeyeTokenList URL: ${url}`);
    const resp = await axios.get(url, config);
    const tokens = resp.data?.data?.tokens || [];
    console.log(`[backtest] fetchBirdeyeTokenList: ${tokens.length} tokens, status ${resp.status}`);
    return tokens;
  } catch (err) {
    console.log(`[backtest] fetchBirdeyeTokenList error: ${err.message}, status: ${err.response?.status}`);
    if (err.response) console.log(`[backtest] response body: ${JSON.stringify(err.response.data).slice(0, 300)}`);
    return [];
  }
}

/**
 * Get metadata for a single token.
 */
async function getTokenMetadata(mint) {
  const config = loadConfig();
  const apiKey = config.feeds?.birdeye_api_key || process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await axios.get(`https://api.birdeye.io/v1/token/${mint}`, {
      headers: { 'X-API-KEY': apiKey },
      timeout: 10000,
    });
    return resp.data?.data || null;
  } catch {
    return null;
  }
}

// ─── DexScreener fallback ────────────────────────────────────────────────────

async function fetchDexScreenerTokens(minLiquidityUsd) {
  try {
    const resp = await axios.get(
      'https://api.dexscreener.com/latest/dex/tokens/solana',
      { timeout: 10000 }
    );

    const pairs = resp.data?.pairs || [];
    console.log(`[backtest] fetchDexScreenerTokens: ${pairs.length} pairs, status ${resp.status}`);
    const now = Date.now();
    const lookbackDays = (loadConfig().backtest?.lookback_days || 7);

    return pairs
      .filter(p => {
        if (!p.baseToken?.address) return false;
        if ((p.liquidity?.usd || 0) < minLiquidityUsd) return false;
        const ageDays = (p.pairCreatedAt ? (now - p.pairCreatedAt) / 86400000 : 0);
        if (ageDays > lookbackDays * 2) return false;
        return true;
      })
      .map(p => ({
        address: p.baseToken.address,
        symbol: p.baseToken.symbol || 'UNKNOWN',
        price: parseFloat(p.priceUsd || 0),
        liquidity: p.liquidity?.usd || 0,
        volume_24h: p.volume?.h24 || 0,
        price_change_24h: parseFloat(p.priceChange?.h24 || 0),
        age_days: Math.floor((now - (p.pairCreatedAt || now)) / 86400000),
        holders: 0,
      }));
  } catch (err) {
    return [];
  }
}

// ─── Main fetcher ─────────────────────────────────────────────────────────────

/**
 * Get tokens for backtesting within lookback_days.
 * Returns array of { address, symbol, price, liquidity, holders, age_days, ohlcv[] }
 */
async function fetchBacktestTokens() {
  const config = loadConfig();
  const backtest = config.backtest || {};
  const lookbackDays = backtest.lookback_days || 7;
  const minLiquidity = backtest.min_liquidity_usd || 5000;
  const minHolders = backtest.min_holders || 10;

  console.log(`[backtest] Fetching tokens: ${lookbackDays}d lookback, min liq $${minLiquidity}, min holders ${minHolders}`);

  // Try DexScreener first (no auth required)
  const tokens = await fetchDexScreenerTokens(minLiquidity);

  if (tokens.length > 0) {
    return tokens.slice(0, 100);
  }

  // Fallback to Birdeye — note: tokenlist endpoint does NOT return holders
  // field, so we filter only by liquidity and skip holders check.
  // Birdeye API limits limit to 1-50, so cap at 50.
  const birdeyeLimit = Math.min(50, 300);
  const birdeyeTokens = await fetchBirdeyeTokenList(birdeyeLimit);
  console.log(`[backtest] Birdeye returned ${birdeyeTokens.length} tokens`);
  return birdeyeTokens.filter(t => {
    if ((t.liquidity || 0) < minLiquidity) return false;
    // Holders field often missing from tokenlist — only filter if present
    if (t.holders !== undefined && t.holders !== null && t.holders < minHolders) {
      return false;
    }
    return true;
  }).slice(0, 100);
}

// ─── Module exports ────────────────────────────────────────────────────────────

export {
  fetchBacktestTokens,
  fetchBirdeyeTokenList,
  fetchBirdeyeOhlcv,
  getTokenMetadata,
};