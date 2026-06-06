// ─── Dashboard app.js ──────────────────────────────────────────────────────────
// Vanilla JS — no build step, no framework

// ─── Config ───────────────────────────────────────────────────────────────────

// 2026-06-06: replaced 6-stacked-prompt() flow with inline UI (auth-banner
// in index.html). New flow:
//   1. Page loads. If no token in localStorage, call /api/token-check.
//   2. If requires_auth=true, show inline banner + hide dashboard content.
//   3. User pastes token → POST /api/token-check validates → save to
//      localStorage → reload page.
//   4. If token exists in localStorage, dashboard loads normally.
const AUTH_TOKEN = localStorage.getItem('dashboard_token') || '';
const API_BASE = '';
const REFRESH_MS = 10000;

// ─── State ─────────────────────────────────────────────────────────────────────

let isPaused = false;
let chartInstance = null;
let logLines = [];

// ─── API helpers ───────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN,
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    // 2026-06-06: bad token in localStorage (e.g. server restarted with new
    // token). Show the auth banner and clear stored token.
    localStorage.removeItem('dashboard_token');
    showAuthBanner('Stored token was rejected. Please re-enter.');
    throw new Error('Unauthorized');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

// ─── Auth banner ───────────────────────────────────────────────────────────────
// 2026-06-06: inline UI replacement for the broken 6-stacked-prompt() flow.
// Public endpoint /api/token-check tells us whether auth is needed without
// requiring a token. Banner shows once, validates the token before saving.
function showAuthBanner(message) {
  const banner = document.getElementById('auth-banner');
  const dash = document.getElementById('dashboard-content');
  const input = document.getElementById('auth-token-input');
  const errEl = document.getElementById('auth-error');
  if (!banner || !dash) return;
  dash.style.display = 'none';
  banner.style.display = 'flex';
  if (message) document.getElementById('auth-message').textContent = message;
  if (input) {
    setTimeout(() => input.focus(), 100);
    input.value = '';
  }
  if (errEl) errEl.textContent = '';
}

function hideAuthBanner() {
  const banner = document.getElementById('auth-banner');
  const dash = document.getElementById('dashboard-content');
  if (banner) banner.style.display = 'none';
  if (dash) dash.style.display = '';
}

async function checkAuthRequired() {
  try {
    const res = await fetch('/api/token-check');
    if (!res.ok) return;  // server error — assume auth not required
    const data = await res.json();
    if (data.requires_auth && !AUTH_TOKEN) {
      showAuthBanner(data.message);
      return false;
    }
  } catch {
    return;  // network error — fall through, let api() calls fail naturally
  }
  return true;
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
  btn.disabled = true;
  if (errEl) errEl.textContent = 'Validating…';
  try {
    const res = await fetch('/api/token-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      localStorage.setItem('dashboard_token', token);
      location.reload();
    } else {
      const data = await res.json().catch(() => ({}));
      if (errEl) errEl.textContent = data.error || 'Invalid token. Try again.';
      btn.disabled = false;
    }
  } catch (e) {
    if (errEl) errEl.textContent = 'Network error: ' + e.message;
    btn.disabled = false;
  }
}

