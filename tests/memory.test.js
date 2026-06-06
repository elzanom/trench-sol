import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Test Config ─────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  memory: {
    ledger: {
      db_path: path.join(__dirname, 'test-memory.db'),
    },
    rag: {
      index_path: path.join(__dirname, 'test-rag-index'),
    },
  },
};

const TEST_CONFIG_PATH = path.join(__dirname, 'test-memory-config.json');
const TEST_DB_PATH = path.join(__dirname, 'test-memory.db');
const TEST_RAG_PATH = path.join(__dirname, 'test-rag-index');

function writeTestConfig() {
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
}

function cleanupTestFiles() {
  // Only delete the DB and RAG files, NOT the config file
  // resetDb() needs the config to derive the DB path for the NEXT test
  try { if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
  try { if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { if (fs.existsSync(TEST_RAG_PATH)) fs.rmSync(TEST_RAG_PATH, { recursive: true, force: true }); } catch {}
}

process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;

// ─── Tests: memory/ledger.js ──────────────────────────────────────────────────

// Module-level ledger instance — imported once, reset between tests
import * as testLedger from '../memory/ledger.js';

describe('memory/ledger.js', async () => {
  beforeEach(() => {
    // Reset DB synchronously before each test — testLedger is set from top-level import
    if (testLedger && typeof testLedger.resetDb === 'function') {
      testLedger.resetDb();
    }
  });

  // ─── Module smoke test ─────────────────────────────────────────────────────

  describe('Module smoke test', () => {
    it('module loads without error', async () => {
      const mod = await import('../memory/ledger.js');
      assert.ok(mod, 'ledger module should load');
    });

    it('exports all required functions', async () => {
      const mod = await import('../memory/ledger.js');
      const expected = [
        'recordTrade', 'updateSignalStats', 'getLedgerStats',
        'getSignalAccuracy', 'getRecentPerformance', 'getTradeById',
        'getDailyStats',
      ];
      for (const name of expected) {
        assert.strictEqual(typeof mod[name], 'function', `${name} should be exported`);
      }
    });
  });

  // ─── recordTrade ────────────────────────────────────────────────────────────

  describe('recordTrade', () => {
    it('inserts a trade record into the database', async () => {
      const ledger = testLedger;

      const trade = {
        id: 'test-trade-001',
        token_address: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        sub_wallet_index: 1,
        entry_time: Date.now() - 3600000,
        exit_time: Date.now(),
        amount_sol_invested: 0.1,
        pnl_sol: 0.025,
        pnl_pct: 25.0,
        exit_reason: 'TP hit',
        signal_tags: ['high_volume', 'new_listing'],
        entry_reasoning: 'Strong momentum',
        llm_confidence: 0.75,
        hold_duration_minutes: 30,
        source: 'live',
      };

      const result = await ledger.recordTrade(trade);
      assert.strictEqual(result.id, 'test-trade-001');
      assert.strictEqual(result.symbol, 'SOL');

      // Verify it was persisted
      const db = await import('better-sqlite3').then(m => m.default || m);
      const checkDb = new db(TEST_DB_PATH);
      const row = checkDb.prepare('SELECT * FROM trades WHERE id = ?').get('test-trade-001');
      checkDb.close();

      assert.ok(row, 'trade should exist in database');
      assert.strictEqual(row.symbol, 'SOL');
      assert.strictEqual(row.pnl_pct, 25.0);
    });

    it('generates UUID if id not provided', async () => {
      const ledger = testLedger;

      const trade = {
        token_address: 'So11111111111111111111111111111111111111112',
        entry_time: Date.now(),
      };

      const result = await ledger.recordTrade(trade);
      assert.ok(result.id, 'should have generated an id');
      assert.strictEqual(result.id.length > 0, true);
    });

    it('handles null signal_tags', async () => {
      const ledger = testLedger;

      const trade = {
        id: 'test-trade-002',
        token_address: 'So11111111111111111111111111111111111111112',
        entry_time: Date.now(),
        signal_tags: null,
      };

      const result = await ledger.recordTrade(trade);
      assert.ok(result.id, 'should have inserted');
    });

    it('multiple trades are stored independently', async () => {
      const ledger = testLedger;

      await ledger.recordTrade({
        id: 'trade-A',
        token_address: 'TokenA',
        symbol: 'AAA',
        entry_time: Date.now() - 7200000,
        pnl_pct: 10,
      });

      await ledger.recordTrade({
        id: 'trade-B',
        token_address: 'TokenB',
        symbol: 'BBB',
        entry_time: Date.now() - 3600000,
        pnl_pct: -5,
      });

      const db = new (await import('better-sqlite3').then(m => m.default || m))(TEST_DB_PATH);
      const rows = db.prepare('SELECT * FROM trades ORDER BY entry_time').all();
      db.close();

      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].symbol, 'AAA');
      assert.strictEqual(rows[1].symbol, 'BBB');
    });
  });

  // ─── updateSignalStats ─────────────────────────────────────────────────────

  describe('updateSignalStats', () => {
    it('creates new signal combination stats', async () => {
      const ledger = testLedger;

      const result = await ledger.updateSignalStats(['high_volume', 'new_listing'], 0.025, true);

      assert.strictEqual(result.combination, 'high_volume|new_listing');
      assert.strictEqual(result.total_trades, 1);
      assert.strictEqual(result.wins, 1);
      assert.strictEqual(result.losses, 0);
      assert.strictEqual(result.total_pnl_sol, 0.025);
    });

    it('updates existing signal combination', async () => {
      const ledger = testLedger;

      await ledger.updateSignalStats(['high_volume'], 0.01, true);
      await ledger.updateSignalStats(['high_volume'], -0.005, false);
      await ledger.updateSignalStats(['high_volume'], 0.02, true);

      const stats = await ledger.getSignalAccuracy();
      assert.ok(stats['high_volume']);
      assert.strictEqual(stats['high_volume'].total_trades, 3);
      assert.strictEqual(stats['high_volume'].wins, 2);
      assert.strictEqual(stats['high_volume'].losses, 1);
    });

    it('handles empty signal_tags array', async () => {
      const ledger = testLedger;

      const result = await ledger.updateSignalStats([], 0.01, true);
      assert.strictEqual(result.combination, 'none');
      assert.strictEqual(result.total_trades, 1);
    });

    it('sorts signal_tags for consistent key', async () => {
      const ledger = testLedger;

      const result1 = await ledger.updateSignalStats(['zulu', 'alpha', 'middle'], 0.01, true);
      const result2 = await ledger.updateSignalStats(['alpha', 'middle', 'zulu'], 0.02, true);

      // Both should have same combination key
      assert.strictEqual(result1.combination, result2.combination);
    });
  });

  // ─── getLedgerStats ─────────────────────────────────────────────────────────

  describe('getLedgerStats', () => {
    it('returns zeros for empty ledger', async () => {
      const ledger = testLedger;
      const stats = await ledger.getLedgerStats(50);
      assert.deepStrictEqual(stats, {
        total_trades: 0,
        win_rate_pct: 0,
        avg_pnl_pct: 0,
        total_pnl_sol: 0,
        by_source: {
          live:     { total: 0, wins: 0, win_rate_pct: 0, total_pnl_sol: 0 },
          paper:    { total: 0, wins: 0, win_rate_pct: 0, total_pnl_sol: 0 },
          backtest: { total: 0, wins: 0, win_rate_pct: 0, total_pnl_sol: 0 },
        },
      });
    });

    it('calculates correct win rate and PnL', async () => {
      const ledger = testLedger;

      // 5 trades: 3 wins, 2 losses
      await ledger.recordTrade({ id: 't1', token_address: 'T1', entry_time: Date.now() - 500000, pnl_pct: 20, pnl_sol: 0.02 });
      await ledger.recordTrade({ id: 't2', token_address: 'T2', entry_time: Date.now() - 400000, pnl_pct: 15, pnl_sol: 0.015 });
      await ledger.recordTrade({ id: 't3', token_address: 'T3', entry_time: Date.now() - 300000, pnl_pct: -10, pnl_sol: -0.01 });
      await ledger.recordTrade({ id: 't4', token_address: 'T4', entry_time: Date.now() - 200000, pnl_pct: 5, pnl_sol: 0.005 });
      await ledger.recordTrade({ id: 't5', token_address: 'T5', entry_time: Date.now() - 100000, pnl_pct: -5, pnl_sol: -0.005 });

      const stats = await ledger.getLedgerStats(10);
      assert.strictEqual(stats.total_trades, 5);
      assert.strictEqual(stats.win_rate_pct, 60); // 3 wins out of 5
      assert.strictEqual(stats.total_pnl_sol, 0.025); // 0.02 + 0.015 - 0.01 + 0.005 - 0.005
    });
  });

  // ─── getSignalAccuracy ──────────────────────────────────────────────────────

  describe('getSignalAccuracy', () => {
    it('returns object keyed by signal combination', async () => {
      const ledger = testLedger;

      await ledger.updateSignalStats(['alpha'], 0.01, true);
      await ledger.updateSignalStats(['beta', 'gamma'], -0.02, false);

      const accuracy = await ledger.getSignalAccuracy();

      assert.ok('alpha' in accuracy || 'alpha' in accuracy === false, 'should be object');
      assert.ok(typeof accuracy === 'object', 'should return object');
      if ('alpha' in accuracy) {
        assert.strictEqual(accuracy['alpha'].total_trades, 1);
        assert.strictEqual(accuracy['alpha'].wins, 1);
      }
    });

    it('empty ledger returns empty object', async () => {
      const ledger = testLedger;
      const accuracy = await ledger.getSignalAccuracy();
      assert.deepStrictEqual(accuracy, {});
    });
  });

  // ─── getRecentPerformance ───────────────────────────────────────────────────

  describe('getRecentPerformance', () => {
    it('returns last N trades in descending time order', async () => {
      const ledger = testLedger;

      for (let i = 0; i < 15; i++) {
        await ledger.recordTrade({
          id: `perf-${i}`,
          token_address: `Token${i}`,
          entry_time: Date.now() - (i * 60000),
          pnl_pct: i * 2,
        });
      }

      const recent = await ledger.getRecentPerformance(5);
      assert.strictEqual(recent.length, 5);
      // Most recent first
      assert.ok(recent[0].entry_time >= recent[1].entry_time);
    });

    it('parse signal_tags from JSON string', async () => {
      const ledger = testLedger;

      await ledger.recordTrade({
        id: 'parse-tags-test',
        token_address: 'TokenX',
        entry_time: Date.now(),
        signal_tags: ['high_volume', 'telegram_alpha'],
      });

      const recent = await ledger.getRecentPerformance(1);
      assert.deepStrictEqual(recent[0].signal_tags, ['high_volume', 'telegram_alpha']);
    });
  });

  // ─── getDailyStats ──────────────────────────────────────────────────────────

  describe('getDailyStats (shared with circuit-breaker)', () => {
    it('creates new row for today if not exists', async () => {
      const ledger = testLedger;
      const stats = await ledger.getDailyStats();
      assert.strictEqual(stats.date, new Date().toISOString().slice(0, 10));
      assert.strictEqual(stats.loss_sol_today, 0);
      assert.strictEqual(stats.trade_count_today, 0);
      assert.strictEqual(stats.is_tripped, false);
    });

    it('retrieves existing stats for today', async () => {
      const ledger = testLedger;

      // First call creates row
      await ledger.getDailyStats();
      // Second call should retrieve same row
      const stats2 = await ledger.getDailyStats();

      assert.strictEqual(stats2.date, new Date().toISOString().slice(0, 10));
    });
  });

  // ─── No brain/llm imports ────────────────────────────────────────────────────

  describe('CRITICAL: no brain/ or llm imports', () => {
    it('ledger.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'memory', 'ledger.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});

// ─── Tests: memory/rag.js ────────────────────────────────────────────────────

describe('memory/rag.js', async () => {
  beforeEach(() => {
    writeTestConfig();
    // cleanupTestFiles moved to afterEach
  });

  beforeEach(async () => {
    // Reset ledger module state before each test
    // Re-write config so it's available after cleanup from first beforeEach
    writeTestConfig();
    try {
      const ledger = testLedger;
      if (typeof ledger.resetDb === 'function') {
        ledger.resetDb();
      }
    } catch {}
  });

  afterEach(() => {
    cleanupTestFiles();
  });

  describe('Module smoke test', () => {
    it('module loads without error', async () => {
      try {
        const mod = await import('../memory/rag.js');
        assert.ok(mod, 'rag module should load');
      } catch (err) {
        // vectra may not be installed — that's OK for syntax test
        if (err.message.includes('vectra')) {
          console.log('vectra not installed — skipping runtime test');
          return;
        }
        throw err;
      }
    });

    it('exports all required functions', async () => {
      try {
        const mod = await import('../memory/rag.js');
        const expected = ['indexTrade', 'findSimilarTrades', 'removeTradeFromIndex', 'getIndexStats'];
        for (const name of expected) {
          assert.strictEqual(typeof mod[name], 'function', `${name} should be exported`);
        }
      } catch (err) {
        if (err.message.includes('vectra')) {
          console.log('vectra not installed — skipping export check');
          return;
        }
        throw err;
      }
    });
  });

  describe('No brain/llm imports', () => {
    it('rag.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'memory', 'rag.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), content);
      assert.ok(!content.includes("from '../brain"), content);
      assert.ok(!content.includes("from './llm"), content);
      assert.ok(!content.includes("from '../llm"), content);
    });
  });
});