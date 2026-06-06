import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';

// ─── Mock Config ───────────────────────────────────────────────────────────────
// We can't easily mock fs.readFileSync in ESM, so we create a test config file
// that tests can reference. We'll set __TEST_CONFIG_PATH env var and have
// hard-rules.js check for it.

const TEST_CONFIG = {
  hard_rules: {
    min_liquidity_usd: 5000,
    max_liquidity_usd: 500000,
    min_holders: 50,
    max_dev_wallet_pct: 10,
    min_rugcheck_score: 70,
    block_bundled_launch: true,
    block_mintable: true,
    block_freezable: true,
    max_loss_sol_per_trade: 0.05,
    max_total_exposure_sol: 0.5,
    cooldown_after_consecutive_losses: 3,
    cooldown_duration_minutes: 30,
    hard_stop_loss_pct: 35,
    max_daily_loss_sol: 0.2,
    max_daily_trades: 20,
  },
  position: {
    max_concurrent: 3,
    size_sol: 0.05,
    monitor_interval_ms: 10000,
    snapshot_interval_ms: 300000,
  },
  wallet: {
    rpc_endpoint: 'https://mainnet.helius-rpc.com/?api-key=',
  },
};

// Write test config before importing hard-rules
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_CONFIG_PATH = path.join(__dirname, 'test-config.json');

beforeEach(() => {
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
});

// Set env to point to test config (hard-rules.js checks this)
process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;

// Re-import hard-rules with test config path
const hardRules = await import('../core/hard-rules.js');

// ─── Test Data Factory ─────────────────────────────────────────────────────────

function makeToken(overrides = {}) {
  return {
    address: 'TestToken123456789',
    symbol: 'TEST',
    name: 'Test Token',
    liquidity_usd: 30000,
    holder_count: 200,
    dev_wallet_pct: 5,
    is_mintable: false,
    is_freezable: false,
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    currentExposureSol: 0.1,
    activeCount: 1,
    consecutiveLosses: 0,
    lastLossTime: null,
    dailyLossSol: 0.0,
    dailyTradeCount: 5,
    ...overrides,
  };
}

// ─── Check 1: checkLiquidity ─────────────────────────────────────────────────

describe('checkLiquidity', () => {
  it('PASS: liquidity within bounds', async () => {
    const token = makeToken({ liquidity_usd: 50000 });
    const result = await hardRules.checkLiquidity(token);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('PASS: liquidity at exactly min threshold', async () => {
    const token = makeToken({ liquidity_usd: 5000 });
    const result = await hardRules.checkLiquidity(token);
    assert.strictEqual(result.pass, true);
  });

  it('PASS: liquidity at exactly max threshold', async () => {
    const token = makeToken({ liquidity_usd: 500000 });
    const result = await hardRules.checkLiquidity(token);
    assert.strictEqual(result.pass, true);
  });

  it('FAIL: liquidity below min', async () => {
    const token = makeToken({ liquidity_usd: 4999 });
    const result = await hardRules.checkLiquidity(token);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('liquidity_usd=4999 < min_liquidity_usd=5000'), result.reason);
  });

  it('FAIL: liquidity above max', async () => {
    const token = makeToken({ liquidity_usd: 500001 });
    const result = await hardRules.checkLiquidity(token);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('liquidity_usd=500001 > max_liquidity_usd=500000'), result.reason);
  });

  it('FAIL: liquidity missing', async () => {
    const token = makeToken({ liquidity_usd: undefined });
    const result = await hardRules.checkLiquidity(token);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('missing'), result.reason);
  });
});

// ─── Check 2: checkHolders ───────────────────────────────────────────────────