// ─── Refresh functions ─────────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const data = await api('/api/status');

    // Status badge
    const badge = document.getElementById('status-badge');
    badge.textContent = data.status;
    badge.className = 'badge badge-' + data.status.toLowerCase();

    // Paper mode UI
    const paperBadge = document.getElementById('paper-badge');
    const pnlSuffix = document.getElementById('pnl-suffix');
    const switchPaperBtn = document.getElementById('switch-paper-btn');
    const switchLiveBtn = document.getElementById('switch-live-btn');
    if (data.paper_trading) {
      paperBadge.style.display = 'inline-block';
      pnlSuffix.style.display = 'inline';
      switchPaperBtn.style.display = 'none';
      switchLiveBtn.style.display = 'inline-block';
    } else {
      paperBadge.style.display = 'none';
      pnlSuffix.style.display = 'none';
      switchPaperBtn.style.display = 'inline-block';
      switchLiveBtn.style.display = 'none';
    }

    // Header wallet
    document.getElementById('wallet-address').textContent = 'Loading...';
    document.getElementById('wallet-balance').textContent = '-- SOL';

    isPaused = data.is_paused;

    // Update buttons
    document.getElementById('pause-btn').disabled = isPaused;
    document.getElementById('resume-btn').disabled = !isPaused;

    // Stats cards (only the fields refreshStatus owns — the P&L / win-rate /
    // total-trades cards are managed by refreshStats to avoid flicker.
    // 2026-06-06: removed placeholder overwrites that caused the stat cards
    // to flash "--" every 10s because refreshStatus polled more often than
    // refreshStats (REFRESH_MS vs REFRESH_MS*2).
    updateStatCard('stat-active-pos', data.active_positions);

    // Circuit breaker card
    const cbStatus = document.getElementById('cb-status-value');
    const cbLoss = document.getElementById('cb-daily-loss');
    const cbCount = document.getElementById('cb-trade-count');
    const cbMax = document.getElementById('cb-max-loss');
    const cbResetBtn = document.getElementById('cb-reset-btn');

    if (data.circuit_breaker_tripped) {
      cbStatus.textContent = '⚠ TRIPPED';
      cbStatus.style.color = 'var(--accent-loss)';
      cbResetBtn.disabled = false;
    } else {
      cbStatus.textContent = 'ACTIVE';
      cbStatus.style.color = 'var(--accent-profit)';
      cbResetBtn.disabled = true;
    }

    cbLoss.textContent = data.daily_loss_sol?.toFixed(4) + ' SOL';
    cbLoss.style.color = data.daily_loss_sol > 0 ? 'var(--accent-loss)' : 'var(--accent-profit)';
    cbCount.textContent = data.daily_trades;

  } catch (err) {
    addLog('error', 'status', err.message);
  }
}

async function refreshWallets() {
  try {
    const data = await api('/api/wallets');
    const list = document.getElementById('sub-wallets-list');

    if (!data.main && !data.sub_wallets?.length) {
      list.innerHTML = '<span class="loading">No wallet data</span>';
      return;
    }

    let html = '';

    if (data.main) {
      html += `<div class="sub-wallet-item">
        <span class="sw-label">Main</span>
        <span class="sw-address">${truncate(data.main.address, 12)}</span>
        <span class="sw-balance">${data.main.balance_sol?.toFixed(4) ?? '--'} SOL</span>
      </div>`;
    }

    for (const sw of (data.sub_wallets || [])) {
      // 2026-06-06: prefer display_balance from server (paper mode
      // shows "X.XX SOL (active)" if wallet has open position).
      const bal = sw.display_balance
        ? sw.display_balance
        : (sw.balance_sol != null ? sw.balance_sol.toFixed(4) + ' SOL' : '--');
      html += `<div class="sub-wallet-item">
        <span class="sw-index">#${sw.index}</span>
        <span class="sw-address">${truncate(sw.publicKey || sw.address, 12)}</span>
        <span class="sw-balance">${bal}</span>
      </div>`;
    }

    list.innerHTML = html;

    // Update header balance
    if (data.main) {
      document.getElementById('wallet-address').textContent = truncate(data.main.address, 16);
      document.getElementById('wallet-balance').textContent = data.main.balance_sol?.toFixed(4) + ' SOL';
    }

  } catch (err) {
    addLog('warn', 'wallets', err.message);
  }
}

