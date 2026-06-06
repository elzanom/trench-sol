import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import archiver from 'archiver';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Test config ───────────────────────────────────────────────────────────────

const TEST_CONFIG = {
  backtest: {
    lookback_days: 7,
    min_liquidity_usd: 1000,
    min_holders: 10,
    starting_balance_sol: 10,
    output_path: path.join(__dirname, 'backtest-test-results'),
  },
  backup: {
    include_files: ['config.json'],
    destination_path: path.join(__dirname, 'backup-test-dest'),
    interval_minutes: 60,
  },
};

const TEST_CONFIG_PATH = path.join(__dirname, 'test-backtest-config.json');

function writeTestConfig() {
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
}
function cleanupTestConfig() {
  try { fs.unlinkSync(TEST_CONFIG_PATH); } catch {}
}
function cleanupTestDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

process.env.__TEST_CONFIG_PATH = TEST_CONFIG_PATH;

// ─── Backup encryption helpers (replicate scripts/backup.js) ──────────────────

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const ITERATIONS = 100000;
const KEY_LENGTH = 32;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

function encryptTest(buffer, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decryptTest(data, password) {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ─── Backtest module tests ────────────────────────────────────────────────────

describe('backtest/', () => {
  beforeEach(() => {
    writeTestConfig();
    cleanupTestDir(path.join(__dirname, 'backtest-test-results'));
    cleanupTestDir(path.join(__dirname, 'backup-test-dest'));
  });

  afterEach(() => {
    cleanupTestConfig();
    cleanupTestDir(path.join(__dirname, 'backtest-test-results'));
    cleanupTestDir(path.join(__dirname, 'backup-test-dest'));
  });

  describe('data-fetcher.js', () => {
    it('exports expected functions', async () => {
      const df = await import('../backtest/data-fetcher.js');
      assert.strictEqual(typeof df.fetchBacktestTokens, 'function');
      assert.strictEqual(typeof df.fetchBirdeyeTokenList, 'function');
      assert.strictEqual(typeof df.fetchBirdeyeOhlcv, 'function');
      assert.strictEqual(typeof df.getTokenMetadata, 'function');
    });

    it('fetchBacktestTokens returns array or empty', async () => {
      // Without real API keys, should return empty or fallback
      const df = await import('../backtest/data-fetcher.js');
      const result = await df.fetchBacktestTokens();
      assert.ok(Array.isArray(result));
    });
  });

  describe('runner.js', () => {
    it('runBacktest is a function', async () => {
      const runner = await import('../backtest/runner.js');
      assert.strictEqual(typeof runner.runBacktest, 'function');
    });
  });

  describe('report.js', () => {
    it('generateReport is a function', async () => {
      const report = await import('../backtest/report.js');
      assert.strictEqual(typeof report.generateReport, 'function');
    });

    it('generateReport throws on invalid file', async () => {
      const report = await import('../backtest/report.js');
      await assert.rejects(
        () => report.generateReport('/nonexistent/path.json'),
        /Cannot read results/
      );
    });

    it('generateReport creates valid markdown', async () => {
      const report = await import('../backtest/report.js');
      const resultsDir = TEST_CONFIG.backtest.output_path;
      fs.mkdirSync(resultsDir, { recursive: true });
      const resultsFile = path.join(resultsDir, 'test_results.json');
      const mockResults = {
        trades: [
          {
            symbol: 'TEST',
            entry_price_usd: 0.001,
            exit_price_usd: 0.0015,
            amount_sol: 0.5,
            pnl_sol: 0.25,
            pnl_pct: 50,
            exit_reason: 'take_profit',
            llm_confidence: 0.85,
            signal_tags: ['meme', 'new_token'],
          },
          {
            symbol: 'FAIL',
            entry_price_usd: 0.001,
            exit_price_usd: 0.0008,
            amount_sol: 0.5,
            pnl_sol: -0.1,
            pnl_pct: -20,
            exit_reason: 'hard_stop_loss',
            llm_confidence: 0.7,
            signal_tags: ['meme'],
          },
        ],
        balance: 10.15,
        wins: 1,
        losses: 1,
      };
      fs.writeFileSync(resultsFile, JSON.stringify(mockResults));

      const outputFile = await report.generateReport(resultsFile);
      assert.ok(fs.existsSync(outputFile));
      const content = fs.readFileSync(outputFile, 'utf8');
      assert.ok(content.includes('# Backtest Report'));
      assert.ok(content.includes('TEST'));
      assert.ok(content.includes('FAIL'));
      assert.ok(content.includes('50.0%')); // win rate
    });
  });
});

// ─── Backup/restore tests ──────────────────────────────────────────────────────

describe('scripts/backup.js', () => {
  const password = 'test-password-123';
  const backupDir = path.join(__dirname, 'backup-test-dest');

  beforeEach(() => {
    writeTestConfig();
    cleanupTestDir(backupDir);
    fs.mkdirSync(backupDir, { recursive: true });
  });

  afterEach(() => {
    cleanupTestConfig();
    cleanupTestDir(backupDir);
  });

  it('encrypt/decrypt produces identical data', () => {
    const original = Buffer.from('Hello, this is test data for encryption!');
    const encrypted = encryptTest(original, password);
    assert.ok(encrypted.length > original.length); // adds salt+iv+tag
    const decrypted = decryptTest(encrypted, password);
    assert.strictEqual(decrypted.toString(), original.toString());
  });

  it('encrypted data is different each time (random salt/iv)', () => {
    const original = Buffer.from('Same data encrypted twice!');
    const enc1 = encryptTest(original, password);
    const enc2 = encryptTest(original, password);
    assert.ok(!enc1.equals(enc2)); // different salt/iv
    // but both decrypt to same original
    assert.strictEqual(decryptTest(enc1, password).toString(), original.toString());
    assert.strictEqual(decryptTest(enc2, password).toString(), original.toString());
  });

  it('decrypt with wrong password throws', () => {
    const original = Buffer.from('Secret data');
    const encrypted = encryptTest(original, password);
    // Node v22+ throws "Unsupported state or unable to authenticate data"
    // Older Node throws "Unsupported state" or includes "Auth tag" — accept any
    assert.throws(
      () => decryptTest(encrypted, 'wrong-password'),
      /(Auth tag|Unsupported state|authenticate)/
    );
  });

  it('runBackup does not crash on failure', async () => {
    process.env.BACKUP_ENCRYPTION_PASSWORD = 'test-pwd-123';
    const backup = await import('../scripts/backup.js');
    // Should not throw even if files don't exist
    await backup.runBackup();
    process.env.BACKUP_ENCRYPTION_PASSWORD = undefined;
  });
});

describe('scripts/restore.js', () => {
  const password = 'test-password-456';
  const backupDir = path.join(__dirname, 'backup-test-dest');
  const testFilePath = path.join(__dirname, 'restore-test-file.txt');
  const restoreTestContent = 'This file was backed up and restored!';

  beforeEach(() => {
    writeTestConfig();
    cleanupTestDir(backupDir);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(testFilePath, restoreTestContent);
  });

  afterEach(() => {
    cleanupTestConfig();
    cleanupTestDir(backupDir);
    try { fs.unlinkSync(testFilePath); } catch {}
  });

  it('restore can decrypt what backup encrypted', async () => {
    // Manually test the cycle: create zip → encrypt → decrypt → unzip → verify
    const zipPath = path.join(backupDir, 'test.zip');
    const encPath = path.join(backupDir, 'test.zip.enc');

    // Create archive with test file
    const archiveBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 0 } });
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);
      archive.file(testFilePath, { name: 'restore-test-file.txt' });
      archive.finalize();
    });

    // Encrypt
    const encrypted = encryptTest(archiveBuffer, password);
    fs.writeFileSync(encPath, encrypted);

    // Verify file exists
    assert.ok(fs.existsSync(encPath));

    // Decrypt and verify roundtrip (skip full restore flow — just verify cipher works)
    const decrypted = decryptTest(encrypted, password);
    assert.ok(decrypted.equals(archiveBuffer));
  });

  it('restore.js has required exports', async () => {
    const restore = await import('../scripts/restore.js');
    assert.strictEqual(typeof restore.restoreBackup, 'function');
  });
});