describe('checkHolders', () => {
  it('PASS: holder_count above min', async () => {
    const token = makeToken({ holder_count: 200 });
    const result = await hardRules.checkHolders(token);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('PASS: holder_count at exactly min', async () => {
    const token = makeToken({ holder_count: 50 });
    const result = await hardRules.checkHolders(token);
    assert.strictEqual(result.pass, true);
  });

  it('FAIL: holder_count below min', async () => {
    const token = makeToken({ holder_count: 49 });
    const result = await hardRules.checkHolders(token);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('holder_count=49 < min_holders=50'), result.reason);
  });

  it('FAIL: holder_count missing', async () => {
    const token = makeToken({ holder_count: undefined });
    const result = await hardRules.checkHolders(token);
    assert.strictEqual(result.pass, false);
  });
});

// ─── Check 3: checkDevWallet ────────────────────────────────────────────────

describe('checkDevWallet', () => {
  it('PASS: dev_wallet_pct below max', async () => {
    const token = makeToken({ dev_wallet_pct: 5 });
    const result = await hardRules.checkDevWallet(token);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('PASS: dev_wallet_pct at exactly max', async () => {
    const token = makeToken({ dev_wallet_pct: 10 });
    const result = await hardRules.checkDevWallet(token);
    assert.strictEqual(result.pass, true);
  });

  it('FAIL: dev_wallet_pct above max', async () => {
    const token = makeToken({ dev_wallet_pct: 11 });
    const result = await hardRules.checkDevWallet(token);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('dev_wallet_pct=11.0% > max_dev_wallet_pct=10%'), result.reason);
  });

  it('FAIL: dev_wallet_pct missing', async () => {
    const token = makeToken({ dev_wallet_pct: undefined });
    const result = await hardRules.checkDevWallet(token);
    assert.strictEqual(result.pass, false);
  });
});

// ─── Check 5: checkMintFreeze ───────────────────────────────────────────────

describe('checkMintFreeze', () => {
  it('PASS: token not mintable and not freezable', async () => {
    const token = makeToken({ is_mintable: false, is_freezable: false });
    const result = await hardRules.checkMintFreeze(token);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('FAIL: token is mintable', async () => {
    const token = makeToken({ is_mintable: true, is_freezable: false });
    const result = await hardRules.checkMintFreeze(token);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('mintable'), result.reason);
  });

  it('FAIL: token is freezable', async () => {
    const token = makeToken({ is_mintable: false, is_freezable: true });
    const result = await hardRules.checkMintFreeze(token);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('freezable'), result.reason);
  });

  it('FAIL: token is both mintable and freezable', async () => {
    const token = makeToken({ is_mintable: true, is_freezable: true });
    const result = await hardRules.checkMintFreeze(token);
    assert.strictEqual(result.pass, false);
  });
});

// ─── Check 7: checkMaxExposure ─────────────────────────────────────────────

describe('checkMaxExposure', () => {
  it('PASS: exposure below max', async () => {
    const result = await hardRules.checkMaxExposure(0.3);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('PASS: exposure at max - epsilon', async () => {
    const result = await hardRules.checkMaxExposure(0.499);
    assert.strictEqual(result.pass, true);
  });

  it('FAIL: exposure at or above max', async () => {
    const result = await hardRules.checkMaxExposure(0.5);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('max_total_exposure_sol=0.5'), result.reason);
  });

  it('FAIL: exposure well above max', async () => {
    const result = await hardRules.checkMaxExposure(1.0);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('>= max_total_exposure_sol=0.5'), result.reason);
  });
});

// ─── Check 8: checkConcurrentPositions ──────────────────────────────────────

describe('checkConcurrentPositions', () => {
  it('PASS: activeCount below max', async () => {
    const result = await hardRules.checkConcurrentPositions(2);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('PASS: activeCount at max - 1', async () => {
    const result = await hardRules.checkConcurrentPositions(2);
    assert.strictEqual(result.pass, true); // max is 3
  });

  it('FAIL: activeCount at max', async () => {
    const result = await hardRules.checkConcurrentPositions(3);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('activeCount=3 >= max_concurrent=3'), result.reason);
  });

  it('FAIL: activeCount above max', async () => {
    const result = await hardRules.checkConcurrentPositions(5);
    assert.strictEqual(result.pass, false);
  });
});

// ─── Check 9: checkCooldown ─────────────────────────────────────────────────

describe('checkCooldown', () => {
  it('PASS: no consecutive losses', async () => {
    const result = await hardRules.checkCooldown(0);
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('PASS: below cooldown threshold', async () => {
    const result = await hardRules.checkCooldown(2);
    assert.strictEqual(result.pass, true);
  });

  it('FAIL: at cooldown threshold with no context', async () => {
    const result = await hardRules.checkCooldown(3);
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('consecutiveLosses=3'), result.reason);
  });

  it('FAIL: cooldown period not yet elapsed', async () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const result = await hardRules.checkCooldown(3, { lastLossTime: fiveMinAgo });
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('cooldown active'), result.reason);
  });

  it('PASS: cooldown period elapsed', async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const result = await hardRules.checkCooldown(3, { lastLossTime: twoHoursAgo });
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });
});

// ─── Check 10: checkCircuitBreaker ──────────────────────────────────────────

describe('checkCircuitBreaker', () => {
  it('PASS: daily loss and trade count both below limits', async () => {
    const result = await hardRules.checkCircuitBreaker({ dailyLossSol: 0.1, dailyTradeCount: 10 });
    assert.strictEqual(result.pass, true);
    assert.strictEqual(result.reason, null);
  });

  it('FAIL: daily loss at limit', async () => {
    const result = await hardRules.checkCircuitBreaker({ dailyLossSol: 0.2, dailyTradeCount: 5 });
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('circuit breaker TRIPPED'), result.reason);
    assert.ok(result.reason.includes('dailyLossSol'), result.reason);
  });

  it('FAIL: daily trade count at limit', async () => {
    const result = await hardRules.checkCircuitBreaker({ dailyLossSol: 0.05, dailyTradeCount: 20 });
    assert.strictEqual(result.pass, false);
    assert.ok(result.reason.includes('circuit breaker TRIPPED'), result.reason);
    assert.ok(result.reason.includes('dailyTradeCount'), result.reason);
  });

  it('FAIL: both limits exceeded', async () => {
    const result = await hardRules.checkCircuitBreaker({ dailyLossSol: 0.5, dailyTradeCount: 50 });
    assert.strictEqual(result.pass, false);
  });

  it('PASS: zero losses, zero trades', async () => {
    const result = await hardRules.checkCircuitBreaker({ dailyLossSol: 0, dailyTradeCount: 0 });
    assert.strictEqual(result.pass, true);
  });
});