async function refreshPositions() {
  try {
    const data = await api('/api/positions');
    const tbody = document.getElementById('positions-body');

    if (!data.positions?.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="loading">No active positions</td></tr>';
      return;
    }

    tbody.innerHTML = data.positions.map(pos => {
      const pnlClass = pos.pnl_pct >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlSign = pos.pnl_pct >= 0 ? '+' : '';
      const modeIcon = pos.source === 'paper' ? '🟡 P' : (pos.source === 'live' ? '🟢 L' : '⚪ ?');
      return `<tr>
        <td>${modeIcon}</td>
        <td><strong>${escHtml(pos.symbol || '?')}</strong></td>
        <td>$${pos.entry_price_usd?.toFixed(6) ?? '--'}</td>
        <td>${pos.current_price_usd ? '$' + pos.current_price_usd.toFixed(6) : '--'}</td>
        <td class="${pnlClass}">${pnlSign}${pos.pnl_pct?.toFixed(2) ?? '--'}%</td>
        <td>${pos.take_profit_pct ? pos.take_profit_pct + '%' : '--'}</td>
        <td>${pos.stop_loss_pct ?? '--'}%</td>
        <td>${formatDuration(pos.duration_minutes)}</td>
        <td>#${pos.sub_wallet_index ?? '?'}</td>
      </tr>`;
    }).join('');

  } catch (err) {
    addLog('warn', 'positions', err.message);
  }
}

