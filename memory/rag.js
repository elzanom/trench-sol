import Database from 'better-sqlite3';

// RAG memory for storing and retrieving trading context
const _vectorStore = [];

/**
 * Add a memory entry to the vector store
 */
export async function addMemory(type, content, metadata = {}) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    type,
    content,
    metadata,
    timestamp: Date.now(),
  };
  _vectorStore.push(entry);

  // Keep only last 1000 entries
  if (_vectorStore.length > 1000) {
    _vectorStore.shift();
  }

  return { id: entry.id, success: true };
}

/**
 * Search memories by type and content
 */
export async function searchMemories(query, options = {}) {
  const { type, limit = 10 } = options;

  let results = _vectorStore;

  if (type) {
    results = results.filter(m => m.type === type);
  }

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(m => m.content.toLowerCase().includes(q));
  }

  // Sort by timestamp descending
  results.sort((a, b) => b.timestamp - a.timestamp);

  return results.slice(0, limit);
}

/**
 * Add a trade to the index
 */
export async function addTradeToIndex(trade) {
  const source = trade.source || 'live';

  // Prepend "Source: ${source}" as first line of content for RAG retrieval
  const sourceLine = `Source: ${source}`;
  const content = `${sourceLine}\n${JSON.stringify(trade)}`;

  return addMemory('trade', content, {
    mint_address: trade.mint_address,
    pnl_sol: trade.pnl_sol,
    source: source,
  });
}

/**
 * Add a signal to the index
 */
export async function addSignalToIndex(signal) {
  return addMemory('signal', JSON.stringify(signal), {
    mint_address: signal.mint_address,
    confidence: signal.confidence,
  });
}

/**
 * Get recent trades from memory
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
 * Get index statistics
 */
export async function getIndexStats() {
  const trades = _vectorStore.filter(m => m.type === 'trade').length;
  const signals = _vectorStore.filter(m => m.type === 'signal').length;
  const other = _vectorStore.length - trades - signals;

  return {
    total_entries: _vectorStore.length,
    trades,
    signals,
    other,
  };
}

/**
 * Remove a trade from index
 */
export async function removeTradeFromIndex(tradeId) {
  const idx = _vectorStore.findIndex(m => m.id === tradeId && m.type === 'trade');
  if (idx >= 0) {
    _vectorStore.splice(idx, 1);
    return { success: true };
  }
  return { success: false };
}

// ─── Aliases for API compatibility ────────────────────────────────────────────

/** Alias for addTradeToIndex */
export const indexTrade = addTradeToIndex;

/** Alias for searchMemories (trades-only, by query) */
export async function findSimilarTrades(queryOrToken) {
  // Accept string OR object (token data). If object, extract symbol + name as
  // the search query. Defensive: if input is neither, fall back to empty string.
  let query = '';
  if (typeof queryOrToken === 'string') {
    query = queryOrToken;
  } else if (queryOrToken && typeof queryOrToken === 'object') {
    const symbol = queryOrToken.symbol || '';
    const name = queryOrToken.name || '';
    query = `${symbol} ${name}`.trim();
  }
  const results = await searchMemories(query, { type: 'trade', limit: 10 });
  return results;
}