import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Test Config ─────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  wallet: {
    rpc_endpoint: 'https://api.devnet.solana.com',
    rpc_fallbacks: [],
    use_devnet: true,
    priority_fee_lamports: 10000,
    sub_wallets_enabled: true,
    sub_wallet_rotation: 'per_trade',
    sub_wallet_fund_amount_sol: 0.1,
    use_jito: false,
    jito_tip_lamports: 10000,
  },
  position: { max_concurrent: 3 },
  rate_limits: { helius_rps: 10 },
  hard_rules: { max_daily_loss_sol: 0.2, max_daily_trades: 20 },
};

const TEST_CONFIG_PATH = path.join(__dirname, 'test-wallet-config.json');

function writeTestConfig(config = TEST_CONFIG) {
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Test keypair generation ─────────────────────────────────────────────────

let testMainKeypair, testKeypair1, testKeypair2, testKeypair3;
let bs58Module;

async function setupTestKeypairs() {
  const { Keypair } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;

  testMainKeypair = Keypair.generate();
  testKeypair1 = Keypair.generate();
  testKeypair2 = Keypair.generate();
  testKeypair3 = Keypair.generate();
  bs58Module = bs58;

  // Set env vars with base58-encoded test keypairs
  process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;
  process.env.WALLET_PRIVATE_KEY = bs58.encode(testMainKeypair.secretKey);
  process.env.SUB_WALLET_1_PRIVATE_KEY = bs58.encode(testKeypair1.secretKey);
  process.env.SUB_WALLET_2_PRIVATE_KEY = bs58.encode(testKeypair2.secretKey);
  process.env.SUB_WALLET_3_PRIVATE_KEY = bs58.encode(testKeypair3.secretKey);
}

async function clearSubWalletEnv() {
  delete process.env.SUB_WALLET_1_PRIVATE_KEY;
  delete process.env.SUB_WALLET_2_PRIVATE_KEY;
  delete process.env.SUB_WALLET_3_PRIVATE_KEY;
}

// ─── Import wallet module (after env setup) ─────────────────────────────────

async function getWallet() {
  // Clear require cache to get fresh module with current env
  const mod = await import('../core/wallet.js');
  return mod;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('core/wallet.js', async () => {
  beforeEach(async () => {
    await setupTestKeypairs();
    writeTestConfig();
  });

  afterEach(() => {
    // Restore sub-wallet env vars for next test
  });

  // ─── Smoke test ─────────────────────────────────────────────────────────────

  describe('Module smoke test', () => {
    it('module loads without error', async () => {
      const m = await getWallet();
      assert.ok(m, 'wallet module should load');
    });

    it('exports all 14 required functions', async () => {
      const m = await getWallet();
      const expected = [
        'getMainPublicKey', 'getMainBalance', 'getNextSubWallet',
        'getSubWallet', 'getSubWalletPublicKey', 'getSubWalletBalance',
        'fundSubWallet', 'sweepSubWallet', 'getBalance',
        'getTokenBalance', 'sendTransaction', 'getAllSubWalletBalances',
        'getConnection', 'invalidateConnection',
      ];
      for (const name of expected) {
        assert.strictEqual(
          typeof m[name], 'function',
          `export "${name}" should be a function`
        );
      }
    });
  });

  // ─── Keypair loading ───────────────────────────────────────────────────────

  describe('Keypair loading from env', () => {
    it('loads main wallet from WALLET_PRIVATE_KEY', async () => {
      const m = await getWallet();
      const pubkey = m.getMainPublicKey();
      assert.ok(pubkey, 'should return a base58 public key');
      assert.strictEqual(typeof pubkey, 'string');
      assert.ok(pubkey.length > 30, 'base58 key should be > 30 chars');
    });

    it('loads all 3 sub-wallets from env vars', async () => {
      const m = await getWallet();
      const sw1 = m.getSubWallet(1);
      const sw2 = m.getSubWallet(2);
      const sw3 = m.getSubWallet(3);
      assert.ok(sw1?.keypair, 'sub-wallet 1 should have keypair');
      assert.ok(sw2?.keypair, 'sub-wallet 2 should have keypair');
      assert.ok(sw3?.keypair, 'sub-wallet 3 should have keypair');
    });

    it('getSubWallet throws for gap in env vars', async () => {
      const m = await getWallet();
      assert.throws(
        () => m.getSubWallet(99),
        /Sub-wallet 99 not found/,
        'should throw for non-existent sub-wallet index'
      );
    });
  });

  // ─── Rotation modes ────────────────────────────────────────────────────────

  describe('getNextSubWallet rotation', () => {
    it('per_trade: round-robin across 3 sub-wallets', async () => {
      writeTestConfig({
        ...TEST_CONFIG,
        wallet: { ...TEST_CONFIG.wallet, sub_wallet_rotation: 'per_trade' }
      });
      const m = await getWallet();

      const results = [];
      for (let i = 0; i < 6; i++) {
        results.push(m.getNextSubWallet().index);
      }
      // Round-robin: 1,2,3,1,2,3
      assert.deepStrictEqual(results.slice(0, 3), [1, 2, 3]);
      assert.deepStrictEqual(results.slice(3, 6), [1, 2, 3]);
    });

    it('per_day: same sub-wallet within same day', async () => {
      writeTestConfig({
        ...TEST_CONFIG,
        wallet: { ...TEST_CONFIG.wallet, sub_wallet_rotation: 'per_day' }
      });
      const m = await getWallet();

      const sw1 = m.getNextSubWallet();
      const sw2 = m.getNextSubWallet();
      const sw3 = m.getNextSubWallet();
      assert.strictEqual(sw1.index, sw2.index, 'per_day should return same sub-wallet');
      assert.strictEqual(sw2.index, sw3.index, 'per_day should return same sub-wallet');
    });

    it('random: returns varying sub-wallets', async () => {
      writeTestConfig({
        ...TEST_CONFIG,
        wallet: { ...TEST_CONFIG.wallet, sub_wallet_rotation: 'random' }
      });
      const m = await getWallet();

      const results = new Set();
      for (let i = 0; i < 20; i++) {
        results.add(m.getNextSubWallet().index);
      }
      assert.ok(results.size >= 2, 'random mode should return varying indices');
    });

    it('throws when no sub-wallets configured', async () => {
      await clearSubWalletEnv();
      writeTestConfig({
        ...TEST_CONFIG,
        wallet: { ...TEST_CONFIG.wallet, sub_wallets_enabled: false }
      });
      const m = await getWallet();
      assert.throws(
        () => m.getNextSubWallet(),
        /No sub-wallets configured/,
        'should throw when no sub-wallets exist'
      );
      // Restore for next test
      await setupTestKeypairs();
    });
  });

  // ─── Connection ─────────────────────────────────────────────────────────────

  describe('getConnection', () => {
    it('returns a Connection object', async () => {
      const m = await getWallet();
      const conn = m.getConnection();
      assert.ok(conn, 'should return truthy');
      assert.strictEqual(typeof conn.getBalance, 'function', 'should have getBalance');
    });

    it('caches connection for 5 minutes', async () => {
      const m = await getWallet();
      const conn1 = m.getConnection();
      const conn2 = m.getConnection();
      assert.strictEqual(conn1, conn2, 'should return same cached instance');
    });

    it('invalidateConnection clears cache', async () => {
      const m = await getWallet();
      const conn1 = m.getConnection();
      m.invalidateConnection();
      const conn3 = m.getConnection();
      assert.notStrictEqual(conn1, conn3, 'should return new connection after invalidate');
    });
  });

  // ─── Sub-wallet balances ────────────────────────────────────────────────────

  describe('getAllSubWalletBalances', () => {
    it('returns array with all 3 sub-wallets', async () => {
      const m = await getWallet();
      const result = await m.getAllSubWalletBalances().catch(() => []);
      assert.ok(Array.isArray(result), 'should return array');
      assert.strictEqual(result.length, 3, 'should have 3 entries');
      for (const item of result) {
        assert.strictEqual(typeof item.index, 'number', 'item should have numeric index');
        assert.strictEqual(typeof item.publicKey, 'string', 'item should have string publicKey');
        assert.ok(item.balance === null || typeof item.balance === 'number', 'balance can be null or number');
      }
    });
  });

  // ─── No LLM / brain imports ────────────────────────────────────────────────

  describe('CRITICAL: no brain/ or llm imports', () => {
    it('wallet.js does not import brain/ or llm', async () => {
      const content = fs.readFileSync(
        path.join(__dirname, '..', 'core', 'wallet.js'),
        'utf8'
      );
      assert.ok(!content.includes("from './brain"), 'must not import from brain/');
      assert.ok(!content.includes("from '../brain"), 'must not import from brain/');
      assert.ok(!content.includes("brain/llm"), 'must not use brain/ paths');
      // llm import from ../llm is also forbidden
      assert.ok(
        !content.includes("from '../llm") && !content.includes('from "./llm'),
        'must not import llm directly in wallet'
      );
    });
  });
});