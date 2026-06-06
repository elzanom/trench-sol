// Test rag.js: index a trade, search, verify persistence
import { indexTrade, findSimilarTrades, getIndexStats, removeTradeFromIndex } from '../memory/rag.js';

const t1 = {
  trade_id: 'test-1',
  symbol: 'PEPE',
  source: 'paper',
  mint_address: 'PePeAddr11111111111111111111111111111111',
  pnl_sol: 0.05,
  exit_reason: 'take_profit',
  signal_tags: ['high_volume', 'kol_mention'],
  entry_time: Date.now() - 60000,
};

const t2 = {
  trade_id: 'test-2',
  symbol: 'DOGE',
  source: 'paper',
  mint_address: 'DoGeAddr22222222222222222222222222222222',
  pnl_sol: -0.02,
  exit_reason: 'stop_loss',
  signal_tags: ['low_liquidity'],
  entry_time: Date.now() - 30000,
};

await indexTrade(t1);
await indexTrade(t2);
console.log('Indexed 2 trades');

const stats = await getIndexStats();
console.log('Stats:', JSON.stringify(stats));

// Search by symbol
const pepeTrades = await findSimilarTrades('PEPE', 5);
console.log('PEPE search:', pepeTrades.length, 'results | first symbol:', pepeTrades[0]?.metadata?.symbol);

// Search by signal tag
const kolTrades = await findSimilarTrades('kol_mention', 5);
console.log('kol_mention search:', kolTrades.length, 'results');

// Cleanup
await removeTradeFromIndex('test-1');
await removeTradeFromIndex('test-2');
const after = await getIndexStats();
console.log('After cleanup:', JSON.stringify(after));
