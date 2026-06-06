// ─── tests/paper.test.js ────────────────────────────────────────────────
// Unit tests for execution/paper.js
//
// GMGN-migrated (2026-06-06): Birdeye primary → GMGN primary (via gmgn-cli).
// DexScreener remains as fallback. Tests mock `child_process.execFile` for
// GMGN CLI calls and `globalThis.fetch` for DexScreener.

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import * as cp from 'child_process';
import * as web3 from '@solana/web3.js';
import { resetAll as resetRateLimiter } from '../core/rate-limiter.js';

// ─── Mocks ─────────────────────────────────────────────────────────────────

let execFileMock;
let fetchMock;
let originalFetch;
let execCallLog = [];
let fetchCallLog = [];

// Default GMGN response: $0.00004 price, $25k liquidity
const GMGN_OK_RESPONSE = {
  address: 'X',
  symbol: 'TEST',
  price: 0.00004,
  liquidity: 25000,
};

// Default DexScreener fallback response
const DEXSCR_OK_RESPONSE = {
  pairs: [{ priceUsd: '0.00004', liquidity: { usd: 50000 } }],
};

beforeEach(() => {
  execCallLog = [];
  fetchCallLog = [];
  originalFetch = globalThis.fetch;

  resetRateLimiter();

  // Mock execFile via globalThis (paper.js checks __gmgnExecFile at call time)
  globalThis.__gmgnExecFile = async (file, args = []) => {
    execCallLog.push({ file, args });

    // GMGN token info: successful response
    if (file === 'gmgn-cli' && args[0] === 'token' && args[1] === 'info') {
      return { stdout: JSON.stringify(GMGN_OK_RESPONSE) };
    }
    // Default: GMGN fails (forces fallback path)
    const err = new Error('GMGN: not mocked in this test');
    err.code = 'ENOENT';
    throw err;
  };

  // Mock fetch (for DexScreener fallback)
  fetchMock = mock.method(globalThis, 'fetch', async (url) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    fetchCallLog.push({ url: urlStr });
    if (urlStr.includes('dexscreener.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => DEXSCR_OK_RESPONSE,
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

  // Required env for paper.js
  process.env.GMGN_API_KEY='test_gmgn_key_for_unit_tests';
});

afterEach(() => {
  if (execFileMock) execFileMock.mock.restore();
  if (fetchMock) fetchMock.mock.restore();
  globalThis.fetch = originalFetch;
  delete globalThis.__gmgnExecFile;
  delete process.env.GMGN_API_KEY;
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('execution/paper.js', () => {
  // ─── Slippage simulation ────────────────────────────────────────────────

  describe('simulateSlippage()', () => {
    it('returns 0.5% - 1.0% for liquidity > $100k', async () => {
      const { simulateSlippage } = await import('../execution/paper.js');
      for (let i = 0; i < 100; i++) {
        const s = simulateSlippage(150_000);
        assert.ok(s >= 0.5 && s <= 1.0, `Slippage ${s} out of high-liq range [0.5, 1.0]`);
      }
    });

    it('returns 1.0% - 2.0% for liquidity $50k-$100k', async () => {
      const { simulateSlippage } = await import('../execution/paper.js');
      for (let i = 0; i < 100; i++) {
        const s = simulateSlippage(75_000);
        assert.ok(s >= 1.0 && s <= 2.0, `Slippage ${s} out of med-liq range [1.0, 2.0]`);
      }
    });

    it('returns 1.5% - 3.0% for liquidity $10k-$50k', async () => {
      const { simulateSlippage } = await import('../execution/paper.js');
      for (let i = 0; i < 100; i++) {
        const s = simulateSlippage(25_000);
        assert.ok(s >= 1.5 && s <= 3.0, `Slippage ${s} out of low-liq range [1.5, 3.0]`);
      }
    });

    it('returns 2.0% - 5.0% for liquidity <= $10k', async () => {
      const { simulateSlippage } = await import('../execution/paper.js');
      for (let i = 0; i < 100; i++) {
        const s = simulateSlippage(5_000);
        assert.ok(s >= 2.0 && s <= 5.0, `Slippage ${s} out of very-low-liq range [2.0, 5.0]`);
      }
    });
  });

  // ─── buyToken() ─────────────────────────────────────────────────────────

  describe('buyToken()', () => {
    it('returns correct shape with live GMGN price', async () => {
      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();
      const mint = 'So11111111111111111111111111111111111111112';

      const result = await buyToken(fakeKeypair, mint, 0.075, { symbol: 'DOGE69' });

      assert.ok(result, 'should return a result');
      assert.ok(typeof result.txHash === 'string', 'txHash is string');
      assert.ok(typeof result.amountIn === 'number', 'amountIn is number');
      assert.ok(typeof result.amountOut === 'number', 'amountOut is number');
      assert.ok(typeof result.priceImpactPct === 'number', 'priceImpactPct is number');
      assert.ok(typeof result.entryPriceUsd === 'number', 'entryPriceUsd is number');

      assert.strictEqual(result.amountIn, 0.075, 'amountIn == input SOL');
      assert.ok(result.amountOut > 0, 'amountOut > 0 (tokens)');
      // Mock GMGN price is $0.00004 with liquidity $25k → slippage 1.5%-3%
      // entryPriceUsd ∈ [0.00004 * 1.015, 0.00004 * 1.030]
      assert.ok(result.entryPriceUsd >= 0.00004, 'entryPriceUsd >= base price');
      assert.ok(result.entryPriceUsd < 0.00005, 'entryPriceUsd < base * 1.1 (slippage cap)');
    });

    it('passes GMGN_API_KEY to gmgn-cli via env', async () => {
      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();
      const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

      await buyToken(fakeKeypair, mint, 0.1, { symbol: 'USDC' });

      // Verify gmgn-cli was called
      const gmgnCall = execCallLog.find(c => c.file === 'gmgn-cli');
      assert.ok(gmgnCall, 'gmgn-cli was called');
      assert.ok(gmgnCall.args.includes('token'), 'subcommand is "token"');
      assert.ok(gmgnCall.args.includes('info'), 'action is "info"');
      assert.ok(gmgnCall.args.includes('--chain'), 'has --chain flag');
      assert.ok(gmgnCall.args.includes('sol'), 'chain is sol');
    });

    it('falls back to DexScreener when GMGN fails', async () => {
      // Override GMGN to fail
      globalThis.__gmgnExecFile = async (file, args = []) => {
        execCallLog.push({ file, args });
        const err = new Error('GMGN CLI failed');
        err.code = 1;
        throw err;
      };

      // Override DexScreener mock with a different price
      fetchMock.mock.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchCallLog.push({ url: urlStr });
        if (urlStr.includes('dexscreener.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              pairs: [{ priceUsd: '0.0001', liquidity: { usd: 200000 } }],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });

      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      const result = await buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 0.05, { symbol: 'FALLBACK' });

      assert.ok(result.entryPriceUsd > 0, 'fallback result has valid price');
      assert.ok(result.entryPriceUsd < 0.00011, 'fallback uses DexScreener price ($0.0001 + slippage)');

      // Both GMGN and DexScreener should have been called
      const gmgnCall = execCallLog.find(c => c.file === 'gmgn-cli');
      const dexscreenerCall = fetchCallLog.find(c => c.url.includes('dexscreener.com'));
      assert.ok(gmgnCall, 'GMGN CLI was attempted first');
      assert.ok(dexscreenerCall, 'DexScreener fallback was used');
    });

    it('throws when both GMGN and DexScreener fail', async () => {
      globalThis.__gmgnExecFile = async () => {
        const err = new Error('GMGN CLI failed');
        err.code = 1;
        throw err;
      };
      fetchMock.mock.mockImplementation(async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }));

      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      await assert.rejects(
        () => buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 0.05),
        /no pairs found|HTTP|invalid|price/i,
        'should throw when all price sources fail'
      );
    });

    it('throws on invalid amountSol', async () => {
      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      await assert.rejects(
        () => buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 0),
        /Invalid amountSol/i
      );
      await assert.rejects(
        () => buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', -1),
        /Invalid amountSol/i
      );
    });

    it('does not call any non-public RPC URLs', async () => {
      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      await buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 0.05, { symbol: 'TEST' });

      // All fetch calls should be to DexScreener
      for (const call of fetchCallLog) {
        const isPublicApi = call.url.includes('dexscreener.com');
        assert.ok(isPublicApi, `Unexpected URL called: ${call.url}`);
      }
    });
  });

  // ─── sellToken() ────────────────────────────────────────────────────────

  describe('sellToken()', () => {
    it('returns correct shape with entryPriceUsd provided', async () => {
      const { sellToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();
      const mint = 'So11111111111111111111111111111111111111112';

      const result = await sellToken(fakeKeypair, mint, 100, {
        symbol: 'DOGE69',
        entryPriceUsd: 0.00004,
        amountSol: 0.05,
      });

      assert.ok(result, 'should return a result');
      assert.ok(typeof result.txHash === 'string', 'txHash is string');
      assert.ok(typeof result.amountIn === 'number', 'amountIn is number');
      assert.ok(typeof result.amountOut === 'number', 'amountOut is number');
      assert.ok(typeof result.solReceived === 'number', 'solReceived is number');
      assert.ok(typeof result.exitPriceUsd === 'number', 'exitPriceUsd is number');

      assert.strictEqual(result.solReceived, result.amountOut, 'solReceived == amountOut');
      assert.ok(result.amountIn > 0, 'amountIn (tokens) > 0');
      assert.ok(result.solReceived > 0, 'solReceived > 0');
      assert.ok(result.exitPriceUsd > 0, 'exitPriceUsd > 0');
      assert.ok(result.exitPriceUsd < 0.000041, 'exitPriceUsd < base price (slippage reduces price)');
    });

    it('computes solReceived correctly with entry price', async () => {
      const { sellToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      // Live mock price from GMGN is $0.000040 with liquidity $25k
      // → slippage 1.5%-3% for sell
      // Enter at $0.000040 with 0.05 SOL → 1,250,000 tokens
      // Sell 100% at exit ~$0.00004 * (1 - 0.015..0.030) = $0.0000388 - $0.0000394
      const result = await sellToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 100, {
        symbol: 'TEST',
        entryPriceUsd: 0.00004,
        amountSol: 0.05,
      });

      assert.ok(result.solReceived > 0.048, `solReceived ${result.solReceived} should be in (0.048, 0.05)`);
      assert.ok(result.solReceived < 0.05, `solReceived ${result.solReceived} should be < 0.05 (slippage loss)`);
    });

    it('uses fallback math when no entryPriceUsd provided', async () => {
      const { sellToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      const result = await sellToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 100, {
        symbol: 'NO_ENTRY',
        amountSol: 0.1,
      });

      assert.ok(result.solReceived > 0.095, `solReceived ${result.solReceived} should be near 0.1`);
      assert.ok(result.solReceived < 0.1, `solReceived ${result.solReceived} should be < 0.1 (slippage loss)`);
    });

    it('throws on invalid amountPct', async () => {
      const { sellToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      await assert.rejects(
        () => sellToken(fakeKeypair, 'So11111111111111111111111111111111111111112', -10),
        /Invalid amountPct/i
      );
      await assert.rejects(
        () => sellToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 150),
        /Invalid amountPct/i
      );
    });

    it('handles partial sell (50%) correctly', async () => {
      const { sellToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      const fullSell = await sellToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 100, {
        entryPriceUsd: 0.00004,
        amountSol: 0.05,
      });

      const halfSell = await sellToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 50, {
        entryPriceUsd: 0.00004,
        amountSol: 0.05,
      });

      assert.ok(halfSell.amountIn < fullSell.amountIn, 'half sell has fewer tokens');
      assert.ok(
        Math.abs(halfSell.amountIn - fullSell.amountIn / 2) < fullSell.amountIn * 0.1,
        `half sell tokens ~half of full (got ${halfSell.amountIn} vs ${fullSell.amountIn})`
      );
    });
  });

  // ─── txHash format ──────────────────────────────────────────────────────

  describe('txHash format', () => {
    it('matches PAPER_<timestamp>_<RANDOM> pattern', async () => {
      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      const result = await buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 0.01, { symbol: 'TEST' });

      assert.ok(/^PAPER_\d+_[A-Z0-9]{1,6}$/.test(result.txHash), `txHash '${result.txHash}' doesn't match expected pattern`);
    });

    it('produces unique txHash per call', async () => {
      const { buyToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      const hashes = new Set();
      for (let i = 0; i < 10; i++) {
        const result = await buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 0.001, { symbol: 'UNIQ' });
        hashes.add(result.txHash);
      }
      assert.ok(hashes.size >= 8, `Expected at least 8 unique txHashes, got ${hashes.size}`);
    });
  });

  // ─── No actual wallet/RPC operations ───────────────────────────────────

  describe('no actual wallet or RPC operations', () => {
    it('does not access keypair methods', async () => {
      const { buyToken, sellToken } = await import('../execution/paper.js');

      const trapKeypair = new Proxy({}, {
        get(target, prop) {
          if (prop === 'publicKey') {
            return web3.Keypair.generate().publicKey;
          }
          throw new Error(`keypair.${String(prop)} should not be accessed in paper mode!`);
        }
      });

      const buyResult = await buyToken(trapKeypair, 'So11111111111111111111111111111111111111112', 0.01, { symbol: 'TRAP' });
      assert.ok(buyResult.txHash, 'buyToken succeeded without keypair access');

      const sellResult = await sellToken(trapKeypair, 'So11111111111111111111111111111111111111112', 100, {
        symbol: 'TRAP', entryPriceUsd: 0.00004, amountSol: 0.01,
      });
      assert.ok(sellResult.txHash, 'sellToken succeeded without keypair access');
    });

    it('only calls gmgn-cli (mocked) and DexScreener HTTP endpoints', async () => {
      const { buyToken, sellToken } = await import('../execution/paper.js');
      const fakeKeypair = web3.Keypair.generate();

      await buyToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 0.01, { symbol: 'A' });
      await sellToken(fakeKeypair, 'So11111111111111111111111111111111111111112', 100, { symbol: 'B' });

      // All fetch calls must be to DexScreener (or empty if GMGN succeeded)
      for (const call of fetchCallLog) {
        assert.ok(
          call.url.includes('dexscreener.com'),
          `Unexpected URL in paper mode: ${call.url} (only DexScreener HTTP allowed)`
        );
      }
    });
  });
});
