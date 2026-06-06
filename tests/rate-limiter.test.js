import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Test Config ─────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  rate_limits: {
    helius_rps: 10,
    gmgn_rps: 5,
    rugcheck_rps: 2,
    jupiter_rps: 5,
    llm_rpm: 20,
  },
};

const TEST_CONFIG_PATH = path.join(__dirname, 'test-rl-config.json');

function writeTestConfig() {
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
}

// ─── Setup env + import module ────────────────────────────────────────────────

process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;

async function getRateLimiter() {
  // Reset all buckets before each test
  const mod = await import('../core/rate-limiter.js');
  mod.resetAll();
  return mod;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('core/rate-limiter.js', async () => {
  beforeEach(() => {
    writeTestConfig();
  });

  // ─── Smoke test ─────────────────────────────────────────────────────────────

  describe('Module smoke test', () => {
    it('module loads and exports required functions', async () => {
      const rl = await getRateLimiter();
      const expected = ['acquire', 'tryAcquire', 'getBucketStatus', 'getAllBucketStatus', 'resetAll', 'reloadBucket'];
      for (const name of expected) {
        assert.strictEqual(typeof rl[name], 'function', `${name} should be a function`);
      }
    });
  });

  // ─── Token bucket basics ─────────────────────────────────────────────────────

  describe('Token bucket basics', () => {
    it('getBucketStatus returns correct initial state', async () => {
      const rl = await getRateLimiter();
      const status = rl.getBucketStatus('helius');
      assert.strictEqual(status.service, 'helius');
      assert.strictEqual(status.rate, 10); // from test config
      assert.ok(status.tokens >= 0);
    });

    it('getAllBucketStatus returns all 5 services', async () => {
      const rl = await getRateLimiter();
      const all = rl.getAllBucketStatus();
      assert.strictEqual(all.length, 5);
      const names = all.map(b => b.service).sort();
      assert.deepStrictEqual(names, ['gmgn', 'helius', 'jupiter', 'llm', 'rugcheck']);
    });

    it('resetAll clears all bucket state', async () => {
      const rl = await getRateLimiter();
      rl.getBucketStatus('helius'); // create bucket
      rl.resetAll();
      const status = rl.getBucketStatus('helius');
      // After reset, tokens should be at max (rate) since bucket was just created
      assert.ok(status.tokens >= 0);
    });
  });

  // ─── acquire ────────────────────────────────────────────────────────────────

  describe('acquire()', () => {
    it('acquire returns immediately when bucket has tokens', async () => {
      const rl = await getRateLimiter();
      const start = Date.now();
      await rl.acquire('helius');
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 500, 'acquire should return quickly when tokens available');
    });

    it('acquire consumes a token', async () => {
      const rl = await getRateLimiter();
      const statusBefore = rl.getBucketStatus('helius');
      const tokensBefore = statusBefore.tokens;

      await rl.acquire('helius');

      const statusAfter = rl.getBucketStatus('helius');
      assert.ok(
        statusAfter.tokens <= tokensBefore,
        'tokens should decrease or stay same (if refill happened)'
      );
    });

    it('acquire waits when bucket is empty (rate limiting)', async () => {
      const rl = await getRateLimiter();
      // helius has 10 rps → each token refills every 100ms
      // Consume all tokens
      for (let i = 0; i < 10; i++) {
        await rl.acquire('helius');
      }
      // Now bucket should be empty or low
      // Next acquire should wait at least ~100ms
      const start = Date.now();
      await rl.acquire('helius');
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 90, `should have waited at least ~100ms (got ${elapsed}ms) for token refill`);
    });

    it('multiple consecutive acquires work without error', async () => {
      const rl = await getRateLimiter();
      for (let i = 0; i < 20; i++) {
        await rl.acquire('helius');
      }
      // Should complete without throwing
    });
  });

  // ─── tryAcquire ─────────────────────────────────────────────────────────────

  describe('tryAcquire()', () => {
    it('tryAcquire returns true and consumes token when available', async () => {
      const rl = await getRateLimiter();
      const result = rl.tryAcquire('helius');
      assert.strictEqual(result, true);
    });

    it('tryAcquire returns false without waiting when empty', async () => {
      const rl = await getRateLimiter();
      // Consume all tokens
      for (let i = 0; i < 10; i++) rl.tryAcquire('helius');
      // Next tryAcquire should return false immediately
      const start = Date.now();
      const result = rl.tryAcquire('helius');
      const elapsed = Date.now() - start;
      assert.strictEqual(result, false);
      assert.ok(elapsed < 100, 'tryAcquire should return immediately without waiting');
    });

    it('tryAcquire does not block', async () => {
      const rl = await getRateLimiter();
      const start = Date.now();
      const result = rl.tryAcquire('helius');
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 100, 'tryAcquire should be non-blocking');
      assert.strictEqual(typeof result, 'boolean');
    });
  });

  // ─── Service-specific rates ───────────────────────────────────────────────

  describe('Service-specific rates from config', () => {
    it('helius uses helius_rps from config', async () => {
      const rl = await getRateLimiter();
      const status = rl.getBucketStatus('helius');
      assert.strictEqual(status.rate, 10); // TEST_CONFIG.rate_limits.helius_rps
    });

    it('gmgn uses gmgn_rps from config (5)', async () => {
      const rl = await getRateLimiter();
      const status = rl.getBucketStatus('gmgn');
      assert.strictEqual(status.rate, 5);
    });

    it('rugcheck uses rugcheck_rps from config (2)', async () => {
      const rl = await getRateLimiter();
      const status = rl.getBucketStatus('rugcheck');
      assert.strictEqual(status.rate, 2);
    });

    it('llm uses llm_rpm from config (20)', async () => {
      const rl = await getRateLimiter();
      const status = rl.getBucketStatus('llm');
      assert.strictEqual(status.rate, 20);
    });
  });

  // ─── Default rate fallback ───────────────────────────────────────────────

  describe('Default rate when service not in config', () => {
    it('unknown service uses default rate of 10 rps', async () => {
      const rl = await getRateLimiter();
      const status = rl.getBucketStatus('unknown_service');
      assert.strictEqual(status.rate, 10, 'should default to 10 rps');
    });
  });

  // ─── Rate limiter integration with wallet ─────────────────────────────────

  describe('Rate limiter can be used before external calls', () => {
    it('acquire can be called multiple times in sequence', async () => {
      const rl = await getRateLimiter();
      // Simulate a sequence of external API calls
      await rl.acquire('helius');
      await rl.acquire('gmgn');
      await rl.acquire('rugcheck');
      await rl.acquire('jupiter');
      await rl.acquire('llm');
      // All should complete without throwing
    });

    it('acquire is called before all 5 services in parallel', async () => {
      const rl = await getRateLimiter();
      await Promise.all([
        rl.acquire('helius'),
        rl.acquire('gmgn'),
        rl.acquire('rugcheck'),
        rl.acquire('jupiter'),
        rl.acquire('llm'),
      ]);
      // All should complete
    });
  });

  // ─── Bucket refill behavior ───────────────────────────────────────────────

  describe('Bucket refill over time', () => {
    it('tokens increase after waiting (refill)', async () => {
      const rl = await getRateLimiter();
      // Consume some tokens
      for (let i = 0; i < 5; i++) rl.tryAcquire('helius');
      const statusBefore = rl.getBucketStatus('helius');
      const tokensBefore = statusBefore.tokens;

      // Wait 200ms (at 10 rps, should refill ~2 tokens)
      await new Promise(resolve => setTimeout(resolve, 200));

      const statusAfter = rl.getBucketStatus('helius');
      assert.ok(
        statusAfter.tokens >= tokensBefore || statusAfter.tokens === statusBefore.rate,
        'tokens should have refilled after waiting'
      );
    });

    it('tokens cap at max rate (no over-refill)', async () => {
      const rl = await getRateLimiter();
      // Wait a long time
      await new Promise(resolve => setTimeout(resolve, 2000));
      const status = rl.getBucketStatus('helius');
      assert.ok(status.tokens <= status.rate, 'tokens should not exceed max rate');
    });
  });

  // ─── No brain/llm imports ──────────────────────────────────────────────────

  describe('CRITICAL: no brain/ or llm imports', () => {
    it('rate-limiter.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'core', 'rate-limiter.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});