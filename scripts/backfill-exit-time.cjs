// 2026-06-07: backfill exit_time for legacy trades that were
// recorded before recordTrade() started setting exit_time.
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'memory', 'db', 'trades.db');
const db = new Database(dbPath);

// Idempotent backfill: use entry_time if present, else now
const now = Date.now();
const result = db.prepare(`
  UPDATE trades
  SET exit_time = COALESCE(entry_time, ?)
  WHERE exit_time IS NULL
`).run(now);
console.log('Backfilled rows:', result && typeof result === 'object' ? (result.changes ?? 0) : result);
console.log('Used timestamp:', now);
db.close();
