// ─── feeds/aggregator.js ──────────────────────────────────────────────────────
// Aggregates tokens from multiple feed sources (screener, pumpfun, etc.)
// Handles deduplication with 1-hour window

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  if (process.env.__TEST_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(process.env.__TEST_CONFIG_PATH, 'utf8'));
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

const log = createLogger('aggregator');

const DEDUPE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export class FeedAggregator {
  constructor(sources = [], config = null) {
    this.sources = sources;
    this.config = config || loadConfig().feeds || {};
    this.lastAggregation = null;
    this.aggregatedTokens = [];
    this._handlers = [];
    this._activeFeeds = [];
    this._queue = [];
    this._seenTokens = new Map(); // address -> timestamp
    this._running = false;
  }

  onToken(handler) {
    this._handlers.push(handler);
  }

  _emit(token) {
    for (const h of this._handlers) {
      try { h(token); } catch (e) { log.error(`[AGGREGATOR] handler error: ${e.message}`); }
    }
  }

  addSource(source) {
    this.sources.push(source);
  }

  getActiveFeeds() {
    return [...this._activeFeeds];
  }

  /**
   * Check if a token should be emitted (not seen within the dedupe window)
   */
  shouldEmit(token) {
    if (!token || !token.address) return false;
    const lastSeen = this._seenTokens.get(token.address);
    const now = Date.now();
    if (lastSeen && (now - lastSeen) < DEDUPE_WINDOW_MS) {
      return false;
    }
    this._seenTokens.set(token.address, now);
    return true;
  }

  resetDeduplication() {
    this._seenTokens.clear();
  }

  /**
   * Push a token into the queue (used by feed sources)
   * Returns false if duplicate, true if added
   */
  push(token) {
    if (!this.shouldEmit(token)) {
      return false;
    }
    this._queue.push(token);
    this._emit(token);
    return true;
  }

  async aggregate() {
    const allTokens = [];

    for (const source of this.sources) {
      try {
        const tokens = await source.getTokens();
        allTokens.push(...tokens);
      } catch (err) {
        log.warn(`[AGGREGATOR] Source failed: ${err.message}`);
      }
    }

    // Deduplicate by mint address with 1-hour window
    const deduped = [];
    for (const token of allTokens) {
      const addr = token.address || token.mint;
      if (this.shouldEmit({ address: addr })) {
        deduped.push(token);
      }
    }

    this.aggregatedTokens = deduped;
    this.lastAggregation = Date.now();
    return deduped;
  }

  async getTokens() {
    if (!this.lastAggregation || Date.now() - this.lastAggregation > 30000) {
      await this.aggregate();
    }
    return this.aggregatedTokens;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._activeFeeds = this.sources.map((s, i) => s.constructor?.name || `feed-${i}`);
    for (const source of this.sources) {
      try {
        if (typeof source.start === 'function') {
          await source.start();
        } else if (typeof source.connect === 'function') {
          await source.connect();
        }
      } catch (err) {
        log.warn(`[AGGREGATOR] start failed for source: ${err.message}`);
      }
    }
  }

  async stop() {
    this._running = false;
    for (const source of this.sources) {
      try {
        if (typeof source.stop === 'function') {
          await source.stop();
        } else if (typeof source.disconnect === 'function') {
          source.disconnect();
        }
      } catch (err) {
        log.warn(`[AGGREGATOR] stop failed: ${err.message}`);
      }
    }
    this._activeFeeds = [];
  }

  reset() {
    this.aggregatedTokens = [];
    this.lastAggregation = null;
    this._queue = [];
    this._seenTokens.clear();
  }
}

export function createAggregator(sources = []) {
  return new FeedAggregator(sources);
}