async function refreshStats() {
  try {
    const data = await api('/api/stats');
    const pnl = data.total_pnl_sol ?? 0;
    const winRate = data.win_rate_pct ?? data.win_rate ?? 0;  // 2026-06-06: server returns win_rate_pct
    const totalTrades = data.total_trades ?? 0;

    // 2026-06-07: paper portfolio simulation. In paper mode, render the
    // starting balance + realized PnL + return % as a "PORTFOLIO (SIM)" card.
    // In live mode, fall back to absolute Total P&L (the original behavior).
    const pp = data.paper_portfolio;
    const pnlLabel = document.getElementById('stat-total-pnl-label');
    const pnlSub = document.getElementById('stat-total-pnl-sub');
    if (pp) {
      const sign = pp.return_pct >= 0 ? '+' : '';
      const color = pp.return_pct >= 0 ? 'profit' : 'loss';
      const value = pp.current_sol.toFixed(4) + ' SOL';
      updateStatCard('stat-total-pnl', value, color);
      if (pnlLabel) pnlLabel.textContent = 'Portfolio (Sim)';
      if (pnlSub) pnlSub.textContent = `${sign}${pp.return_pct.toFixed(2)}% dari ${pp.starting_balance_sol} SOL awal`;
    } else {
      updateStatCard('stat-total-pnl', (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + ' SOL', pnl >= 0 ? 'profit' : 'loss');
      if (pnlLabel) pnlLabel.textContent = 'Total P&L';
      if (pnlSub) pnlSub.textContent = '';
    }
    updateStatCard('stat-win-rate', winRate.toFixed(1) + '%');
    updateStatCard('stat-total-trades', totalTrades);

    // Signal accuracy table
    const signalBody = document.getElementById('signal-body');
    const signals = data.signal_accuracy || [];

    if (!signals.length) {
      signalBody.innerHTML = '<tr><td colspan="5" class="loading">No signal data</td></tr>';
    } else {
      signalBody.innerHTML = signals.map(s => {
        const wr = parseFloat(s.win_rate);
        return `<tr>
          <td>${escHtml(s.signal || '?')}</td>
          <td>${s.total || 0}</td>
          <td>${s.wins || 0}</td>
          <td class="${wr >= 50 ? 'pnl-positive' : 'pnl-negative'}">${s.win_rate}%</td>
          <td>${s.avg_pnl_pct != null ? (parseFloat(s.avg_pnl_pct) >= 0 ? '+' : '') + parseFloat(s.avg_pnl_pct).toFixed(2) + '%' : '--'}</td>
        </tr>`;
      }).join('');
    }

    // ── Source breakdown table ───────────────────────────────────────
    const sourceBody = document.getElementById('source-body');
    const bySource = data.by_source || {};
    const labelMap = {
      live:     '🟢 Live',
      paper:    '🟡 Paper',
      backtest: '🧪 Backtest',
    };
    const sourceRows = [];
    // Render known keys in fixed order, then any extra sources
    const orderedKeys = ['live', 'paper', 'backtest', ...Object.keys(bySource).filter(k => !(k in labelMap))];
    for (const src of orderedKeys) {
      const s = bySource[src];
      if (!s) continue;
      if (s.total === 0 && !(src in labelMap)) continue;  // skip zero entries for unknown sources
      const pnlSign = s.total_pnl_sol >= 0 ? '+' : '';
      const pnlClass = s.total_pnl_sol >= 0 ? 'pnl-positive' : 'pnl-negative';
      const simSuffix = (src === 'paper' || src === 'backtest') ? ' <span class="sim-tag">(sim)</span>' : '';
      const label = labelMap[src] || escHtml(src);
      sourceRows.push(`<tr>
        <td>${label}${simSuffix}</td>
        <td>${s.total}</td>
        <td>${s.wins}</td>
        <td>${s.win_rate_pct.toFixed(1)}%</td>
        <td class="${pnlClass}">${pnlSign}${s.total_pnl_sol.toFixed(4)} SOL</td>
      </tr>`);
    }
    sourceBody.innerHTML = sourceRows.length
      ? sourceRows.join('')
      : '<tr><td colspan="5" class="loading">No data yet</td></tr>';

    // Update PnL chart with last 30 trades
    if (data.recent_trades?.length) {
      renderPnLChart(data.recent_trades.slice(-30));
    }

  } catch (err) {
    addLog('warn', 'stats', err.message);
  }
}

async function refreshDaily() {
  try {
    const data = await api('/api/daily');

    // Update circuit breaker card with full data
    const cbLoss = document.getElementById('cb-daily-loss');
    const cbCount = document.getElementById('cb-trade-count');
    const cbMax = document.getElementById('cb-max-loss');

    cbLoss.textContent = (data.loss_sol_today ?? 0).toFixed(4) + ' SOL';
    cbLoss.style.color = (data.loss_sol_today ?? 0) > 0 ? 'var(--accent-loss)' : 'var(--accent-profit)';
    cbCount.textContent = data.trade_count_today ?? 0;
    cbMax.textContent = (data.max_daily_loss_sol ?? 0.2) + ' SOL';

  } catch (err) {
    addLog('warn', 'daily', err.message);
  }
}

// ─── Chart ────────────────────────────────────────────────────────────────────

function renderPnLChart(trades) {
  const canvas = document.getElementById('pnl-chart');
  if (!canvas) return;

  let cumulative = 0;
  const labels = [];
  const values = [];

  for (const trade of trades) {
    cumulative += trade.pnl_sol ?? 0;
    labels.push(trade.symbol || trade.id?.slice(0, 6) || '?');
    values.push(parseFloat(cumulative.toFixed(4)));
  }

  if (chartInstance) {
    chartInstance.destroy();
  }

  chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P&L (SOL)',
        data: values,
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34, 197, 94, 0.1)',
        fill: true,
        tension: 0.3,
        pointRadius: 3,
        pointBackgroundColor: values.map(v => v >= 0 ? '#22c55e' : '#ef4444'),
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ctx.parsed.y.toFixed(4) + ' SOL',
          },
        },
      },
      scales: {
        x: {
          display: false,
          grid: { color: '#2a2a2a' },
        },
        y: {
          grid: { color: '#2a2a2a' },
          ticks: { color: '#888', callback: v => v.toFixed(3) + ' SOL' },
        },
      },
    },
  });
}

// ─── Controls ─────────────────────────────────────────────────────────────────

async function pauseAgent() {
  try {
    await api('/api/pause', { method: 'POST' });
    isPaused = true;
    addLog('system', 'agent', 'Agent PAUSED');
    refreshStatus();
  } catch (err) {
    addLog('error', 'pause', err.message);
  }
}

async function resumeAgent() {
  try {
    await api('/api/resume', { method: 'POST' });
    isPaused = false;
    addLog('system', 'agent', 'Agent RESUMED');
    refreshStatus();
  } catch (err) {
    addLog('error', 'resume', err.message);
  }
}

