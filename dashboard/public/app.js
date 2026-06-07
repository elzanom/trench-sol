// ─── TrenchAgent dashboard — app.js ───────────────────────────────────────────
// Vanilla JS, no framework. Served by dashboard/server.js on :3000.

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = '';
const REFRESH_MS = 10000;
const SL_NEAR_THRESHOLD = -15;  // PnL% under which a position is "near SL"

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  positions: [],
  lastDecisions: [],
  lastTrades: [],
  statusEvents: [],
  logLines: [],
};

// ─── Utility: safe number formatting ──────────────────────────────────────────

function fmtNum(v, digits = 2, fallback = '--') {
  if (v == null || isNaN(v)) return fallback;
  return Number(v).toFixed(digits);
}

function fmtTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--';
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtDateTime(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '--';
  const M = d.getMonth() + 1;
  const D = d.getDate();
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${M}/${D} ${h}:${m}`;
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return escHtml(addr || '');
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

// ─── API helper (preserved signature) ─────────────────────────────────────────
// fetch wrapper. Returns JSON. Includes X-Auth-Token from localStorage.
// Throws on non-2xx. On 401, clears token and shows auth banner.

async function api(path, options = {}) {
  const token = localStorage.getItem('auth_token') || '';
  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-Token': token,
    ...(options.headers || {}),
  };
  const res = await fetch(API_BASE + path, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('auth_token');
    showAuthBanner('Stored token was rejected. Please re-enter.');
    throw new Error('Unauthorized');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data == null ? {} : data;
}

// ─── Formatting helpers (preserved signatures) ────────────────────────────────

function formatMC(usd) {
  if (usd == null || isNaN(usd) || usd === 0) return '--';
  if (usd >= 1e9) return '$' + (usd / 1e9).toFixed(2) + 'B';
  if (usd >= 1e6) return '$' + (usd / 1e6).toFixed(2) + 'M';
  if (usd >= 1e3) return '$' + (usd / 1e3).toFixed(1) + 'k';
  return '$' + Math.round(usd);
}

function formatDuration(minutes) {
  if (minutes == null || isNaN(minutes)) return '--';
  if (minutes < 60) return minutes.toFixed(2) + 'm';
  if (minutes < 1440) return (minutes / 60).toFixed(2) + 'h';
  return (minutes / 1440).toFixed(1) + 'd';
}

function formatUptime(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '--';
  if (seconds < 60) return Math.floor(seconds) + 's';
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}m${s}s`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d${h}h`;
}

function renderTokenLink(symbol, address) {
  const sym = escHtml(symbol || '?');
  if (!address) {
    return `<strong>${sym}</strong>`;
  }
  return `<a class="token-link" href="https://gmgn.ai/sol/token/${escHtml(address)}" target="_blank" rel="noopener noreferrer">
            <b>${sym}</b> ↗
          </a><br>
          <span class="addr-mono">${shortAddr(address)}</span>`;
}

// ─── Auth banner ──────────────────────────────────────────────────────────────

function showAuthBanner(message) {
  const banner = document.getElementById('auth-banner');
  const dash = document.getElementById('dashboard-content');
  if (banner) banner.classList.remove('hidden');
  if (dash) dash.classList.add('hidden');
  if (message) {
    const m = document.getElementById('auth-message');
    if (m) m.textContent = message;
  }
  const input = document.getElementById('auth-token-input');
  const errEl = document.getElementById('auth-error');
  if (input) {
    setTimeout(() => input.focus(), 50);
    input.value = '';
  }
  if (errEl) errEl.textContent = '';
}

function hideAuthBanner() {
  const banner = document.getElementById('auth-banner');
  const dash = document.getElementById('dashboard-content');
  if (banner) banner.classList.add('hidden');
  if (dash) dash.classList.remove('hidden');
}

async function checkAuth() {
  const token = localStorage.getItem('auth_token');
  if (!token) {
    showAuthBanner('Enter the dashboard auth token from config.json (dashboard.auth_token).');
    return false;
  }
  // Validate token against server (returns 200 if valid, 401 if not)
  try {
    const res = await fetch('/api/status', { headers: { 'X-Auth-Token': token } });
    if (res.status === 401) {
      localStorage.removeItem('auth_token');
      showAuthBanner('Stored token was rejected. Please re-enter.');
      return false;
    }
    return true;
  } catch {
    // Network error — let refreshAll surface it
    return true;
  }
}

async function submitAuthToken() {
  const input = document.getElementById('auth-token-input');
  const errEl = document.getElementById('auth-error');
  const btn = document.getElementById('auth-submit-btn');
  if (!input) return;
  const token = input.value.trim();
  if (!token) {
    if (errEl) errEl.textContent = 'Please paste a token.';
    return;
  }
  if (btn) btn.disabled = true;
  if (errEl) errEl.textContent = 'Validating…';
  try {
    const res = await fetch('/api/token-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.valid) {
      localStorage.setItem('auth_token', token);
      hideAuthBanner();
      if (errEl) errEl.textContent = '';
      await refreshAll();
    } else {
      if (errEl) errEl.textContent = data.error || 'Invalid token. Try again.';
      if (btn) btn.disabled = false;
    }
  } catch (e) {
    if (errEl) errEl.textContent = 'Network error: ' + e.message;
    if (btn) btn.disabled = false;
  }
}

// ─── Refresh: Navbar ──────────────────────────────────────────────────────────

async function refreshNavbar() {
  try {
    const data = await api('/api/status');
    const mode = (data.mode || data.status || (data.paper_trading ? 'PAPER' : 'LIVE')).toString();
    const statusBadge = document.getElementById('status-badge');
    const modeBadge = document.getElementById('mode-badge');

    if (statusBadge) {
      statusBadge.textContent = (data.status || mode).toString();
      statusBadge.classList.remove('badge-green', 'badge-yellow', 'badge-red');
      const s = (data.status || mode).toString().toUpperCase();
      if (s === 'RUNNING') statusBadge.classList.add('badge-green');
      else if (s === 'PAUSED' || s === 'TRIPPED') statusBadge.classList.add('badge-yellow');
      else statusBadge.classList.add('badge-green');
    }

    if (modeBadge) {
      if (data.paper_trading) {
        modeBadge.textContent = 'PAPER';
        modeBadge.classList.remove('badge-green');
        modeBadge.classList.add('badge-yellow');
        modeBadge.style.display = '';
      } else {
        modeBadge.textContent = 'LIVE';
        modeBadge.classList.remove('badge-yellow');
        modeBadge.classList.add('badge-green');
        modeBadge.style.display = '';
      }
    }

    const pidEl = document.getElementById('nav-pid');
    if (pidEl) pidEl.textContent = data.pid || '--';

    const uptimeEl = document.getElementById('nav-uptime');
    if (uptimeEl) uptimeEl.textContent = formatUptime(data.uptime_s);

    const mainBalEl = document.getElementById('nav-main-bal');
    if (mainBalEl) {
      const v = data.main_balance_sol != null ? Number(data.main_balance_sol).toFixed(4) : '--';
      mainBalEl.textContent = v;
    }

    // portfolio = main + exposure (or paper portfolio if available)
    const portBalEl = document.getElementById('nav-portfolio-bal');
    const portPctEl = document.getElementById('nav-portfolio-pct');
    if (portBalEl || portPctEl) {
      try {
        const stats = await api('/api/stats');
        const pp = stats.paper_portfolio;
        if (pp) {
          if (portBalEl) portBalEl.textContent = pp.current_sol.toFixed(4);
          if (portPctEl) {
            const sign = pp.return_pct >= 0 ? '+' : '';
            portPctEl.textContent = sign + pp.return_pct.toFixed(2);
            portPctEl.style.color = pp.return_pct >= 0
              ? 'var(--green)'
              : 'var(--red)';
          }
        } else {
          const total = (data.main_balance_sol || 0) + (data.total_exposure_sol || 0);
          if (portBalEl) portBalEl.textContent = total.toFixed(4);
          if (portPctEl) portPctEl.textContent = '--';
        }
      } catch {
        if (portBalEl) portBalEl.textContent = '--';
        if (portPctEl) portPctEl.textContent = '--';
      }
    }
  } catch (err) {
    console.warn('navbar:', err.message);
  }
}

// ─── Refresh: Stats row (5 cards) ─────────────────────────────────────────────

async function refreshStats() {
  try {
    const [stats, status] = await Promise.all([
      api('/api/stats'),
      api('/api/status'),
    ]);

    // Portfolio (sim)
    const portEl = document.getElementById('stat-portfolio');
    const portSubEl = document.getElementById('stat-portfolio-sub');
    const portLabel = document.getElementById('stat-portfolio-label');
    const pp = stats.paper_portfolio;
    if (pp) {
      if (portEl) {
        portEl.textContent = pp.current_sol.toFixed(4) + ' SOL';
        portEl.className = 'stat-value ' + (pp.return_pct >= 0 ? 'text-green' : 'text-red');
      }
      if (portSubEl) {
        const sign = pp.return_pct >= 0 ? '+' : '';
        portSubEl.textContent = `${sign}${pp.return_pct.toFixed(2)}% dari ${pp.starting_balance_sol} SOL`;
      }
      if (portLabel) portLabel.textContent = 'Portfolio (Sim)';
    } else {
      const pnl = stats.total_pnl_sol || 0;
      if (portEl) {
        portEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' SOL';
        portEl.className = 'stat-value ' + (pnl >= 0 ? 'text-green' : 'text-red');
      }
      if (portSubEl) portSubEl.textContent = '';
      if (portLabel) portLabel.textContent = 'Total P&L';
    }

    // Win rate
    const wr = stats.win_rate_pct ?? stats.win_rate ?? 0;
    const wrEl = document.getElementById('stat-winrate');
    if (wrEl) wrEl.textContent = wr.toFixed(1) + '%';

    // Active positions
    const activeEl = document.getElementById('stat-active');
    if (activeEl) activeEl.textContent = status.active_positions ?? 0;

    // Tokens scanned (use daily-summary if available, fallback to feed total)
    const scannedEl = document.getElementById('stat-scanned');
    if (scannedEl) {
      try {
        const ds = await api('/api/daily-summary');
        scannedEl.textContent = ds.scanned ?? 0;
      } catch {
        scannedEl.textContent = '0';
      }
    }

    // RAG memory proxy: trades indexed from /api/stats.total_trades
    const ragEl = document.getElementById('stat-rag');
    if (ragEl) ragEl.textContent = stats.total_trades ?? 0;

    // ── Signal accuracy: bars in #signal-list ─────────────────────────
    const signalList = document.getElementById('signal-list');
    if (signalList) {
      const signals = stats.signal_accuracy || [];
      if (!signals.length) {
        signalList.innerHTML = '<div class="text-muted text-center">No signal data</div>';
      } else {
        const top = signals.slice(0, 8);
        signalList.innerHTML = top.map(s => {
          const wr = parseFloat(s.win_rate) || 0;
          const cls = wr > 70 ? 'blue' : wr >= 50 ? 'green' : wr >= 30 ? 'yellow' : 'red';
          return `<div class="bar-row">
            <span class="bar-label">${escHtml(s.signal || '?')}</span>
            <div class="bar-track"><div class="bar-fill ${cls}" style="width:${Math.min(100, wr).toFixed(1)}%"></div></div>
            <span class="bar-value">${wr.toFixed(0)}%</span>
          </div>`;
        }).join('');
      }
    }

    // ── Performance by source: table in #source-body ──────────────────
    const sourceBody = document.getElementById('source-body');
    if (sourceBody) {
      const bySource = stats.by_source || {};
      const labelMap = {
        live:     { html: '<span class="dot-live"></span> live',     order: 0 },
        paper:    { html: '<span class="dot-yellow"></span> paper',  order: 1 },
        backtest: { html: '<span class="dot-blue"></span> backtest', order: 2 },
      };
      const orderedKeys = ['live', 'paper', 'backtest',
        ...Object.keys(bySource).filter(k => !(k in labelMap))];
      const rows = [];
      for (const src of orderedKeys) {
        const s = bySource[src];
        if (!s) continue;
        if (s.total === 0 && !(src in labelMap)) continue;
        const label = labelMap[src]?.html || escHtml(src);
        const wr = s.win_rate_pct != null ? Number(s.win_rate_pct) : 0;
        const wrClass = wr >= 50 ? 'text-green' : 'text-red';
        const pnl = Number(s.total_pnl_sol) || 0;
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
        rows.push(`<tr>
          <td>${label}</td>
          <td class="text-mono">${s.total}</td>
          <td class="${wrClass} text-mono">${wr.toFixed(1)}%</td>
          <td class="${pnlClass} text-mono">${pnlSign}${pnl.toFixed(4)}</td>
        </tr>`);
      }
      sourceBody.innerHTML = rows.length
        ? rows.join('')
        : '<tr><td colspan="4" class="text-muted text-center">No data</td></tr>';
    }

    // ── RAG learning: best-effort fill from available stats ───────────
    const ragIndexedEl = document.getElementById('rag-indexed');
    if (ragIndexedEl) ragIndexedEl.textContent = stats.total_trades ?? 0;

    const ragMatchEl = document.getElementById('rag-match-avg');
    if (ragMatchEl) ragMatchEl.textContent = '--';

    const ragLastEl = document.getElementById('rag-last-match');
    if (ragLastEl) {
      const last = state.lastTrades[0];
      if (last) {
        const pnl = last.pnl_sol != null ? Number(last.pnl_sol).toFixed(4) : '--';
        ragLastEl.textContent = `${last.symbol || '?'} (${pnl})`;
      } else {
        ragLastEl.textContent = '--';
      }
    }

    const ragConfEl = document.getElementById('rag-conf-boost');
    if (ragConfEl) {
      const confs = state.lastDecisions
        .map(d => d.confidence)
        .filter(c => c != null && !isNaN(c))
        .map(Number);
      if (confs.length) {
        const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
        ragConfEl.textContent = `+${avg.toFixed(2)}`;
      } else {
        ragConfEl.textContent = '--';
      }
    }
  } catch (err) {
    console.warn('stats:', err.message);
  }
}

// ─── Refresh: Active positions ────────────────────────────────────────────────

async function refreshPositions() {
  try {
    const data = await api('/api/positions');
    state.positions = data.positions || [];
    const tbody = document.getElementById('positions-body');
    const countEl = document.getElementById('positions-count');

    let max = 5;
    try {
      const cfg = await api('/api/config');
      max = cfg.position?.max_concurrent_positions ?? cfg.max_concurrent_positions ?? 5;
    } catch {}

    if (countEl) {
      countEl.textContent = `${state.positions.length}/${max}`;
    }

    if (!tbody) return;
    if (!state.positions.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center">No active positions</td></tr>';
      return;
    }

    tbody.innerHTML = state.positions.map(p => {
      const pnl = p.pnl_pct ?? 0;
      const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
      const pnlSign = pnl >= 0 ? '+' : '';
      const nearSL = pnl < SL_NEAR_THRESHOLD;
      const slVal = p.hard_stop_loss_pct ?? p.stop_loss_pct ?? '--';
      const slPct = slVal === '--' ? '--' : `${slVal}%`;
      return `<tr${nearSL ? ' class="near-sl"' : ''}>
        <td>${renderTokenLink(p.symbol, p.token_address)}</td>
        <td class="text-blue text-mono">${formatMC(p.entry_market_cap_usd)}</td>
        <td class="text-mono">${p.entry_price_usd != null ? '$' + Number(p.entry_price_usd).toFixed(6) : '--'}</td>
        <td class="text-mono">${p.current_price_usd != null ? '$' + Number(p.current_price_usd).toFixed(6) : '--'}</td>
        <td class="${pnlClass} text-mono">${pnlSign}${pnl.toFixed(2)}%${nearSL ? ' <span class="badge badge-orange">near SL</span>' : ''}</td>
        <td class="text-mono">${slPct}</td>
        <td class="text-mono">${formatDuration(p.duration_minutes)}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.warn('positions:', err.message);
  }
}

