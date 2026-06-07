// ─── core/notifier.js — Telegram Bot Notifications ───────────────────────────
// Sends formatted event notifications to a Telegram group/topic.
// Uses Bot API (HTTP), NOT MTProto (GramJS), so no session needed.
//
// Config: config.json → notifications.telegram
// Env:    TELEGRAM_BOT_TOKEN, TELEGRAM_NOTIFY_CHAT_ID, TELEGRAM_NOTIFY_TOPIC_ID

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('notifier');

/** Load env-like values from .env (avoid dotenv dep) */
function getEnv(key) {
  if (process.env[key] !== undefined) return process.env[key];
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return undefined;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const k = line.slice(0, idx).trim();
      if (k === key) {
        return line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
  return undefined;
}

/** Load config (once, cached) */
let _config = null;
function getConfig() {
  if (_config) return _config;
  try {
    _config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')
    );
  } catch {}
  return _config || {};
}

/** Load notifier settings */
function getSettings() {
  const cfg = getConfig();
  const nt = cfg.notifications?.telegram;
  if (!nt || !nt.enabled) return null;

  const botToken = getEnv(nt.bot_token_env || 'TELEGRAM_BOT_TOKEN');
  const chatId = getEnv(nt.chat_id_env || 'TELEGRAM_NOTIFY_CHAT_ID');
  const topicId = getEnv(nt.topic_id_env || 'TELEGRAM_NOTIFY_TOPIC_ID');

  if (!botToken || botToken === 'your_bot_token_here') {
    log.warn('TELEGRAM_BOT_TOKEN not set — notifications disabled');
    return null;
  }
  if (!chatId) {
    log.warn('TELEGRAM_NOTIFY_CHAT_ID not set — notifications disabled');
    return null;
  }

  return { botToken, chatId, topicId, events: nt.events || {} };
}

