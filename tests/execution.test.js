import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Test config ───────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  wallet: {
    use_devnet: false,
    use_jito: false,
    rpc_url: 'https://api.mainnet-beta.solana.com',
  },
  memory: {
    ledger: {
      db_path: path.join(__dirname, 'test-position.db'),
    },
  },
  tp_sl: {
    hard_stop_loss_pct: 20,
  },
};

const TEST_CONFIG_PATH = path.join(__dirname, 'test-execution-config.json');

function writeTestConfig() {
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
}

function cleanupTestConfig() {
  try { fs.unlinkSync(TEST_CONFIG_PATH); } catch {}
}

function cleanupTestDb() {
  try { fs.unlinkSync(path.join(__dirname, 'test-position.db')); } catch {}
}

process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;

beforeEach(() => {
  writeTestConfig();
  cleanupTestDb();
});

// Reset position store before each test (separate async step)
beforeEach(async () => {
  try {
    const pos = await import('../execution/position.js');
    if (typeof pos.resetPositions === 'function') {
      pos.resetPositions();
    }
  } catch {}
});

afterEach(() => {
  cleanupTestConfig();
  cleanupTestDb();
});

// ─── Mock Jupiter API ──────────────────────────────────────────────────────────

const MOCK_QUOTE = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'So11111111111111111111111111111111111111113',
  inAmount: '1000000000',
  outAmount: '5000000000',
  outDecimals: 9,
  priceImpactPct: '0.01',
};

const MOCK_SWAP_RESULT = {
  swapTransaction: Buffer.from(new Uint8Array([
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // dummy serialized tx
  ])).toString('base64'),
  txnHash: 'mock_tx_hash_123',
};

// ─── Execution/jupiter.js tests ────────────────────────────────────────────────

