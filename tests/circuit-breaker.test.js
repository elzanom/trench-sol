import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Test Config ─────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  hard_rules: {
    max_daily_loss_sol: 0.2,
    max_daily_trades: 20,
  },
  circuit_breaker: {
    enabled: true,
    notify_telegram: false, // disable in tests
    reset_hour_utc: 0,
  },
  memory: {
    ledger: {
      db_path: path.join(__dirname, 'test-cb.db'),
    },
  },
  rate_limits: { helius_rps: 10 },
};

const TEST_CONFIG_PATH = path.join(__dirname, 'test-cb-config.json');
const TEST_DB_PATH = path.join(__dirname, 'test-cb.db');

function writeTestConfig() {
  const cfg = { ...TEST_CONFIG };
  // Use unique db_path per call to force fresh DB (bypass _db cache)
  cfg.memory = cfg.memory || {};
  cfg.memory.ledger = cfg.memory.ledger || {};
  cfg.memory.ledger.db_path = `/tmp/cb-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  // Use JSON env var to avoid file system timing issues
  process.env.__TEST_CONFIG_JSON = JSON.stringify(cfg);
}

function cleanupTestFiles() {
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch {}
  try {
    if (fs.existsSync(TEST_CONFIG_PATH)) fs.unlinkSync(TEST_CONFIG_PATH);
  } catch {}
}

// ─── Setup env + import module ────────────────────────────────────────────────

process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;
process.env.TELEGRAM_NOTIFY_CHAT_ID = 'test_chat_123';

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Re-import circuit-breaker with fresh state
async function getCircuitBreaker() {
  // Force fresh module load with unique timestamp to break _db cache
  return import('../core/circuit-breaker.js?t=' + Date.now() + '&v=' + Math.random());
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('core/circuit-breaker.js', async () => {
  beforeEach(() => {
    writeTestConfig();
    cleanupTestFiles();
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  // ─── Initial state ─────────────────────────────────────────────────────────

  describe('Initial state', () => {
    it('check() returns allowed on fresh day', async () => {
      const cb = await getCircuitBreaker();
      const result = await cb.check();
      assert.deepStrictEqual(result, { allowed: true, reason: null });
    });

    it('getDailyStats() returns zero values for new day', async () => {
      const cb = await getCircuitBreaker();
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.date, getTodayStr());
      assert.strictEqual(stats.loss_sol_today, 0);
      assert.strictEqual(stats.trade_count_today, 0);
      assert.strictEqual(stats.is_tripped, false);
      assert.strictEqual(stats.tripped_at, null);
    });
  });

  // ─── recordLoss ─────────────────────────────────────────────────────────────

  describe('recordLoss', () => {
    it('recordLoss increments loss_sol_today', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(0.05);
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.loss_sol_today, 0.05);
    });

    it('recordLoss accumulates multiple losses', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(0.05);
      await cb.recordLoss(0.03);
      await cb.recordLoss(0.07);
      const stats = await cb.getDailyStats();
      // Use approximate comparison for floating point
      assert.ok(Math.abs(stats.loss_sol_today - 0.15) < 0.001, `Expected ~0.15, got ${stats.loss_sol_today}`);
    });

    it('recordLoss with negative value still adds absolute', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(-0.1);
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.loss_sol_today, 0.1);
    });

    it('loss reaches max_daily_loss_sol → breaker trips', async () => {
      const cb = await getCircuitBreaker();
      const result = await cb.recordLoss(0.2); // exactly at limit
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.is_tripped, true);
      assert.ok(stats.tripped_reason.includes('Daily loss limit'));
    });

    it('check() returns not allowed when tripped', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(0.2); // trip the breaker
      const result = await cb.check();
      assert.strictEqual(result.allowed, false);
      assert.ok(result.reason.includes('Daily loss limit'));
    });
  });

  // ─── recordTrade ────────────────────────────────────────────────────────────

  describe('recordTrade', () => {
    it('recordTrade increments trade_count_today', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordTrade();
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.trade_count_today, 1);
    });

    it('recordTrade accumulates correctly', async () => {
      const cb = await getCircuitBreaker();
      for (let i = 0; i < 5; i++) await cb.recordTrade();
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.trade_count_today, 5);
    });

    it('trade count reaches max_daily_trades → breaker trips', async () => {
      const cb = await getCircuitBreaker();
      // max_daily_trades = 20
      for (let i = 0; i < 20; i++) await cb.recordTrade();
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.is_tripped, true);
      assert.ok(stats.tripped_reason.includes('trade count'));
    });
  });

  // ─── reset ─────────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('reset clears loss, trade count, and tripped state', async () => {
      const cb = await getCircuitBreaker();

      // Build up some state and trip the breaker
      await cb.recordLoss(0.1);
      await cb.recordTrade();
      await cb.recordTrade();
      const before = await cb.getDailyStats();
      assert.strictEqual(before.loss_sol_today, 0.1);
      assert.strictEqual(before.trade_count_today, 2);

      // Reset
      await cb.reset();

      const after = await cb.getDailyStats();
      assert.strictEqual(after.loss_sol_today, 0);
      assert.strictEqual(after.trade_count_today, 0);
      assert.strictEqual(after.is_tripped, false);
      assert.strictEqual(after.tripped_at, null);
      assert.strictEqual(after.tripped_reason, null);
    });

    it('check() returns allowed after manual reset', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(0.2); // trip
      await cb.reset();
      const result = await cb.check();
      assert.deepStrictEqual(result, { allowed: true, reason: null });
    });
  });

  // ─── Monitoring continues when tripped ─────────────────────────────────────

  describe('Monitoring continues when tripped', () => {
    it('breaker trips but monitoring functions still work', async () => {
      const cb = await getCircuitBreaker();

      // Trip the breaker
      await cb.recordLoss(0.2);
      assert.strictEqual((await cb.check()).allowed, false);

      // getDailyStats still works even when tripped
      const stats = await cb.getDailyStats();
      assert.ok(typeof stats.loss_sol_today === 'number');
      assert.ok(typeof stats.trade_count_today === 'number');
      assert.strictEqual(stats.is_tripped, true);

      // recordTrade still works (trades can still be recorded during trip)
      await cb.recordTrade(); // should still work
      const stats2 = await cb.getDailyStats();
      assert.strictEqual(stats2.trade_count_today, 1);
    });
  });

  // ─── Auto-reset scheduling ──────────────────────────────────────────────────

  describe('Auto-reset scheduler', () => {
    it('startAutoResetScheduler returns a function (interval started)', async () => {
      const cb = await getCircuitBreaker();
      const fn = cb.startAutoResetScheduler;
      assert.strictEqual(typeof fn, 'function', 'should be a function that returns void');
    });

    it('checkAutoReset is a callable function', async () => {
      const cb = await getCircuitBreaker();
      assert.strictEqual(typeof cb.checkAutoReset, 'function');
      // Calling it should not throw
      cb.checkAutoReset();
    });
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('loss slightly below limit does not trip', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(0.199);
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.is_tripped, false);
      const result = await cb.check();
      assert.strictEqual(result.allowed, true);
    });

    it('trade count slightly below limit does not trip', async () => {
      const cb = await getCircuitBreaker();
      for (let i = 0; i < 19; i++) await cb.recordTrade();
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.is_tripped, false);
      const result = await cb.check();
      assert.strictEqual(result.allowed, true);
    });

    it('recordLoss handles zero amount', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(0);
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.loss_sol_today, 0);
    });

    it('multiple resets in same day work', async () => {
      const cb = await getCircuitBreaker();
      await cb.recordLoss(0.1);
      await cb.reset();
      await cb.recordLoss(0.15);
      await cb.reset();
      const stats = await cb.getDailyStats();
      assert.strictEqual(stats.loss_sol_today, 0);
    });
  });

  // ─── No LLM / brain imports ────────────────────────────────────────────────

  describe('CRITICAL: no brain/ or llm imports', () => {
    it('circuit-breaker.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'core', 'circuit-breaker.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});