/** ─── Send a Telegram Bot API message ───────────────────────────────────── */
export async function sendNotification(message, options = {}) {
  const settings = getSettings();
  if (!settings) return false;

  // Check event gating
  const eventName = options.event || 'default';
  if (settings.events[eventName] === false) return false;

  const url = `https://api.telegram.org/bot${settings.botToken}/sendMessage`;
  const body = {
    chat_id: settings.chatId,
    text: message.slice(0, 4096), // Telegram max 4096 chars
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  // Topic support (optional)
  const rawTopicId = options.topicId || settings.topicId;
  if (rawTopicId && rawTopicId !== 'your_topic_id_here' && rawTopicId !== '') {
    body.message_thread_id = parseInt(rawTopicId, 10) || rawTopicId;
  }

  // Retry logic
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        log.info('Sent: ' + eventName);
        return true;
      }
      const errText = await res.text();
      log.warn(`notif attempt ${attempt}/3 failed: ${res.status} — ${errText.slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429) break; // don't retry client errors
    } catch (e) {
      log.warn(`notif attempt ${attempt}/3 network error: ${e.message}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return false;
}

// ─── Formatted message builders ─────────────────────────────────────────────

/** 🟢 Trade open notification */
export function formatTradeOpen(trade) {
  const s = (v) => v ?? '?';
  return [
    `🟢 <b>PAPER BUY</b> — ${s(trade.symbol)}`,
    `💰 Size: ${s(trade.size)} SOL`,
    `📊 MC: ${fmtMc(trade.market_cap)}`,
    `🎯 Entry: $${fmtPrice(trade.entry_price)}`,
    `🛡 SL: ${s(trade.sl_pct)}% | TP: ${s(trade.tp_pct)}%`,
    `🔗 <a href="https://gmgn.ai/sol/token/${s(trade.address)}">GMGN</a>`,
  ].join('\n');
}

/** ✅ Profit close notification */
export function formatTradeClose(trade) {
  const s = (v) => v ?? '?';
  const pnlPct = trade.pnl_pct ?? 0;
  const isProfit = pnlPct >= 0;
  const emoji = isProfit ? '✅' : '❌';
  const sign = isProfit ? '+' : '';
  const header = `${emoji} <b>PAPER CLOSE</b> — ${s(trade.symbol)}`;

  const lines = [
    header,
    `💵 P&L: ${sign}${pnlPct.toFixed(2)}% (${sign}${(trade.pnl_sol ?? 0).toFixed(6)} SOL)`,
    `⏱ Duration: ${fmtDuration(trade.hold_duration_minutes)}`,
    `📤 Exit: ${s(trade.exit_reason)}`,
    `🔗 <a href="https://gmgn.ai/sol/token/${s(trade.address)}">GMGN</a>`,
  ];

  return lines.join('\n');
}

/** ⚡ Circuit breaker tripped */
export function formatCircuitBreaker(state) {
  const s = (v) => v ?? '?';
  return [
    `⚡ <b>CIRCUIT BREAKER TRIPPED</b>`,
    `📉 Daily loss: ${(s(state.dailyLossSol)).toFixed(4)} SOL`,
    `🔢 Trades today: ${s(state.tradesToday)}`,
    `⏰ Reset: 00:00 UTC`,
  ].join('\n');
}

/** 🛑 Hard stop loss */
export function formatHardStopLoss(trade) {
  const s = (v) => v ?? '?';
  return [
    `🛑 <b>HARD STOP LOSS</b> — ${s(trade.symbol)}`,
    `📉 Loss: ${(trade.pnl_pct ?? 0).toFixed(2)}% (${(trade.pnl_sol ?? 0).toFixed(6)} SOL)`,
    `⏱ Duration: ${fmtDuration(trade.hold_duration_minutes)}`,
    `🔗 <a href="https://gmgn.ai/sol/token/${s(trade.address)}">GMGN</a>`,
  ].join('\n');
}

/** 🚀 Agent start */
export function formatAgentStart(state) {
  const s = (v) => v ?? '?';
  return [
    `🚀 <b>TrenchAgent Started</b>`,
    `🟡 Mode: PAPER`,
    `💼 Wallet: ${s(state.walletAddress).slice(0, 8)}...`,
    `📡 Feeds: GMGN + Telegram (${s(state.telegramGroups)} groups)`,
  ].join('\n');
}

/** 📊 Daily summary (via daily summary cron) */
export function formatDailySummary(data) {
  const s = (v) => v ?? 0;
  const netPnl = data.net_pnl ?? 0;
  const netSign = netPnl >= 0 ? '+' : '';
  return [
    `📊 <b>Daily Summary</b> — ${data.date || '?'}`,
    `📈 Trades: ${s(data.total)} (${s(data.wins)}W/${s(data.losses)}L)`,
    `💰 Net P&L: ${netSign}${netPnl.toFixed(6)} SOL`,
    `🏆 Best: ${data.best_symbol || '?'} +${(data.best_pct || 0).toFixed(2)}%`,
    `📉 Worst: ${data.worst_symbol || '?'} ${(data.worst_pct || 0).toFixed(2)}%`,
    `🎯 Win Rate: ${(data.win_rate || 0).toFixed(1)}%`,
    `💼 Portfolio: ${(data.portfolio || 0).toFixed(4)} SOL (${netSign}${(data.return_pct || 0).toFixed(2)}%)`,
  ].join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtMc(mc) {
  if (!mc || mc === 0) return '?';
  if (mc >= 1_000_000_000) return `$${(mc / 1e9).toFixed(2)}B`;
  if (mc >= 1_000_000) return `$${(mc / 1e6).toFixed(2)}M`;
  if (mc >= 1_000) return `$${(mc / 1e3).toFixed(1)}K`;
  return `$${mc.toFixed(0)}`;
}

function fmtPrice(p) {
  if (!p || p === 0) return '?';
  if (p < 0.00001) return p.toExponential(2);
  if (p < 0.01) return p.toFixed(6);
  if (p < 1) return p.toFixed(4);
  return p.toFixed(2);
}

function fmtDuration(min) {
  if (!min || min <= 0) return '?';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m}m`;
}