// ─── Refresh: Trades (closed, last 20) ────────────────────────────────────────

async function refreshTrades() {
  try {
    const data = await api('/api/trades?status=closed&limit=20');
    const trades = (data.trades || []).filter(t => t.exit_time != null);
    state.lastTrades = trades.slice(0, 3);  // for log stub
    const tbody = document.getElementById('trades-body');
    if (!tbody) return;

    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center">No closed trades yet</td></tr>';
      return;
    }

    tbody.innerHTML = trades.map(t => {
      const pnl = t.pnl_pct ?? 0;
      const pnlSol = t.pnl_sol ?? 0;
      const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
      const pnlSign = pnl >= 0 ? '+' : '';
      const reason = (t.exit_reason || 'unknown').toString().toLowerCase();
      const reasonClass = ['stop_loss', 'stoploss', 'sl'].includes(reason) ? 'stop_loss'
        : ['take_profit', 'takeprofit', 'tp'].includes(reason) ? 'take_profit'
        : reason === 'timeout' ? 'timeout'
        : reason === 'signal' ? 'signal'
        : reason === 'manual' ? 'manual' : 'unknown';
      const dur = t.hold_duration_minutes != null
        ? formatDuration(t.hold_duration_minutes)
        : (t.duration_minutes != null ? formatDuration(t.duration_minutes) : '--');
      return `<tr>
        <td>${renderTokenLink(t.symbol, t.token_address)}</td>
        <td class="text-mono">${formatMC(t.entry_market_cap_usd)}</td>
        <td class="${pnlClass} text-mono">${pnlSign}${pnl.toFixed(2)}%</td>
        <td class="${pnlClass} text-mono">${pnlSign}${pnlSol.toFixed(4)}</td>
        <td><span class="exit-pill ${reasonClass}">${escHtml(t.exit_reason || 'unknown')}</span></td>
        <td class="text-mono">${dur}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.warn('trades:', err.message);
  }
}

// ─── Refresh: LLM decisions feed ──────────────────────────────────────────────

async function refreshDecisions() {
  try {
    const data = await api('/api/decisions');
    const list = (data.decisions || []).slice(0, 5);
    state.lastDecisions = list;
    const root = document.getElementById('decisions-list');
    if (!root) return;

    if (!list.length) {
      root.innerHTML = '<div class="text-muted text-center">No decisions yet</div>';
      return;
    }

    root.innerHTML = list.map(d => {
      const isBuy = (d.decision || '').toString().toUpperCase() === 'BUY';
      const badgeClass = isBuy ? 'badge-green' : 'badge-muted';
      const conf = d.confidence != null ? Number(d.confidence).toFixed(2) : '--';
      return `<div class="decision-item">
        <span class="badge ${badgeClass}">${escHtml((d.decision || '?').toString().toUpperCase())}</span>
        <span class="decision-symbol">${escHtml(d.symbol || '?')}</span>
        <span class="decision-conf">conf ${conf}</span>
        <div class="decision-reason-row decision-reason">${escHtml(d.reasoning || '')}</div>
      </div>`;
    }).join('');
  } catch (err) {
    console.warn('decisions:', err.message);
  }
}

// ─── Refresh: Rejection breakdown ─────────────────────────────────────────────

async function refreshRejections() {
  try {
    const data = await api('/api/rejections');
    const root = document.getElementById('rejections-list');
    if (!root) return;

    const hard = ['dev_wallet', 'liq_missing', 'honeypot', 'bundler'];
    const soft = ['llm_skip'];
    const entries = Object.entries(data || {})
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);

    if (!entries.length) {
      root.innerHTML = '<div class="text-muted text-center">No rejections</div>';
      return;
    }

    const max = Math.max(...entries.map(e => e[1]), 1);
    root.innerHTML = entries.map(([k, v]) => {
      const isSoft = soft.includes(k);
      const fillClass = isSoft ? 'muted' : 'red';
      const pct = Math.min(100, (v / max) * 100);
      return `<div class="bar-row">
        <span class="bar-label">${escHtml(k)}</span>
        <div class="bar-track"><div class="bar-fill ${fillClass}" style="width:${pct}%"></div></div>
        <span class="bar-value">${v}</span>
      </div>`;
    }).join('');
  } catch (err) {
    console.warn('rejections:', err.message);
  }
}

// ─── Refresh: Feed stats ──────────────────────────────────────────────────────

async function refreshFeedStats() {
  try {
    const data = await api('/api/feed-stats');
    const root = document.getElementById('feed-stats-list');
    if (!root) return;

    const entries = Object.entries(data || {});
    const total = entries.reduce((s, [_, v]) => s + (v || 0), 0);

    if (!total) {
      root.innerHTML = '<div class="text-muted text-center">No data</div>';
      return;
    }

    root.innerHTML = entries
      .filter(([_, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => {
        const pct = total > 0 ? (v / total) * 100 : 0;
        return `<div class="bar-row">
          <span class="bar-label">${escHtml(k)}</span>
          <div class="bar-track"><div class="bar-fill blue" style="width:${pct.toFixed(1)}%"></div></div>
          <span class="bar-value">${pct.toFixed(0)}%</span>
        </div>`;
      }).join('');
  } catch (err) {
    console.warn('feed-stats:', err.message);
  }
}

// ─── Refresh: Daily summary (2x3 grid) ────────────────────────────────────────

async function refreshDailySummary() {
  try {
    const data = await api('/api/daily-summary');
    const setText = (id, val, colorClass = '') => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = val;
      el.className = 'daily-value' + (colorClass ? ' ' + colorClass : '');
    };

    setText('daily-scanned', data.scanned ?? 0);
    setText('daily-entered', data.entered ?? 0);
    setText('daily-closed', data.closed ?? 0);
    const net = data.net_pnl ?? 0;
    const netSign = net >= 0 ? '+' : '';
    setText('daily-net', `${netSign}${net.toFixed(4)} SOL`, net >= 0 ? 'text-green' : 'text-red');
    const best = data.best ?? 0;
    setText('daily-best', `+${best.toFixed(4)} SOL`, best > 0 ? 'text-green' : '');
    const worst = data.worst ?? 0;
    setText('daily-worst', `${worst.toFixed(4)} SOL`, worst < 0 ? 'text-red' : '');
  } catch (err) {
    console.warn('daily-summary:', err.message);
  }
}

// ─── Refresh: Circuit breaker ─────────────────────────────────────────────────

async function refreshCircuitBreaker() {
  try {
    const data = await api('/api/daily');
    const lossBar = document.getElementById('cb-loss-bar');
    const lossText = document.getElementById('cb-loss-text');
    const tradesBar = document.getElementById('cb-trades-bar');
    const tradesText = document.getElementById('cb-trades-text');

    const lossSol = Math.abs(data.loss_sol_today || 0);
    const maxLoss = data.max_daily_loss_sol || 0.2;
    const lossPct = maxLoss > 0 ? Math.min(100, (lossSol / maxLoss) * 100) : 0;

    if (lossBar) {
      lossBar.style.width = lossPct + '%';
      lossBar.classList.remove('warn', 'danger');
      if (lossPct >= 100) lossBar.classList.add('danger');
      else if (lossPct >= 80) lossBar.classList.add('warn');
    }
    if (lossText) lossText.textContent = `${lossSol.toFixed(4)} / ${maxLoss.toFixed(4)} SOL`;

    const trades = data.trade_count_today || 0;
    const maxTrades = data.max_daily_trades || 20;
    const tradesPct = maxTrades > 0 ? Math.min(100, (trades / maxTrades) * 100) : 0;
    if (tradesBar) tradesBar.style.width = tradesPct + '%';
    if (tradesText) tradesText.textContent = `${trades} / ${maxTrades}`;
  } catch (err) {
    console.warn('circuit-breaker:', err.message);
  }
}

// ─── Refresh: Sub-wallets ─────────────────────────────────────────────────────

async function refreshWallets() {
  try {
    const data = await api('/api/wallets');
    const root = document.getElementById('wallets-list');
    if (!root) return;

    const html = [];
    if (data.main) {
      html.push(`<div class="wallet-item">
        <span class="wallet-label">Main</span>
        <span class="wallet-addr">${shortAddr(data.main.address)}</span>
        <span class="wallet-bal">${fmtNum(data.main.balance_sol, 4)} SOL</span>
      </div>`);
    }
    for (const sw of (data.sub_wallets || [])) {
      const bal = sw.display_balance
        ? escHtml(sw.display_balance)
        : `${fmtNum(sw.balance_sol, 4)} SOL`;
      const isActive = (sw.committed_sol || 0) > 0;
      html.push(`<div class="wallet-item">
        <span class="wallet-label">#${escHtml(sw.index != null ? sw.index : '?')}${isActive ? ' <span class="badge badge-yellow">active</span>' : ''}</span>
        <span class="wallet-addr">${shortAddr(sw.publicKey || sw.address)}</span>
        <span class="wallet-bal">${bal}</span>
      </div>`);
    }

    root.innerHTML = html.length
      ? html.join('')
      : '<div class="text-muted text-center">No wallet data</div>';
  } catch (err) {
    console.warn('wallets:', err.message);
  }
}

// ─── Refresh: Config quick edit (blue pills) ──────────────────────────────────

const CONFIG_PILLS = [
  { key: 'position.size_sol',                label: 'position_size', type: 'number', step: '0.01' },
  { key: 'position.hard_stop_loss_pct',      label: 'stop_loss',     type: 'number', step: '0.1' },
  { key: 'position.take_profit_pct',         label: 'take_profit',   type: 'number', step: '0.1' },
  { key: 'position.max_concurrent_positions', label: 'max_concurrent', type: 'number', step: '1' },
  { key: 'position.timeout_exit_minutes',    label: 'timeout_exit',  type: 'number', step: '1' },
];

function getPathValue(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

async function refreshConfig() {
  try {
    const cfg = await api('/api/config');
    const root = document.getElementById('config-pills');
    if (!root) return;

    root.innerHTML = CONFIG_PILLS.map(p => {
      const v = getPathValue(cfg, p.key);
      const display = v != null ? v : '--';
      return `<div class="config-pill-row">
        <span class="config-pill-key">${escHtml(p.label)}</span>
        <span class="config-pill" data-key="${escHtml(p.key)}" data-type="${p.type}" data-step="${p.step}" title="click to edit">${display}</span>
      </div>`;
    }).join('');
  } catch (err) {
    console.warn('config:', err.message);
  }
}

function makeConfigInput(pill) {
  const key = pill.dataset.key;
  const current = pill.textContent;
  const input = document.createElement('input');
  input.type = pill.dataset.type || 'number';
  input.step = pill.dataset.step || 'any';
  input.value = current;
  input.className = 'config-input';

  let saved = false;
  const finish = async (commit) => {
    if (saved) return;
    saved = true;
    if (commit) {
      const newVal = input.type === 'number' ? Number(input.value) : input.value;
      try {
        await api('/api/config', {
          method: 'POST',
          body: JSON.stringify({ path: key, value: newVal }),
        });
        pill.textContent = newVal;
      } catch (e) {
        pill.textContent = current;
        console.warn('config save:', e.message);
      }
    } else {
      pill.textContent = current;
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  return input;
}

// ─── Refresh: Live log (stub from existing endpoints) ─────────────────────────

function appendLogLine(tag, text) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  state.logLines.push(`[${ts}] [${tag}] ${text}`);
  if (state.logLines.length > 50) state.logLines.shift();
}

async function refreshLog() {
  // The server doesn't expose a live log stream. Build a stub from recent
  // activity: last 5 decisions, last 3 trades, last 2 status changes.
  const lines = [];

  // Last status (one-liner)
  try {
    const status = await api('/api/status');
    lines.push({ tag: 'FEED', text: `status=${status.status || status.mode} active=${status.active_positions ?? 0} paused=${!!status.is_paused}` });
  } catch {}

  // Decisions
  for (const d of state.lastDecisions.slice(0, 5)) {
    const tag = (d.decision || '').toString().toUpperCase() === 'BUY' ? 'BUY' : 'SKIP';
    lines.push({ tag, text: `${d.symbol || '?'} conf=${d.confidence != null ? Number(d.confidence).toFixed(2) : '--'} ${(d.reasoning || '').slice(0, 80)}` });
  }

  // Trades
  for (const t of state.lastTrades.slice(0, 3)) {
    const pnl = t.pnl_sol != null ? Number(t.pnl_sol).toFixed(4) : '--';
    const reason = (t.exit_reason || 'unknown').toString().toUpperCase();
    lines.push({ tag: 'EXIT', text: `${t.symbol || '?'} pnl_sol=${pnl} reason=${reason}` });
  }

  const root = document.getElementById('log-output');
  if (!root) return;

  if (!lines.length) {
    root.innerHTML = '<div class="text-muted">No activity yet</div>';
    return;
  }

  root.innerHTML = lines.map(l =>
    `<span class="log-line"><span class="tag-${l.tag}">[${l.tag}]</span> ${escHtml(l.text)}</span>`
  ).join('');
  root.scrollTop = root.scrollHeight;
}

// ─── Refresh: Alert bar ───────────────────────────────────────────────────────

async function refreshAlertBar() {
  try {
    const data = await api('/api/positions');
    const positions = data.positions || [];
    const danger = positions.find(p => (p.pnl_pct ?? 0) < SL_NEAR_THRESHOLD);
    const bar = document.getElementById('alert-bar');
    if (!bar) return;
    if (danger) {
      const pnl = danger.pnl_pct.toFixed(1);
      const threshold = danger.hard_stop_loss_pct ?? danger.stop_loss_pct ?? -20;
      bar.innerHTML = `⚡ Posisi <b>${escHtml(danger.symbol || '?')}</b> mendekati stop loss — PnL ${pnl}% dari threshold ${threshold}%`;
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }
  } catch (err) {
    console.warn('alert-bar:', err.message);
  }
}

// ─── Button handlers ──────────────────────────────────────────────────────────

async function onPause() {
  try {
    await api('/api/pause', { method: 'POST' });
    addLogLine('OK', 'agent PAUSED');
    await refreshNavbar();
  } catch (e) {
    addLogLine('ERR', 'pause failed: ' + e.message);
  }
}

async function onResume() {
  try {
    await api('/api/resume', { method: 'POST' });
    addLogLine('OK', 'agent RESUMED');
    await refreshNavbar();
  } catch (e) {
    addLogLine('ERR', 'resume failed: ' + e.message);
  }
}

async function onSwitchLive() {
  const ok = confirm('Switch to LIVE trading? This will use real SOL.');
  if (!ok) return;
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ paper_trading: false }),
    });
    alert('Switched to LIVE');
    await refreshNavbar();
  } catch (e) {
    addLogLine('ERR', 'switch live failed: ' + e.message);
  }
}

async function onResetCircuitBreaker() {
  try {
    await api('/api/circuit-breaker/reset', { method: 'POST' });
    addLogLine('OK', 'circuit breaker reset');
    await refreshCircuitBreaker();
  } catch (e) {
    addLogLine('ERR', 'cb reset failed: ' + e.message);
  }
}

function addLogLine(tag, text) {
  appendLogLine(tag, text);
  // Re-render the log card so the user sees feedback
  refreshLog();
}

// ─── Refresh-all orchestrator ─────────────────────────────────────────────────

async function refreshAll() {
  await Promise.allSettled([
    refreshNavbar(),
    refreshStats(),
    refreshPositions(),
    refreshTrades(),
    refreshDecisions(),
    refreshRejections(),
    refreshFeedStats(),
    refreshDailySummary(),
    refreshCircuitBreaker(),
    refreshWallets(),
    refreshConfig(),
    refreshLog(),
    refreshAlertBar(),
  ]);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Auth form
  document.getElementById('auth-submit-btn')?.addEventListener('click', submitAuthToken);
  document.getElementById('auth-token-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAuthToken();
  });

  // Action buttons
  document.getElementById('btn-pause')?.addEventListener('click', onPause);
  document.getElementById('btn-resume')?.addEventListener('click', onResume);
  document.getElementById('btn-switch-live')?.addEventListener('click', onSwitchLive);
  document.getElementById('cb-reset-btn')?.addEventListener('click', onResetCircuitBreaker);

  // Delegated handler for config pills (click to edit)
  document.getElementById('config-pills')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.config-pill');
    if (!pill) return;
    if (pill.querySelector('input')) return;  // already editing
    const input = makeConfigInput(pill);
    pill.textContent = '';
    pill.appendChild(input);
    input.focus();
    input.select();
  });

  // Boot
  checkAuth().then(ok => {
    if (!ok) return;
    hideAuthBanner();
    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  });
}

document.addEventListener('DOMContentLoaded', init);
