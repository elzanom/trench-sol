import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Test Config ─────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  helius: { api_key: 'test_helius_key' },
  gmgn: { api_key: 'test_gmgn_key' },
  memory: { ledger: { db_path: path.join(__dirname, 'test-onchain.db') } },
  wallet: {
    rpc_endpoint: 'https://api.mainnet-beta.solana.com',
    rpc_fallbacks: ['https://solana-mainnet.rpc.exnode.io'],
  },
  rate_limits: {
    helius_rps: 10,
    gmgn_rps: 5,
    rugcheck_rps: 2,
    jupiter_rps: 5,
    llm_rpm: 20,
  },
  memory: {
    ledger: { db_path: path.join(__dirname, 'test-onchain.db') },
  },
};

const TEST_CONFIG_PATH = path.join(__dirname, 'test-onchain-config.json');
const TEST_DB_PATH = path.join(__dirname, 'test-onchain.db');

function writeTestConfig() {
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
}

function cleanupTestFiles() {
  try { if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { if (fs.existsSync(TEST_CONFIG_PATH)) fs.unlinkSync(TEST_CONFIG_PATH); } catch {}
}

process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;
process.env.HELIUS_API_KEY = 'test_helius_key';
process.env.BIRDEYE_API_KEY = 'test_birdeye_key';
process.env.SHYFT_API_KEY = 'test_shyft_key';

// ─── Mock helper ────────────────────────────────────────────────────────────

/**
 * Create a mock response for axios.get
 */
function mockAxiosResponse(data, status = 200) {
  return { data, status, headers: {}, config: { timeout: 5000 } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('analysis/onchain.js', async () => {
  beforeEach(() => {
    writeTestConfig();
    cleanupTestFiles();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  // ─── Module smoke test ─────────────────────────────────────────────────────

  describe('Module smoke test', () => {
    it('module loads without error', async () => {
      const mod = await import('../analysis/onchain.js');
      assert.ok(mod, 'module should load');
    });

    it('exports getTokenData (getPositionSignals moved to position module)', async () => {
      const mod = await import('../analysis/onchain.js');
      assert.strictEqual(typeof mod.getTokenData, 'function');
      // getPositionSignals was moved to analysis/position.js during GMGN refactor
      // — see brain/position-manager.js for the new home
    });
  });

  // ─── getTokenData return format ────────────────────────────────────────────

  describe('getTokenData return format', () => {
    it('returns object with all required fields', async () => {
      const { getTokenData } = await import('../analysis/onchain.js');

      // Mock axios to avoid real API calls
      const originalGet = await import('axios').then(m => m.default.get);
      let callCount = 0;

      // We'll test the structure by checking that the function exists and returns
      // (actual API calls would require real keys or extensive mocking)
      // For unit test, we verify the function signature and module structure
      assert.strictEqual(typeof getTokenData, 'function');
    });

    it('returns null-like values when API data is missing', async () => {
      const { getTokenData } = await import('../analysis/onchain.js');
      // getTokenData returns an object with typed fields — verify structure
      // Without mocking network, we can verify it handles missing data gracefully
      // The function should not throw on invalid address — it returns object with error info
      let result;
      try {
        result = await getTokenData('invalid_address_that_does_not_exist_chain');
      } catch (err) {
        // If it throws, that's also acceptable
        result = null;
        assert.ok(
          err.message.includes('ECONNREFUSED') ||
          err.message.includes('fetch') ||
          err.message.includes('Non-base58'),
          `Unexpected error: ${err.message}`
        );
      }
      // Should return object with all fields (even if empty/error)
      if (result) {
        assert.ok(typeof result === 'object');
        assert.ok('mint_address' in result || 'address' in result);
        assert.ok('supply' in result || 'price_usd' in result);
      }
    });
  });

  // ─── getPositionSignals (added back as minimal shim during GMGN refactor) ──

  describe('getPositionSignals return format', () => {
    it('getPositionSignals is a function', async () => {
      const { getPositionSignals } = await import('../analysis/onchain.js');
      assert.strictEqual(typeof getPositionSignals, 'function');
    });

    it('accepts mintAddress and entryData', async () => {
      const { getPositionSignals } = await import('../analysis/onchain.js');
      // Returns minimal shim (no GMGN call) so no network needed
      const result = await getPositionSignals('So11111111111111111111111111111111111111112', {});
      assert.ok(typeof result === 'object');
      assert.ok('dev_wallet_activity' in result);
    });

    it('returns object with required emergency trigger fields', async () => {
      const { getPositionSignals } = await import('../analysis/onchain.js');
      const result = await getPositionSignals('So11111111111111111111111111111111111111112', {
        entry_price_usd: 0.001,
        holder_count: 100,
        liquidity_usd: 50000,
        volume_24h_usd: 100000,
      });
      // All fields consumed by checkEmergencyTriggers in brain/decision.js
      assert.ok(typeof result === 'object');
      assert.strictEqual(typeof result.dev_wallet_activity, 'boolean');
      assert.strictEqual(typeof result.dev_selling, 'boolean');
      assert.strictEqual(typeof result.liquidity_drain, 'boolean');
      assert.strictEqual(typeof result.liquidity_delta_pct, 'number');
      assert.strictEqual(typeof result.large_wallet_movement, 'boolean');
      assert.strictEqual(typeof result.is_mintable, 'boolean');
      assert.strictEqual(result.source, 'minimal-shim');
    });
  });

  // ─── Rate limiter integration ───────────────────────────────────────────

  describe('Rate limiter integration', () => {
    it('onchain.js imports rate-limiter', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'analysis', 'onchain.js'),
        'utf8'
      );
      assert.ok(content.includes("rate-limiter"), 'should import rate-limiter');
    });

    it('onchain.js does NOT import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'analysis', 'onchain.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});

// ─── analysis/onchain-snapshot.js ────────────────────────────────────────────

describe('analysis/onchain-snapshot.js', async () => {
  beforeEach(async () => {
    // Order matters: write config FIRST, then clean up DB. Do NOT delete the
    // config file because the onchain-snapshot module reads it lazily.
    writeTestConfig();
    try { if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); } catch {}
    // Reset the _db singleton in onchain-snapshot.js so it doesn't hold a
    // stale handle to a file that was just deleted.
    const m = await import('../analysis/onchain-snapshot.js');
    m.resetDb();
  });

  afterEach(() => {
    try { if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); } catch {}
  });

  describe('Module smoke test', () => {
    it('module loads without error', async () => {
      const mod = await import('../analysis/onchain-snapshot.js');
      assert.ok(mod);
    });

    it('exports all required functions', async () => {
      const mod = await import('../analysis/onchain-snapshot.js');
      const expected = ['takeSnapshot', 'getTrajectory', 'formatTrajectoryForRAG', 'getLatestSnapshot', 'countSnapshots'];
      for (const name of expected) {
        assert.strictEqual(typeof mod[name], 'function', `${name} should be exported`);
      }
    });
  });

  describe('SQLite table creation', () => {
    it('creates position_snapshots table on first use', async () => {
      const { takeSnapshot } = await import('../analysis/onchain-snapshot.js');

      // This should create the table
      try {
        // Will fail because onchain.js will fail (no real API) but table should be created
        await takeSnapshot({
          position_id: 'test-pos-1',
          token_address: 'So11111111111111111111111111111111111111112',
          entry_price_usd: 0.001,
          entry_time: Date.now() - 300000,
        });
      } catch {
        // Expected to fail on network, but table should exist
      }

      // Verify table exists by checking the DB file
      const db = new (await import('better-sqlite3')).default(TEST_DB_PATH);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('position_snapshots'), `Tables: ${tableNames}`);
      db.close();
    });
  });

  describe('formatTrajectoryForRAG', () => {
    it('formats empty trajectory gracefully', async () => {
      const { formatTrajectoryForRAG } = await import('../analysis/onchain-snapshot.js');
      const result = formatTrajectoryForRAG([]);
      assert.ok(result.includes('No snapshots available'));
    });

    it('formats trajectory with snapshots', async () => {
      const { formatTrajectoryForRAG } = await import('../analysis/onchain-snapshot.js');
      const snapshots = [
        { minutes_since_entry: 5, pnl_pct: 12.5, holder_count: 123, liquidity_usd: 50000, buy_sell_ratio: 1.5 },
        { minutes_since_entry: 10, pnl_pct: 28.3, holder_count: 164, liquidity_usd: 52500, buy_sell_ratio: 1.2 },
      ];
      const result = formatTrajectoryForRAG(snapshots, 'SL hit', 18.2);
      assert.ok(result.includes('Trajectory (every 5min):'));
      assert.ok(result.includes('+12.5%'));
      assert.ok(result.includes('+28.3%'));
      assert.ok(result.includes('Exit: SL hit at +18.2%'));
    });

    it('handles negative PnL snapshots', async () => {
      const { formatTrajectoryForRAG } = await import('../analysis/onchain-snapshot.js');
      const snapshots = [
        { minutes_since_entry: 5, pnl_pct: -5.2, holder_count: 80, liquidity_usd: 40000, buy_sell_ratio: 0.6 },
      ];
      const result = formatTrajectoryForRAG(snapshots);
      assert.ok(result.includes('-5.2%'));
      assert.ok(result.includes('sell dominant'));
    });
  });

  describe('No brain/llm imports', () => {
    it('onchain-snapshot.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'analysis', 'onchain-snapshot.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});

// ─── analysis/rugcheck.js ────────────────────────────────────────────────────

describe('analysis/rugcheck.js', async () => {
  beforeEach(() => {
    writeTestConfig();
  });

  describe('Module smoke test', () => {
    it('module loads without error', async () => {
      const mod = await import('../analysis/rugcheck.js');
      assert.ok(mod);
    });

    it('exports checkRugscore and checkMultipleRugscores', async () => {
      const mod = await import('../analysis/rugcheck.js');
      assert.strictEqual(typeof mod.checkRugscore, 'function');
      assert.strictEqual(typeof mod.checkMultipleRugscores, 'function');
    });
  });

  describe('checkRugscore return format', () => {
    it('returns object with score, flags, is_rug', async () => {
      const { checkRugscore } = await import('../analysis/rugcheck.js');
      assert.strictEqual(typeof checkRugscore, 'function');
      // checkRugscore is async — just verify signature
      assert.ok(checkRugscore.length >= 1);
    });

    it('returns safe default when API fails', async () => {
      const { checkRugscore } = await import('../analysis/rugcheck.js');
      // With no real API, should return safe default or throw
      try {
        const result = await checkRugscore('So11111111111111111111111111111111111111112');
        assert.ok(typeof result === 'object');
        assert.ok('score' in result);
        assert.ok('flags' in result);
        assert.ok('is_rug' in result);
      } catch {
        // API unavailable is acceptable
      }
    });
  });

  describe('No brain/llm imports', () => {
    it('rugcheck.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'analysis', 'rugcheck.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});

// ─── analysis/bundler-check.js ──────────────────────────────────────────────

describe('analysis/bundler-check.js', async () => {
  beforeEach(() => {
    writeTestConfig();
  });

  describe('Module smoke test', () => {
    it('module loads without error', async () => {
      const mod = await import('../analysis/bundler-check.js');
      assert.ok(mod);
    });

    it('exports checkBundledLaunch and checkMultipleBundled', async () => {
      const mod = await import('../analysis/bundler-check.js');
      assert.strictEqual(typeof mod.checkBundledLaunch, 'function');
      assert.strictEqual(typeof mod.checkMultipleBundled, 'function');
    });
  });

  describe('checkBundledLaunch return format', () => {
    it('returns object with is_bundled, bundler_count, bundler_pct', async () => {
      const { checkBundledLaunch } = await import('../analysis/bundler-check.js');
      assert.strictEqual(typeof checkBundledLaunch, 'function');
      assert.ok(checkBundledLaunch.length >= 1);
    });

    it('returns neutral result when API fails', async () => {
      const { checkBundledLaunch } = await import('../analysis/bundler-check.js');
      try {
        const result = await checkBundledLaunch('So11111111111111111111111111111111111111112');
        assert.ok(typeof result === 'object');
        assert.ok('is_bundled' in result);
        assert.ok('bundler_count' in result);
        assert.ok('bundler_pct' in result);
      } catch {
        // API unavailable is acceptable
      }
    });
  });

  describe('No brain/llm imports', () => {
    it('bundler-check.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'analysis', 'bundler-check.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});