// ─── runAllChecks ────────────────────────────────────────────────────────────

describe('runAllChecks', () => {
  it('PASS: all checks pass (rugcheck skip expected for fake tokens)', async () => {
    const token = makeToken({
      liquidity_usd: 50000,
      holder_count: 200,
      dev_wallet_pct: 5,
      is_mintable: false,
      is_freezable: false,
    });
    const ctx = makeContext({
      currentExposureSol: 0.1,
      activeCount: 1,
      consecutiveLosses: 0,
      dailyLossSol: 0,
      dailyTradeCount: 5,
    });

    const result = await hardRules.runAllChecks(token, ctx);
    // rugcheck fails closed for unindexed test tokens — that's expected
    const nonRugcheckFailures = result.failures.filter(f => !f.includes('rugcheck'));
    assert.strictEqual(nonRugcheckFailures.length, 0, `non-rugcheck failures: ${JSON.stringify(nonRugcheckFailures)}`);
  });

  it('FAIL: multiple checks fail', async () => {
    const token = makeToken({
      liquidity_usd: 1000,      // FAIL: below min
      holder_count: 10,           // FAIL: below min
      dev_wallet_pct: 20,         // FAIL: above max
      is_mintable: true,          // FAIL: mintable
      is_freezable: false,
    });
    const ctx = makeContext({
      currentExposureSol: 0.6,    // FAIL: exceeds max
      activeCount: 3,             // FAIL: at max concurrent
      consecutiveLosses: 5,        // FAIL: exceeds cooldown
      dailyLossSol: 0.3,          // FAIL: exceeds daily loss
      dailyTradeCount: 25,         // FAIL: exceeds daily trades
    });

    const result = await hardRules.runAllChecks(token, ctx);
    assert.strictEqual(result.passed, false);
    assert.ok(result.failures.length > 3, 'should have multiple failures');
    // Spot check some specific failure messages
    assert.ok(result.failures.some(f => f.includes('liquidity_usd')), 'should include liquidity failure');
    assert.ok(result.failures.some(f => f.includes('holder_count')), 'should include holder failure');
    assert.ok(result.failures.some(f => f.includes('dev_wallet_pct')), 'should include dev wallet failure');
    assert.ok(result.failures.some(f => f.includes('circuit breaker')), 'should include circuit breaker failure');
  });

  it('FAIL: all checks fail', async () => {
    const token = makeToken({
      liquidity_usd: 100,
      holder_count: 5,
      dev_wallet_pct: 95,
      is_mintable: true,
      is_freezable: true,
    });
    const ctx = makeContext({
      currentExposureSol: 1.0,
      activeCount: 10,
      consecutiveLosses: 10,
      dailyLossSol: 1.0,
      dailyTradeCount: 100,
    });

    const result = await hardRules.runAllChecks(token, ctx);
    assert.strictEqual(result.passed, false);
    assert.ok(result.failures.length >= 6, 'should have at least 6 failures (rugcheck + bundled + liquidity + holders + dev_wallet + exposure)');
  });

  it('PASS: borderline but valid values (rugcheck skips for unknown tokens)', async () => {
    // Note: rugcheck API fails closed (400 for unindexed tokens), so we check that
    // non-rugcheck rules pass (liquidity, holders, dev_wallet, mint/freeze, exposure,
    // concurrent, cooldown, circuit breaker all pass). Rugcheck failure is expected
    // for fake test addresses and does not indicate a real problem.
    const token = makeToken({
      liquidity_usd: 5000,
      holder_count: 50,
      dev_wallet_pct: 10,
      is_mintable: false,
      is_freezable: false,
    });
    const ctx = makeContext({
      currentExposureSol: 0,
      activeCount: 0,
      consecutiveLosses: 0,
      dailyLossSol: 0,
      dailyTradeCount: 0,
    });

    const result = await hardRules.runAllChecks(token, ctx);
    // All structural checks should pass; only rugcheck may fail for fake test tokens
    const nonRugcheckFailures = result.failures.filter(f => !f.includes('rugcheck'));
    assert.strictEqual(nonRugcheckFailures.length, 0, `non-rugcheck failures: ${JSON.stringify(nonRugcheckFailures)}`);
  });
});

