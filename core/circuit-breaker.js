import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  // Allow test injection via JSON env var
  if (process.env.__TEST_CONFIG_JSON) {
    return JSON.parse(process.env.__TEST_CONFIG_JSON);
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── SQLite Setup ─────────────────────────────────────────────────────────────

let _db = null;
let _lastDbPath = null;

function getDb() {
  const config = loadConfig();
  const dbPath = config.memory?.ledger?.db_path || './memory/db/trades.db';

  if (_db && _lastDbPath !== dbPath) {
    try { _db.close(); } catch {}
    _db = null;
  }

  if (_db) return _db;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new (require('better-sqlite3'))(dbPath);
  _lastDbPath = dbPath;

  // Create daily_stats table if not exists
  _db.exec(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      loss_sol_today REAL DEFAULT 0,
      trade_count_today INTEGER DEFAULT 0,
      is_tripped INTEGER DEFAULT 0,
      tripped_at INTEGER,
      tripped_reason TEXT
    )
  `);

  return _db;
}

// ─── Telegram Notifier ────────────────────────────────────────────────────────

let telegramClient = null;

async function sendTelegramNotify(message) {
  const config = loadConfig();
  if (!config.circuit_breaker?.notify_telegram) {
    return;
  }

  const chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!chatId) {
    console.log('[circuit-breaker] TELEGRAM_NOTIFY_CHAT_ID not set, skipping notification');
    return;
  }

  try {
    // Lazy-load gramjs to avoid circular deps
    const { TelegramClient, Api } = await import('gramjs');
    const store = { sessionLoaded: false };

    if (!telegramClient) {
      const { createClient } = await import('../feeds/telegram.js');
      telegramClient = await createClient();
    }

    await telegramClient.invoke(
      new Api.messages.SendMessage({
        peer: chatId,
        message,
        randomId: BigInt(Date.now()),
      })
    );
    console.log(`[circuit-breaker] Telegram notification sent: ${message}`);
  } catch (err) {
    console.error(`[circuit-breaker] Telegram notify failed: ${err.message}`);
  }
}

// ─── State Management ─────────────────────────────────────────────────────────

function getTodayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

/**
 * Get or create today's stats row
 */
function getOrCreateTodayStats(db) {
  const today = getTodayStr();
  const row = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today);

  if (row) return row;

  // Insert new row for today
  db.prepare(`
    INSERT OR IGNORE INTO daily_stats (date, loss_sol_today, trade_count_today, is_tripped, tripped_at, tripped_reason)
    VALUES (?, 0, 0, 0, NULL, NULL)
  `).run(today);

  return db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today);
}

// ─── Auto-Reset Check ─────────────────────────────────────────────────────────

let _lastResetCheckMinute = -1;

/**
 * Check if it's time to auto-reset (based on reset_hour_utc).
 * Should be called every minute.
 */
export function checkAutoReset() {
  const config = loadConfig();
  const resetHour = config.circuit_breaker?.reset_hour_utc ?? 0;
  const now = new Date();
  const currentMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Only check once per minute
  if (currentMinute === _lastResetCheckMinute) return;

  _lastResetCheckMinute = currentMinute;

  const currentHour = now.getUTCHours();
  if (currentHour === resetHour) {
    console.log('[circuit-breaker] Auto-reset triggered at hour UTC:', resetHour);
    reset().catch(err => console.error('[circuit-breaker] auto-reset failed:', err.message));
  }
}

/**
 * Run auto-reset check on an interval (every 60 seconds)
 */
export function startAutoResetScheduler() {
  // Check every minute
  setInterval(checkAutoReset, 60 * 1000);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if trading is allowed.
 * Returns { allowed: boolean, reason: string | null }
 */
export async function check() {
  const config = loadConfig();
  const { max_daily_loss_sol, max_daily_trades } = config.hard_rules;

  const db = getDb();
  const stats = getOrCreateTodayStats(db);

  if (stats.is_tripped) {
    return {
      allowed: false,
      reason: stats.tripped_reason || 'Circuit breaker already tripped today'
    };
  }

  if (stats.loss_sol_today >= max_daily_loss_sol) {
    const reason = `Daily loss limit: ${stats.loss_sol_today.toFixed(3)} SOL >= ${max_daily_loss_sol} SOL`;
    // Trip the breaker
    db.prepare(`
      UPDATE daily_stats SET is_tripped = 1, tripped_at = ?, tripped_reason = ? WHERE date = ?
    `).run(Date.now(), reason, getTodayStr());

    // Send Telegram notification
    const notifyMsg = `⚠️ TrenchAgent Circuit Breaker TRIPPED: ${reason} — trading dihentikan sampai 00:00 UTC`;
    sendTelegramNotify(notifyMsg).catch(console.error);

    return { allowed: false, reason };
  }

  if (stats.trade_count_today >= max_daily_trades) {
    const reason = `Daily trade count: ${stats.trade_count_today} >= ${max_daily_trades}`;
    db.prepare(`
      UPDATE daily_stats SET is_tripped = 1, tripped_at = ?, tripped_reason = ? WHERE date = ?
    `).run(Date.now(), reason, getTodayStr());

    const notifyMsg = `⚠️ TrenchAgent Circuit Breaker TRIPPED: ${reason} — trading dihentikan sampai 00:00 UTC`;
    sendTelegramNotify(notifyMsg).catch(console.error);

    return { allowed: false, reason };
  }

  return { allowed: true, reason: null };
}

/**
 * Record a loss amount in SOL
 */
export async function recordLoss(amountSol) {
  const db = getDb();
  const stats = getOrCreateTodayStats(db);
  const newLoss = (stats.loss_sol_today || 0) + Math.abs(amountSol);

  db.prepare('UPDATE daily_stats SET loss_sol_today = ? WHERE date = ?')
    .run(newLoss, getTodayStr());

  console.log(`[circuit-breaker] loss recorded: +${Math.abs(amountSol).toFixed(4)} SOL, total today: ${newLoss.toFixed(4)} SOL`);

  // Re-check if breaker should trip now
  const result = await check();
  return result;
}

/**
 * Record a completed trade (increment trade count)
 */
export async function recordTrade() {
  const db = getDb();
  const stats = getOrCreateTodayStats(db);
  const newCount = (stats.trade_count_today || 0) + 1;

  db.prepare('UPDATE daily_stats SET trade_count_today = ? WHERE date = ?')
    .run(newCount, getTodayStr());

  console.log(`[circuit-breaker] trade recorded: #${newCount} today`);

  // Re-check if breaker should trip now
  const result = await check();
  return result;
}

/**
 * Manual reset — clears tripped state and resets counters for today
 */
export async function reset() {
  const db = getDb();
  const today = getTodayStr();

  db.prepare(`
    UPDATE daily_stats
    SET loss_sol_today = 0,
        trade_count_today = 0,
        is_tripped = 0,
        tripped_at = NULL,
        tripped_reason = NULL
    WHERE date = ?
  `).run(today);

  console.log('[circuit-breaker] Manual reset executed for today');
  return { allowed: true, reason: null };
}

/**
 * Get today's stats
 */
export async function getDailyStats() {
  const db = getDb();
  const stats = getOrCreateTodayStats(db);
  return {
    date: stats.date,
    loss_sol_today: stats.loss_sol_today || 0,
    trade_count_today: stats.trade_count_today || 0,
    is_tripped: !!stats.is_tripped,
    tripped_at: stats.tripped_at || null,
    tripped_reason: stats.tripped_reason || null,
  };
}