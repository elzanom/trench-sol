// ─── feeds/telegram.js — Telegram Feed (GramJS / MTProto) ─────────────────────
// Sources: config.feeds.telegram.groups
// Emits: tokens with source='telegram' via getTokens()
// Auth: TELEGRAM_SESSION from .env (generated via auth-telegram.mjs)

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('telegram-feed');

const DEFAULT_MIN_CONFIDENCE = 0.3;

export class TelegramFeed {
  constructor(config) {
    this.tgConfig = config.feeds?.telegram || {};
    this.minConfidence = this.tgConfig.min_confidence_score ?? DEFAULT_MIN_CONFIDENCE;
    this.cache = [];
    this.client = null;
    this.running = false;
    this._connected = false;
    this._reconnectTimer = null;
  }

  /** ─── Connect to Telegram (idempotent) ───────────────────────────────── */
  async connect() {
    if (this._connected) return;

    const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
    const apiHash = process.env.TELEGRAM_API_HASH || '';
    const sessionStr = process.env.TELEGRAM_SESSION || '';

    if (!apiId || !apiHash) {
      throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env');
    }
    if (!sessionStr || sessionStr.length < 20) {
      throw new Error('TELEGRAM_SESSION not set or too short. Run: node auth-telegram.mjs');
    }

    const session = new StringSession(sessionStr.replace(/^"|"$/g, ''));
    this.client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 3000,
      autoReconnect: true,
    });

    await this.client.start();
    this._connected = true;
    log.info('Connected to Telegram');

    // Subscribe to configured groups
    const groups = this.tgConfig.groups || [];
    let subscribed = 0;

    for (const identifier of groups) {
      try {
        const entity = await this.client.getEntity(identifier);
        log.info(`Subscribed to: ${identifier} (id=${entity.id.value || entity.id})`);
        subscribed++;
      } catch (e) {
        log.warn(`Failed to join ${identifier}: ${e.message}`);
      }
    }

    if (subscribed === 0) {
      log.warn('No groups subscribed — check config.feeds.telegram.groups');
    }

    // ── Message handler ──────────────────────────────────────────────────
    const { NewMessage } = await import('telegram/events/index.js');
    this.client.addEventHandler(
      (event) => { this._onMessage(event.message).catch((e) => log.error(`msg handler: ${e.message}`)); },
      new NewMessage({})
    );

    this.running = true;
    log.info(`Telegram feed ready (${subscribed}/${groups.length} groups, min_confidence=${this.minConfidence})`);
  }

  /** ─── Handle incoming message ──────────────────────────────────────── */
  async _onMessage(message) {
    if (!message || !message.text) return;

    const text = message.text;
    const chatName = message.chat?.title
      || message.chat?.username
      || `chat_${message.chatId?.value || message.chatId || '?'}`;

    // Extract Solana addresses (base58, 32-44 chars)
    const addresses = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
    if (!addresses || addresses.length === 0) return;

    // Quick heuristic: skip messages without any alpha/buy language
    const evaluation = this._evaluateHeuristic(text);
    if (!evaluation.is_alpha || evaluation.confidence < this.minConfidence) {
      if (evaluation.confidence >= 0.1) {
        log.debug(`Rejected (conf=${evaluation.confidence.toFixed(2)}): ${chatName}`);
      }
      return;
    }

    // Emit one token per unique address found
    const seen = new Set();
    for (const addr of addresses) {
      if (seen.has(addr)) continue;
      seen.add(addr);

      const token = {
        address: addr,
        source: 'telegram',
        source_confidence: evaluation.confidence,
        signal_type: 'telegram_alpha',
        metadata: {
          feed_source: 'telegram',
          raw_message: text.slice(0, 600),
          reasoning: evaluation.reasoning,
          from_chat: chatName,
          confidence: evaluation.confidence,
          timestamp: Date.now(),
        },
      };

      this.cache.push(token);
      log.info(`Alpha from ${chatName}: ${addr.slice(0, 12)}... (conf=${evaluation.confidence.toFixed(2)})`);
    }
  }

  /** ─── Heuristic message evaluation (paper-mode compatible) ──────────── */
  _evaluateHeuristic(text) {
    const t = text.toLowerCase();

    // ── Reject patterns ─────────────────────────────────────────────
    if (t.includes('dm for ca') || t.includes('dm me') || t.includes('check my bio')) {
      return { is_alpha: false, confidence: 0, reasoning: 'Asks to DM for CA' };
    }

    // Pure hype — multiple !!! or ALL CAPS with no address context
    const exclamationCount = (text.match(/!/g) || []).length;
    if (exclamationCount >= 4) {
      return { is_alpha: false, confidence: 0.05, reasoning: 'Excessive exclamation marks — likely shill' };
    }

    const capsWords = text.split(/\s+/).filter((w) => w.length > 2 && w === w.toUpperCase()).length;
    if (capsWords > 3 && t.length < 150) {
      return { is_alpha: false, confidence: 0.08, reasoning: 'Short message with mostly ALL CAPS — low quality' };
    }

    // ── Positive signals ────────────────────────────────────────────
    let confidence = 0.3;
    let signals = [];

    // Has price / market cap data
    if (/\$\d+\.?\d*[kmb]?\b/i.test(t)) signals.push('price/mcap');
    if (/\d+\.?\d*%(?: |$)/.test(t)) signals.push('percentage');
    if (/\braydium\b|\bpump\.fun\b|\bmondai\b|\bjupiter\b/.test(t)) signals.push('dex_mention');
    if (/\bca[:：\s]+\b/i.test(t)) signals.push('explicit_ca');

    // Mentioned good patterns
    if (/buy|entry|long|alpha|gem|signal|call/i.test(t)) signals.push('buy_call');
    if (/mc[\s=:]*\d+/.test(t)) signals.push('mcap');
    if (/liq|tvl|volume|supply/i.test(t)) signals.push('onchain_data');

    // ── Compute confidence ─────────────────────────────────────────
    if (signals.length === 0) {
      return { is_alpha: false, confidence: 0.1, reasoning: 'No alpha indicators found' };
    }

    // Boost per signal
    if (signals.includes('explicit_ca')) confidence += 0.25;
    if (signals.includes('price/mcap')) confidence += 0.15;
    if (signals.includes('dex_mention')) confidence += 0.15;
    if (signals.includes('buy_call')) confidence += 0.1;
    if (signals.includes('onchain_data')) confidence += 0.1;
    if (signals.includes('percentage')) confidence += 0.1;

    // Penalise shill indicators
    if (text.length < 30) confidence -= 0.2;
    if (/100x|1000x|moonshot|guaranteed/i.test(t)) confidence -= 0.15;

    const finalConfidence = Math.max(0, Math.min(0.95, confidence));
    const isAlpha = finalConfidence >= this.minConfidence;

    return {
      is_alpha: isAlpha,
      confidence: finalConfidence,
      reasoning: isAlpha
        ? `Accepted: ${signals.join(', ')} (conf=${finalConfidence.toFixed(2)})`
        : `Rejected: insufficient signals (${signals.length}: ${signals.join(', ')}, conf=${finalConfidence.toFixed(2)})`,
    };
  }

  /** ─── Aggregator integration: returns buffered tokens ────────────── */
  async getTokens() {
    const tokens = [...this.cache];
    this.cache = [];
    return tokens;
  }

  /** ─── Disconnect ─────────────────────────────────────────────────── */
  async stop() {
    this.running = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this.client) {
      try { await this.client.disconnect(); } catch {}
      this.client = null;
    }
    this._connected = false;
    log.info('Telegram feed stopped');
  }
}

export function createTelegramFeed(config) {
  return new TelegramFeed(config);
}