async function resetCircuitBreaker() {
  try {
    await api('/api/circuit-breaker/reset', { method: 'POST' });
    addLog('system', 'cb', 'Circuit breaker reset');
    refreshStatus();
    refreshDaily();
  } catch (err) {
    addLog('error', 'cb', err.message);
  }
}

async function switchToPaper() {
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ agent: { paper_trading: true } }),
    });
    addLog('system', 'config', 'Switched to PAPER trading mode');
    location.reload();
  } catch (err) {
    addLog('error', 'config', `Failed to switch to paper: ${err.message}`);
  }
}

async function switchToLive() {
  const ok = confirm("⚠️ Switch ke LIVE TRADING?\n\nDana nyata akan digunakan.\nYakin lanjutkan?");
  if (!ok) return;
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ agent: { paper_trading: false } }),
    });
    addLog('system', 'config', 'Switched to LIVE trading mode');
    location.reload();
  } catch (err) {
    addLog('error', 'config', `Failed to switch to live: ${err.message}`);
  }
}

// ─── Log ──────────────────────────────────────────────────────────────────────

function addLog(type, source, message) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${ts}] [${source?.toUpperCase()}] ${message}`;

  logLines.push({ type, text: line });
  if (logLines.length > 50) logLines.shift();

  const box = document.getElementById('log-content');
  if (!box) return;

  box.innerHTML = logLines.map(l => {
    const cls = l.type === 'error' ? 'error' : l.type === 'warn' ? 'warn' : l.type === 'profit' ? 'profit' : l.type === 'system' ? 'system' : 'info';
    return `<span class="log-entry ${cls}">${escHtml(l.text)}</span>`;
  }).join('\n');

  // Auto-scroll to bottom
  const logBox = document.getElementById('log-box');
  logBox.scrollTop = logBox.scrollHeight;
}

// ─── Trade History (Last 20) ──────────────────────────────────────────────────

// 2026-06-06: render closed trades from /api/trades?status=closed.
// Table columns: Symbol | Mode | P&L% | P&L SOL | Exit Reason | Duration | Time.
async function refreshTrades() {
  try {
    const data = await api('/api/trades?limit=20&status=closed');
    const tbody = document.getElementById('trades-body');
    const trades = (data.trades || []).filter(t => t.exit_time != null);

    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="loading">No closed trades yet</td></tr>';
      return;
    }

    tbody.innerHTML = trades.map(t => {
      const pnlPct = t.pnl_pct ?? 0;
      const pnlSol = t.pnl_sol ?? 0;
      const pnlClass = pnlPct >= 0 ? 'pnl-positive' : 'pnl-negative';
      const pnlSign = pnlPct >= 0 ? '+' : '';
      const modeIcon = t.source === 'paper' ? '🟡 paper'
        : t.source === 'live' ? '🟢 live'
        : (t.source?.includes('backtest') || t.source?.includes('seed')) ? '📊 backtest'
        : '⚪ ?';
      const exitTime = t.exit_time ? new Date(t.exit_time).toLocaleString() : '--';
      const dur = t.hold_duration_minutes != null ? formatDuration(t.hold_duration_minutes) : '--';
      return `<tr>
        <td><strong>${escHtml(t.symbol || '?')}</strong></td>
        <td>${modeIcon}</td>
        <td class="${pnlClass}">${pnlSign}${pnlPct.toFixed(2)}%</td>
        <td class="${pnlClass}">${pnlSign}${pnlSol.toFixed(4)}</td>
        <td>${escHtml(t.exit_reason || '--')}</td>
        <td>${dur}</td>
        <td>${exitTime}</td>
      </tr>`;
    }).join('');

    // Re-render PnL chart with same data
    renderPnlChart(trades);
  } catch (err) {
    addLog('warn', 'trades', err.message);
  }
}

// 2026-06-06: cumulative P&L line chart from /api/trades.
// X axis: trade # (1, 2, 3...). Y axis: cumulative pnl_sol.
// Line color: green if final ≥ 0, red if final < 0. Baseline at y=0.
let pnlChartInstance = null;
function renderPnlChart(trades) {
  if (typeof Chart === 'undefined') return;  // CDN not loaded
  const canvas = document.getElementById('pnl-chart');
  if (!canvas) return;

  // Sort ascending by exit_time so cumulative is chronologically correct
  const sorted = [...trades].sort((a, b) => (a.exit_time || 0) - (b.exit_time || 0));
  let cum = 0;
  const data = sorted.map(t => { cum += (t.pnl_sol || 0); return cum; });
  const labels = sorted.map((_, i) => i + 1);
  const final = data.length ? data[data.length - 1] : 0;
  const lineColor = final >= 0 ? '#10b981' : '#ef4444';
  const fillColor = final >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Cumulative P&L (SOL)',
          data,
          borderColor: lineColor,
          backgroundColor: fillColor,
          fill: true,
          tension: 0.2,
          pointRadius: 3,
          pointBackgroundColor: lineColor,
        },
        {
          label: 'Baseline (y=0)',
          data: labels.map(() => 0),
          borderColor: 'rgba(255,255,255,0.3)',
          borderDash: [5, 5],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#e0e0e0' } },
        tooltip: { callbacks: { label: (ctx) => `Trade #${ctx.label}: ${ctx.parsed.y.toFixed(4)} SOL` } },
      },
      scales: {
        x: { title: { display: true, text: 'Trade #', color: '#a0a0a0' }, ticks: { color: '#a0a0a0' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { title: { display: true, text: 'Cumulative P&L (SOL)', color: '#a0a0a0' }, ticks: { color: '#a0a0a0' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  };

  if (pnlChartInstance) {
    pnlChartInstance.data = config.data;
    pnlChartInstance.options = config.options;
    pnlChartInstance.update();
  } else {
    pnlChartInstance = new Chart(canvas, config);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function updateStatCard(id, value, colorClass = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.className = 'stat-value' + (colorClass ? ' ' + colorClass : '');
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '...' + str.slice(-4);
}

function formatDuration(minutes) {
  if (minutes < 60) return minutes + 'm';
  if (minutes < 1440) return Math.floor(minutes / 60) + 'h';
  return Math.floor(minutes / 1440) + 'd';
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Button listeners
  document.getElementById('pause-btn').addEventListener('click', pauseAgent);
  document.getElementById('resume-btn').addEventListener('click', resumeAgent);
  document.getElementById('cb-reset-btn').addEventListener('click', resetCircuitBreaker);
  document.getElementById('switch-paper-btn')?.addEventListener('click', switchToPaper);
  document.getElementById('switch-live-btn')?.addEventListener('click', switchToLive);
  // 2026-06-06: auth banner submit handler
  document.getElementById('auth-submit-btn')?.addEventListener('click', submitAuthToken);
  document.getElementById('auth-token-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAuthToken();
  });

  // 2026-06-06: check auth first. If token required but missing, the banner
  // is shown and the dashboard content stays hidden until token is set.
  checkAuthRequired().then(ok => {
    if (!ok) return;  // banner showing, don't init polling
    hideAuthBanner();  // 2026-06-06: unhide dashboard after successful auth (was blank page bug)

    // Initial load
    refreshStatus();
    refreshWallets();
    refreshPositions();
    refreshStats();
    refreshDaily();
    refreshTrades();  // 2026-06-06: trade history + PnL chart

    addLog('system', 'dashboard', 'Dashboard connected');

    // Start polling loop
    setInterval(() => {
      refreshStatus();
      refreshPositions();
      refreshDaily();
    }, REFRESH_MS);

    setInterval(() => {
      refreshStats();
      refreshWallets();
      refreshTrades();  // 2026-06-06: refresh trade history + chart
    }, REFRESH_MS * 2);
  });
}

// ─── Run ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);