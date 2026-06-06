// Reset DB tables — defensive: skip if table doesn't exist
const Database = require('better-sqlite3');
const db = new Database('./memory/db/trades.db');
const tables = ['trades', 'signal_stats', 'daily_stats', 'positions', 'position_snapshots'];
const results = {};
for (const t of tables) {
  try {
    const before = db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
    db.exec('DELETE FROM ' + t);
    const after = db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
    results[t] = { before, after };
  } catch (e) {
    results[t] = { error: e.message.split(':')[0] };
  }
}
console.log('=== Reset results ===');
for (const [t, r] of Object.entries(results)) {
  if (r.error) console.log(t.padEnd(22) + ' SKIP (' + r.error + ')');
  else console.log(t.padEnd(22) + ' ' + r.before + ' -> ' + r.after + ' rows');
}
db.close();
