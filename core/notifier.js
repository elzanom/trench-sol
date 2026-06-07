// ─── core/notifier.js — Telegram Bot Notifications ───────────────────────────
// Sends formatted text notifications via Telegram Bot API (HTTP).
// Config: config.json → notifications.telegram_bot
// Env:    TELEGRAM_BOT_TOKEN, TELEGRAM_NOTIFY_CHAT_ID, TELEGRAM_NOTIFY_TOPIC_ID

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('notifier');

const SEP = '────────────────────────────────';  // 32 dashes

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEnv(key) {
  if (process.env[key] !== undefined) return process.env[key];
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return undefined;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      if (line.slice(0, idx).trim() === key) {
        return line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
  return undefined;
}

function getConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')
    );
  } catch {
    return {};
  }
}

function isEventEnabled(eventName) {
  try {
    const cfg = getConfig();
    const nt = cfg.notifications?.telegram_bot;
    if (!nt || !nt.enabled) return false;
    return nt.events?.[eventName] !== false;
  } catch {
    return false;
  }
}

// ─── Format Helpers ──────────────────────────────────────────────────────────

export function formatPrice(usd) {
  if (usd === null || usd === undefined || usd === 0) return '?';
  const v = Number(usd);
  if (v < 0.000001) return v.toExponential(1).replace('e-0', 'e-');
  if (v < 0.001) return '$' + v.toFixed(6);
  if (v < 1) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

export function formatMC(usd) {
  if (!usd || usd === 0) return '?';
  const v = Number(usd);
  if (v >= 1_000_000_000) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1_000_000) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1_000) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(v);
}

export function formatDuration(minutes) {
  if (!minutes || minutes <= 0) return '?';
  const m = Math.round(minutes);
  if (m < 60) return m + 'm';
  if (m < 1440) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  return Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h';
}

export function formatPortfolio(sol, startingSol = 1.0) {
  const s = Number(sol) || 0;
  const start = Number(startingSol) || 1.0;
  const returnPct = start > 0 ? ((s - start) / start) * 100 : 0;
  const sign = returnPct >= 0 ? '+' : '';
  return `${s.toFixed(4)} SOL (${sign}${returnPct.toFixed(2)}%)`;
}

