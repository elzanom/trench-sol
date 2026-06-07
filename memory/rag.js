// RAG memory for storing and retrieving trading context.
// 2026-06-07: migrated from in-memory _vectorStore array to persistent
// LocalIndex (vectra). Embedding-free mode: we don't call queryItems (which
// requires a vector), only listItems + metadata filter. This works because
// the project's LLM endpoint (opencode-zen) doesn't support /v1/embeddings.
//
// File layout: each item is stored in memory/db/vector-index/index.json with
// the trade data as metadata. Survives restarts — unlike the previous
// in-memory array which was wiped on every agent restart.

import { LocalIndex } from 'vectra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_DIR = path.join(__dirname, 'db', 'vector-index');
const index = new LocalIndex(INDEX_DIR);

let _initialized = false;
async function initIndex() {
  if (_initialized) return;
  if (!await index.isIndexCreated()) {
    await index.createIndex();
  }
  _initialized = true;
}

// Placeholder vector — required by vectra's insertItem API. We never call
// queryItems(vector) so the actual values don't matter; a constant zero
// vector keeps inserts cheap and search behavior identical to the
// pre-migration keyword filter.
const PLACEHOLDER_VECTOR = [0, 0, 0, 0];

// Build searchable text for a trade record. Kept in metadata.content so
// findSimilarTrades can do substring match without re-hydrating the full
// trade object.
function buildContent(trade) {
  const source = trade.source || 'live';
  const sourceLine = `Source: ${source}`;
  return `${sourceLine}\n${JSON.stringify(trade)}`;
}

function queryToString(queryOrToken) {
  if (typeof queryOrToken === 'string') return queryOrToken;
  if (queryOrToken && typeof queryOrToken === 'object') {
    return `${queryOrToken.symbol || ''} ${queryOrToken.name || ''}`.trim();
  }
  return '';
}

/**
 * Add a memory entry to the persistent vector store.
 * 2026-06-07: kept as a public API for completeness (was used by tests
 * directly) but indexTrade() is the canonical entry point for trades.
 */
export async function addMemory(type, content, metadata = {}) {
  await initIndex();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const item = {
    id,
    vector: PLACEHOLDER_VECTOR,
    metadata: {
      type,
      content,
      metadata,
      timestamp: Date.now(),
    },
  };
  await index.insertItem(item);
  return { id, success: true };
}

/**
 * Search memories by type and content (substring match).
 * Returns array of { id, type, content, metadata, timestamp }.
 */
export async function searchMemories(query, options = {}) {
  await initIndex();
  const { type, limit = 10 } = options;
  const q = (query || '').toLowerCase();

  const all = await index.listItems();
  let results = all;
  if (type) {
    results = results.filter(m => m.metadata?.type === type);
  }
  if (q) {
    results = results.filter(m => (m.metadata?.content || '').toLowerCase().includes(q));
  }
  // Sort by timestamp desc
  results.sort((a, b) => (b.metadata?.timestamp || 0) - (a.metadata?.timestamp || 0));

  return results.slice(0, limit).map(m => ({
    id: m.id,
    type: m.metadata?.type,
    content: m.metadata?.content,
    // Expose the full item metadata (which includes the spread trade object
    // for trades, or the inner metadata for general memories). Callers like
    // index.js read .length only, but keep this rich for future use.
    metadata: m.metadata || {},
    timestamp: m.metadata?.timestamp || 0,
  }));
}

/**
 * Add a trade to the persistent index. Aliases below for compatibility
 * with the existing indexTrade() call sites in index.js / backtest/*.
 */
export async function addTradeToIndex(trade) {
  return indexTrade(trade);
}

export async function indexTrade(trade) {
  await initIndex();
  const id = trade.trade_id || trade.id || `trade-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const content = buildContent(trade);
  const item = {
    id,
    vector: PLACEHOLDER_VECTOR,
    metadata: {
      ...trade,
      type: 'trade',
      content,
      timestamp: trade.entry_time || Date.now(),
    },
  };
  // 2026-06-07: BUG fix — use upsertItem instead of insertItem. The same trade_id is
  // used on OPEN (line 714 in index.js) and CLOSE (line 952), so a second
  // insertItem throws "Item with id X already exists" and the close-side
  // update is silently swallowed. upsertItem updates the existing entry in place,
  // so the latest pnl_sol / exit_reason / hold_duration_minutes are persisted.
  // This is why the index previously had only `exit_reason: "open"` entries.
  await index.upsertItem(item);
  return { id, success: true };
}

/**
 * Add a signal to the index. Kept for API compatibility with the prior
 * implementation; currently unused by callers but the test file checks
 * for the export surface.
 */
export async function addSignalToIndex(signal) {
  await initIndex();
  const id = `signal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await index.insertItem({
    id,
    vector: PLACEHOLDER_VECTOR,
    metadata: {
      type: 'signal',
      content: JSON.stringify(signal),
      metadata: {
        mint_address: signal.mint_address,
        confidence: signal.confidence,
      },
      timestamp: Date.now(),
    },
  });
  return { id, success: true };
}

/**
 * Get recent trades from memory for a specific mint address.
 */
export async function getRecentTrades(mintAddress, limit = 10) {
  const results = await searchMemories('', {
    type: 'trade',
    limit: limit * 2,
  });
  return results
    .filter(m => m.metadata?.mint_address === mintAddress)
    .slice(0, limit);
}

/**
 * Get index statistics.
 */
export async function getIndexStats() {
  await initIndex();
  const items = await index.listItems();
  const trades = items.filter(i => i.metadata?.type === 'trade').length;
  const signals = items.filter(i => i.metadata?.type === 'signal').length;
  const other = items.length - trades - signals;
  return {
    total_entries: items.length,
    trades,
    signals,
    other,
  };
}

/**
 * Remove a trade from index.
 */
export async function removeTradeFromIndex(tradeId) {
  await initIndex();
  try {
    await index.deleteItem(tradeId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Alias for addTradeToIndex.
 */
export const indexTradeAlias = addTradeToIndex;

/**
 * Find similar trades by query string or token object. Returns array of
 * memory objects (same shape as searchMemories).
 */
export async function findSimilarTrades(queryOrToken, limit = 10) {
  const query = queryToString(queryOrToken);
  return searchMemories(query, { type: 'trade', limit });
}