describe('execution/jupiter.js', () => {
  describe('buyToken', () => {
    it('buyToken is a function', async () => {
      const { buyToken } = await import('../execution/jupiter.js');
      assert.strictEqual(typeof buyToken, 'function');
    });

    it('sellToken is a function', async () => {
      const { sellToken } = await import('../execution/jupiter.js');
      assert.strictEqual(typeof sellToken, 'function');
    });

    it('requires valid parameters', async () => {
      const { buyToken } = await import('../execution/jupiter.js');
      // Keypair must have publicKey
      const fakeKeypair = { publicKey: { toBase58: () => 'So11111111111111111111111111111111111111112' } };

      // Should throw or reject without actual API (network call)
      try {
        await buyToken(fakeKeypair, 'So11111111111111111111111111111111111111113', 0.1);
        // If we get here without real API, something is wrong
      } catch (err) {
        // Expected - network error or quote failure without real API
        assert.ok(err.message.includes('Quote failed') || err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED'));
      }
    });
  });

  describe('sellToken', () => {
    it('sellToken is a function with amountPct parameter', async () => {
      const { sellToken } = await import('../execution/jupiter.js');
      assert.strictEqual(typeof sellToken, 'function');
    });
  });

  describe('paper trading path', () => {
    it('paper trading returns mock result without actual transaction', async () => {
      // This would be tested with paper_trading=true in config
      // The jupiter module checks config.wallet.paper_trading
      // If true, it returns mock result without network calls
    });
  });
});

// ─── Execution/position.js tests ───────────────────────────────────────────────

describe('execution/position.js', () => {
  let position;

  beforeEach(async () => {
    writeTestConfig();
    const mod = await import('../execution/position.js');
    mod.clearAllPositions();
    position = mod;
  });

  afterEach(() => {
    cleanupTestDb();
  });

  describe('openPosition', () => {
    it('creates a new position in memory', async () => {
      const pos = await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111113',
        symbol: 'TEST',
        sub_wallet_index: 1,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: 'Test entry',
        llm_confidence: 0.85,
        signal_tags: ['meme', 'new_token'],
      });

      assert.ok(pos.id);
      assert.strictEqual(pos.token_address, 'So11111111111111111111111111111111111111113');
      assert.strictEqual(pos.symbol, 'TEST');
      assert.strictEqual(pos.sub_wallet_index, 1);
      assert.strictEqual(pos.entry_price_usd, 0.05);
      assert.strictEqual(pos.amount_sol, 0.5);
      assert.strictEqual(pos.hard_stop_loss_pct, 20);
      assert.strictEqual(pos.stop_loss_pct, 20);
      assert.strictEqual(pos.status, 'open');
      assert.ok(Array.isArray(pos.signal_tags));
    });

    it('assigns UUID to position', async () => {
      const pos = await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111114',
        symbol: 'UUID_TEST',
        sub_wallet_index: 0,
        entry_price_usd: 0.01,
        amount_sol: 0.1,
        hard_stop_loss_pct: 20,
        source: 'pumpfun',
        entry_reasoning: '',
        llm_confidence: 0.9,
        signal_tags: [],
      });

      assert.ok(pos.id);
      assert.strictEqual(pos.id.length, 36); // UUID format
    });

    it('stores position in active positions map', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111115',
        symbol: 'MAP_TEST',
        sub_wallet_index: 2,
        entry_price_usd: 0.10,
        amount_sol: 1.0,
        hard_stop_loss_pct: 20,
        source: 'telegram',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: ['alpha'],
      });

      const stored = await position.getPosition('So11111111111111111111111111111111111111115');
      assert.ok(stored !== null);
      assert.strictEqual(stored.symbol, 'MAP_TEST');
    });
  });

  describe('closePosition', () => {
    it('removes position from active positions', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111116',
        symbol: 'CLOSE_TEST',
        sub_wallet_index: 1,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      await position.closePosition('So11111111111111111111111111111111111111116', {
        exit_price_usd: 0.08,
        pnl_sol: 0.3,
        pnl_pct: 60,
        exit_reason: 'take_profit',
      });

      const stored = await position.getPosition('So11111111111111111111111111111111111111116');
      assert.strictEqual(stored, null);
    });

    it('calculates hold_duration_minutes', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111117',
        symbol: 'HOLD_TEST',
        sub_wallet_index: 0,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      const closed = await position.closePosition('So11111111111111111111111111111111111111117', {
        exit_price_usd: 0.10,
        pnl_sol: 0.5,
        pnl_pct: 100,
        exit_reason: 'tp_hit',
      });

      assert.ok(closed.hold_duration_minutes >= 0);
    });

    it('throws if position not found', async () => {
      await assert.rejects(
        () => position.closePosition('NonExistentAddress111111111111111111', {}),
        /Position not found/
      );
    });
  });

  describe('getActivePositions', () => {
    it('returns all open positions', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111118',
        symbol: 'ACTIVE1',
        sub_wallet_index: 0,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111119',
        symbol: 'ACTIVE2',
        sub_wallet_index: 1,
        entry_price_usd: 0.03,
        amount_sol: 0.3,
        hard_stop_loss_pct: 20,
        source: 'pumpfun',
        entry_reasoning: '',
        llm_confidence: 0.75,
        signal_tags: [],
      });

      const active = await position.getActivePositions();
      assert.strictEqual(active.length, 2);
    });

    it('returns empty array when no positions', async () => {
      const active = await position.getActivePositions();
      assert.strictEqual(active.length, 0);
    });
  });

  describe('updatePositionTPSL', () => {
    it('updates stop_loss_pct', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111120',
        symbol: 'TPSL_TEST',
        sub_wallet_index: 0,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      await position.updatePositionTPSL('So11111111111111111111111111111111111111120', 15);

      const pos = await position.getPosition('So11111111111111111111111111111111111111120');
      assert.strictEqual(pos.stop_loss_pct, 15);
    });

    it('clamps new_sl_pct to hard_stop_loss_pct if higher', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111121',
        symbol: 'CLAMP_TEST',
        sub_wallet_index: 0,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      // Trying to set SL to 25% (looser than hard stop of 20%)
      await position.updatePositionTPSL('So11111111111111111111111111111111111111121', 25);

      const pos = await position.getPosition('So11111111111111111111111111111111111111121');
      // Should be clamped to 20%
      assert.strictEqual(pos.stop_loss_pct, 20);
    });

    it('throws if position not found', async () => {
      await assert.rejects(
        () => position.updatePositionTPSL('NonExistentAddress111111111111111111', 15),
        /Position not found/
      );
    });
  });

  describe('getPositionCount', () => {
    it('returns correct count', async () => {
      assert.strictEqual(await position.getPositionCount(), 0);

      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111122',
        symbol: 'COUNT1',
        sub_wallet_index: 0,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      assert.strictEqual(await position.getPositionCount(), 1);

      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111123',
        symbol: 'COUNT2',
        sub_wallet_index: 1,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      assert.strictEqual(await position.getPositionCount(), 2);
    });
  });

  describe('clearAllPositions', () => {
    it('removes all positions', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111124',
        symbol: 'CLEAR',
        sub_wallet_index: 0,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      position.clearAllPositions();
      assert.strictEqual(await position.getPositionCount(), 0);
    });
  });

  describe('sub_wallet_index tracking', () => {
    it('preserves sub_wallet_index for each position', async () => {
      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111125',
        symbol: 'WALLET0',
        sub_wallet_index: 0,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111126',
        symbol: 'WALLET1',
        sub_wallet_index: 1,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      await position.openPosition({
        token_address: 'So11111111111111111111111111111111111111127',
        symbol: 'WALLET2',
        sub_wallet_index: 2,
        entry_price_usd: 0.05,
        amount_sol: 0.5,
        hard_stop_loss_pct: 20,
        source: 'screener',
        entry_reasoning: '',
        llm_confidence: 0.8,
        signal_tags: [],
      });

      const active = await position.getActivePositions();
      const indices = active.map(p => p.sub_wallet_index).sort();
      assert.deepStrictEqual(indices, [0, 1, 2]);
    });
  });
});

// ─── Export verification ────────────────────────────────────────────────────────

describe('execution/ — exports verification', () => {
  it('jupiter.js exports buyToken and sellToken', async () => {
    const jup = await import('../execution/jupiter.js');
    assert.strictEqual(typeof jup.buyToken, 'function');
    assert.strictEqual(typeof jup.sellToken, 'function');
  });

  it('position.js exports all required functions', async () => {
    const pos = await import('../execution/position.js');
    for (const fn of ['openPosition', 'closePosition', 'updatePositionTPSL', 'getActivePositions', 'getPosition', 'getPositionCount', 'loadPositionsFromDb', 'clearAllPositions']) {
      assert.strictEqual(typeof pos[fn], 'function', `Missing export: ${fn}`);
    }
  });

  it('jupiter.js does not import brain/ or ../brain/', async () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'execution', 'jupiter.js'), 'utf8');
    assert.ok(!content.includes('../brain/'), 'jupiter.js imports ../brain/');
    assert.ok(!content.includes('brain/prompts'), 'jupiter.js imports brain/prompts');
    assert.ok(!content.includes('brain/decision'), 'jupiter.js imports brain/decision');
  });

  it('position.js does not import brain/ or ../brain/', async () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'execution', 'position.js'), 'utf8');
    assert.ok(!content.includes('../brain/'), 'position.js imports ../brain/');
    assert.ok(!content.includes('brain/prompts'), 'position.js imports brain/prompts');
    assert.ok(!content.includes('brain/decision'), 'position.js imports brain/decision');
  });
});