function exitReasonEmoji(reason) {
  const map = {
    take_profit: '🎯',
    hard_stop_loss: '🛑',
    timeout_no_movement: '⏸',
    llm_exit: '🧠',
    emergency_exit: '🚨',
    manual: '👤',
  };
  return map[reason] || '📤';
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || '???';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function nowUTC() {
  return new Date().toISOString().slice(11, 16) + ' UTC';
}

function dateStr() {
  const d = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${dd} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ─── Core: sendNotification ────────────────────────────────────────────────

export async function sendNotification(text, options = {}) {
  const eventName = options.event || 'default';
  if (!isEventEnabled(eventName)) return false;

  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  const chatId = getEnv('TELEGRAM_NOTIFY_CHAT_ID');
  const topicId = getEnv('TELEGRAM_NOTIFY_TOPIC_ID');

  if (!botToken || botToken === 'your_bot_token_here') {
    log.warn('TELEGRAM_BOT_TOKEN not set');
    return false;
  }
  if (!chatId) {
    log.warn('TELEGRAM_NOTIFY_CHAT_ID not set');
    return false;
  }

  const body = {
    chat_id: chatId,
    text: text.slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  // Topic support: include only if set and > 0
  if (topicId && topicId !== 'your_topic_id_here' && topicId !== '') {
    const tid = parseInt(topicId, 10);
    if (!isNaN(tid) && tid > 0) {
      body.message_thread_id = tid;
    }
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

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
      log.warn(`notif attempt ${attempt}/3: ${res.status} — ${errText.slice(0, 200)}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      log.warn(`notif attempt ${attempt}/3: ${e.message}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  return false;
}

// ─── Event Builders ──────────────────────────────────────────────────────────

/** 🤖 Agent Start */
export function notifyAgentStart(walletAddr, feedInfo = {}) {
  const addr = shortAddr(walletAddr);
  const groups = feedInfo.telegramGroups || 0;
  const text = [
    `🤖 TrenchAgent <b>ONLINE</b>`,
    SEP,
    `🟡 Mode    : PAPER TRADING`,
    `👛 Wallet  : ${addr}`,
    `📡 Feeds   : GMGN + Telegram`,
    `👥 Groups  : ${groups} groups`,
    `⏰ Time    : ${nowUTC()}`,
    SEP,
  ].join('\n');
  return sendNotification(text, { event: 'agent_start' });
}

/** 🟢 Trade Open */
export function notifyTradeOpen(position, tokenData = {}) {
  const p = position || {};
  const sym = p.symbol || '???';
  const entryPrice = formatPrice(p.entry_price ?? tokenData?.price_usd);
  const mc = formatMC(p.entry_market_cap_usd ?? tokenData?.market_cap);
  const size = p.amount_sol ?? p.size ?? 0;
  const sl = p.sl_pct ?? p.hard_stop_loss_pct ?? 0;
  const tp = p.tp_pct ?? p.take_profit_pct ?? 0;
  const addr = p.address ?? p.token_address ?? '?';
  const text = [
    `🟢 <b>BUY</b> — ${sym} <code>[P]</code>`,
    SEP,
    `💵 Entry   : ${entryPrice}`,
    `📊 MC      : ${mc}`,
    `💼 Size    : ${size} SOL`,
    `🛡 SL      : ${sl}%`,
    `🎯 TP      : +${tp}%`,
    `🔗 <a href="https://gmgn.ai/sol/token/${addr}">View on GMGN ↗</a>`,
    SEP,
  ].join('\n');
  return sendNotification(text, { event: 'trade_open' });
}

/** ✅ / ❌ Trade Close */
export function notifyTradeClose(position, exitData = {}) {
  const pos = position || {};
  const sym = pos.symbol || '???';
  const pnlPct = exitData.pnl_pct ?? 0;
  const pnlSol = exitData.pnl_sol ?? 0;
  const exitPrice = formatPrice(exitData.exit_price_usd);
  const duration = formatDuration(exitData.hold_duration_minutes ?? pos.hold_duration_minutes);
  const reason = exitData.exit_reason || 'unknown';
  const reasonEmoji = exitReasonEmoji(reason);
  const addr = pos.token_address || pos.address || '?';
  const isProfit = pnlPct >= 0;
  const emoji = isProfit ? '✅' : '❌';
  const label = isProfit ? 'PROFIT' : 'LOSS';
  const sign = isProfit ? '+' : '';
  const portfolio = formatPortfolio(exitData.portfolio_sol ?? 0);
  const returnPct = exitData.return_pct ?? 0;

  const eventKey = reason === 'hard_stop_loss' ? 'hard_stop_loss'
    : reason === 'take_profit' ? 'take_profit'
    : 'trade_close';

  const lines = [
    `${emoji} <b>CLOSE</b> — ${sym} <b>${label}</b>`,
    SEP,
    `${isProfit ? '📈' : '📉'} P&L     : ${sign}${pnlPct.toFixed(2)}% (${sign}${pnlSol.toFixed(6)} SOL)`,
    `💵 Exit    : ${exitPrice}`,
    `⏱ Held    : ${duration}`,
    `📤 Reason  : ${reasonEmoji} ${reason}`,
    `🔗 <a href="https://gmgn.ai/sol/token/${addr}">View on GMGN ↗</a>`,
    SEP,
    `Portfolio : ${portfolio} (${sign}${returnPct.toFixed(2)}%)`,
  ];

  // Consecutive losses note for hard stop loss
  if (reason === 'hard_stop_loss' && exitData.consecutive_losses > 1) {
    lines.push(`⚠️ ${exitData.consecutive_losses} losses berturut-turut`);
  }

  return sendNotification(lines.join('\n'), { event: eventKey });
}

/** ⚡ Circuit Breaker Trip */
export function notifyCircuitBreaker(stats = {}) {
  const lossSol = stats.loss_sol_today ?? 0;
  const tradesToday = stats.trade_count_today ?? 0;
  const portfolio = formatPortfolio(stats.portfolio_sol ?? 0);
  const text = [
    `⚡ <b>CIRCUIT BREAKER TRIPPED</b>`,
    SEP,
    `📉 Loss hari ini  : ${lossSol.toFixed(4)} SOL`,
    `🔢 Trades hari ini: ${tradesToday} trades`,
    `⏸ Status          : Trading DIHENTIKAN`,
    `⏰ Reset           : 00:00 UTC`,
    SEP,
    `💼 Portfolio : ${portfolio}`,
  ].join('\n');
  return sendNotification(text, { event: 'circuit_breaker_trip' });
}

/** 📊 Daily Summary */
export async function sendDailySummary(stats = {}) {
  const total = stats.total ?? 0;
  const wins = stats.wins ?? 0;
  const losses = stats.losses ?? 0;
  const netPnl = stats.net_pnl ?? 0;
  const sign = netPnl >= 0 ? '+' : '';
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const bestSym = stats.best_symbol || '?';
  const bestPct = stats.best_pct || 0;
  const worstSym = stats.worst_symbol || '?';
  const worstPct = stats.worst_pct || 0;
  const portfolio = formatPortfolio(stats.portfolio_sol ?? 0);
  const returnPct = stats.return_pct ?? 0;

  const text = [
    `📊 <b>DAILY SUMMARY</b>`,
    dateStr(),
    SEP,
    `📈 Trades  : ${total} (${wins}W / ${losses}L)`,
    `🎯 Win Rate: ${winRate.toFixed(1)}%`,
    `💰 Net P&L : ${sign}${netPnl.toFixed(6)} SOL`,
    SEP,
    `🏆 Best    : ${bestSym} +${bestPct.toFixed(2)}%`,
    `📉 Worst   : ${worstSym} ${worstPct.toFixed(2)}%`,
    SEP,
    `💼 Portfolio: ${portfolio}`,
    `📊 Return  : ${sign}${returnPct.toFixed(2)}% dari 1 SOL awal`,
    SEP,
  ].join('\n');
  return sendNotification(text, { event: 'daily_summary' });
}