// ─── Critical: No LLM imports ───────────────────────────────────────────────

describe('CRITICAL: No LLM import in hard-rules.js', () => {
  it('hard-rules.js does not import from brain/ folder', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'hard-rules.js'),
      'utf8'
    );
    const brainImportPattern = /import.*from.*['"]\.\/brain\//;
    const brainRequirePattern = /require\(['"]\.\/brain\//;
    assert.ok(
      !brainImportPattern.test(content) && !brainRequirePattern.test(content),
      'hard-rules.js must not import from brain/ folder'
    );
  });

  it('hard-rules.js does not import from brain/ folder (relative path)', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'core', 'hard-rules.js'),
      'utf8'
    );
    const pattern = /import.*from.*['"]\.\.\/brain\//;
    assert.ok(!pattern.test(content), 'hard-rules.js must not import from brain/ via ../brain/');
  });
});

// ─── LLM cannot override hard rules ─────────────────────────────────────────

describe('CRITICAL: LLM cannot override hard rules results', () => {
  it('runAllChecks does not accept LLM-provided override parameters', async () => {
    // Verify the function signature only accepts tokenData and context
    // Any override would have to be passed as part of tokenData/context
    // which would be a data injection attack, not a LLM override
    const token = makeToken();
    const ctx = makeContext();

    // Calling with extra fields in context should not change behavior
    const result1 = await hardRules.runAllChecks(token, ctx);
    const result2 = await hardRules.runAllChecks(token, { ...ctx, __llm_override: true });

    assert.strictEqual(result1.passed, result2.passed, 'LLM should not be able to override hard rules via context');
  });
});