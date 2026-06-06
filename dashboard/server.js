import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { resetBucket as resetRateBucket } from '../core/rate-limiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// ─── State ─────────────────────────────────────────────────────────────────────

let isPaused = false;

// ─── Config helpers ───────────────────────────────────────────────────────────

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

function redactConfig(cfg) {
  const redacted = JSON.parse(JSON.stringify(cfg));
  const sensitiveKeys = ['api_key', 'private_key', 'api_hash', 'password', 'secret', 'token'];
  const redact = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      if (sensitiveKeys.some(s => lower.includes(s))) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        redact(obj[key]);
      }
    }
  };
  redact(redacted);
  return redacted;
}

// ─── Build app ─────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const config = loadConfig();
  const expectedToken = config.dashboard?.auth_token;
  const provided = req.headers['x-auth-token'];

  if (!expectedToken) {
    return res.status(500).json({ error: 'Dashboard auth not configured' });
  }

  if (provided !== expectedToken) {
    return res.status(401).json({ error: 'Invalid auth token' });
  }

  next();
}

export function buildApp() {
  const app = express();
  app.use(express.json());

  // Serve static files
  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // 2026-06-06: public endpoints (no auth required) — registered BEFORE
  // app.use('/api', authMiddleware) so the inline auth banner can call them
  // without a token. Replaces the broken 6-stacked-prompt() flow.
  app.get('/api/token-check', (req, res) => {
    const config = loadConfig();
    res.json({
      requires_auth: !!config.dashboard?.auth_token,
      message: 'Token authentication required. Enter the dashboard token from config.json (dashboard.auth_token).',
    });
  });

  app.post('/api/token-check', (req, res) => {
    const config = loadConfig();
    const expected = config.dashboard?.auth_token;
    const provided = req.body?.token;
    if (!expected) {
      return res.json({ valid: true, message: 'No auth configured on server' });
    }
    if (provided === expected) {
      return res.json({ valid: true });
    }
    return res.status(401).json({ valid: false, error: 'Invalid token' });
  });

  // Auth on all /api routes
  app.use('/api', authMiddleware);

  // ── GET /api/status ──────────────────────────────────────────────────────────
  app.get('/api/status', async (req, res) => {
    try {
      const config = loadConfig();

      // Get wallet info
      let mainBalanceSol = 0;
      let subWalletCount = 0;
      try {
        const { WalletManager } = await import('../core/wallet.js');
        const wm = new WalletManager(config);
        await wm.loadSubWallets();
        mainBalanceSol = await wm.getMainBalance();
        subWalletCount = wm.getSubWalletCount();
      } catch {}

      // Get active positions
      let activeCount = 0;
      let totalExposureSol = 0;
      try {
        const pm = await import('../execution/position.js');
        const active = await pm.getActivePositions();
        activeCount = active.length;
        totalExposureSol = active.reduce((s, p) => s + (p.amount_sol || 0), 0);
      } catch {}

      // Get circuit breaker status
      let cbStatus = {};
      try {
        const { CircuitBreaker } = await import('../core/circuit-breaker.js');
        const cb = new CircuitBreaker(config);
        await cb.loadDailyStats();
        cbStatus = await cb.getDailyStats();
      } catch {}

      const status = isPaused ? 'PAUSED' : (cbStatus.is_tripped ? 'TRIPPED' : 'RUNNING');

      res.json({
        status,
        paper_trading: config.agent?.paper_trading === true,
        main_balance_sol: mainBalanceSol,
        sub_wallet_count: subWalletCount,
        active_positions: activeCount,
        total_exposure_sol: totalExposureSol,
        is_paused: isPaused,
        circuit_breaker_tripped: cbStatus.is_tripped || false,
        daily_trades: cbStatus.trade_count_today || 0,
        daily_loss_sol: cbStatus.loss_sol_today || 0,
        config_hash: checksum(JSON.stringify(config)),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/positions ───────────────────────────────────────────────────────
  app.get('/api/positions', async (req, res) => {
    try {
      const pm = await import('../execution/position.js');
      const onchain = await import('../analysis/onchain.js');
      const config = loadConfig();

      const active = await pm.getActivePositions();

      // Enrich with current price and PnL
      const enriched = await Promise.all(active.map(async (pos) => {
        let currentPrice = null;
        let pnlPct = 0;
        let pnlSol = 0;

        try {
          const tokenData = await onchain.getTokenData(pos.token_address);
          currentPrice = tokenData?.price_usd;
          if (currentPrice && pos.entry_price_usd) {
            pnlPct = ((currentPrice - pos.entry_price_usd) / pos.entry_price_usd) * 100;
            pnlSol = (pnlPct / 100) * pos.amount_sol;
          }
        } catch {}

        const durationMin = Math.round((Date.now() - pos.entry_time) / 60000);

        return {
          id: pos.id,
          symbol: pos.symbol,
          token_address: pos.token_address,
          sub_wallet_index: pos.sub_wallet_index,
          entry_price_usd: pos.entry_price_usd,
          current_price_usd: currentPrice,
          pnl_pct: pnlPct,
          pnl_sol: pnlSol,
          amount_sol: pos.amount_sol,
          take_profit_pct: pos.take_profit_pct,
          hard_stop_loss_pct: pos.hard_stop_loss_pct,
          stop_loss_pct: pos.stop_loss_pct,
          entry_time: pos.entry_time,
          duration_minutes: durationMin,
          source: pos.source,
          signal_tags: pos.signal_tags || [],
          entry_market_cap_usd: pos.entry_market_cap_usd ?? null,  // 2026-06-07
        };
      }));

      res.json({ positions: enriched });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/trades ─────────────────────────────────────────────────────────
  // 2026-06-06: now returns full closed-trade record (symbol, source,
  // entry/exit_price_usd, pnl_pct, exit_reason, hold_duration_minutes,
  // exit_time) via updated getRecentPerformance. ORDER BY exit_time DESC
  // NULLS LAST so closed trades come first, open positions at the bottom.
  // For pure trade history (closed only) the frontend can pass
  // ?status=closed to filter.
  app.get('/api/trades', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page || 1));
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 20)));
      const offset = (page - 1) * limit;
      const statusFilter = req.query.status; // 'closed' | 'open' | undefined

      const { getRecentPerformance } = await import('../memory/ledger.js');

      // getRecentPerformance returns last N trades sorted by exit_time DESC
      const trades = await getRecentPerformance(limit * (page || 1));
      let allTrades = Array.isArray(trades) ? trades : [];

      // Apply status filter (closed = has exit_time; open = no exit_time)
      if (statusFilter === 'closed') {
        allTrades = allTrades.filter(t => t.exit_time != null);
      } else if (statusFilter === 'open') {
        allTrades = allTrades.filter(t => t.exit_time == null);
      }

      // Paginate manually
      const paginated = allTrades.slice(offset, offset + limit);

      res.json({
        trades: paginated,
        page,
        limit,
        total: allTrades.length,
        total_pages: Math.ceil(allTrades.length / limit),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/stats ───────────────────────────────────────────────────────────
  app.get('/api/stats', async (req, res) => {
    try {
      const { getLedgerStats, getSignalAccuracy } = await import('../memory/ledger.js');
      const config = loadConfig();
      const stats = await getLedgerStats(50);
      const signalAccuracy = await getSignalAccuracy(50);

      // 2026-06-07: paper portfolio simulation — track starting balance +
      // realized paper PnL so the user can see return % against initial
      // capital. Only populated when paper_trading=true.
      const isPaper = config.agent?.paper_trading === true;
      let paper_portfolio = null;
      if (isPaper) {
        const startingBalance = config.paper_trading?.paper_starting_balance_sol ?? 1.0;
        const realizedPnl = stats.by_source?.paper?.total_pnl_sol ?? 0;
        const currentPortfolio = startingBalance + realizedPnl;
        const returnPct = startingBalance > 0 ? (realizedPnl / startingBalance) * 100 : 0;
        paper_portfolio = {
          starting_balance_sol: startingBalance,
          current_sol: currentPortfolio,
          realized_pnl_sol: realizedPnl,
          return_pct: returnPct,
        };
      }

      res.json({
        ...stats,  // includes by_source breakdown (live/paper/backtest/etc.)
        signal_accuracy: signalAccuracy,
        paper_trading: isPaper,
        paper_portfolio,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/daily ───────────────────────────────────────────────────────────
  app.get('/api/daily', async (req, res) => {
    try {
      const cb = await import('../core/circuit-breaker.js');
      const config = loadConfig();
      const daily = await cb.getDailyStats();

      res.json({
        ...(daily || {}),
        max_daily_loss_sol: config.circuit_breaker?.max_daily_loss_sol || 0.2,
        max_daily_trades: config.circuit_breaker?.max_daily_trades || 20,
        reset_hour_utc: config.circuit_breaker?.reset_hour_utc || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/wallets ──────────────────────────────────────────────────────────
  app.get('/api/wallets', async (req, res) => {
    try {
      // Use the standalone wallet functions (not the class) — the class
      // expects a real RPC and may fail in test environments.
      const wallet = await import('../core/wallet.js');
      const config = loadConfig();
      const authTokenPresent = !!config.wallet?.rpc_endpoint;

      let mainPubkey = 'unknown';
      let mainBalance = 0;
      let subWallets = [];

      try {
        mainPubkey = wallet.getMainPublicKey();
        mainBalance = await wallet.getMainBalance();
      } catch (e) {
        // No wallet configured (e.g., env var missing) — return empty
      }

      try {
        const balances = await wallet.getAllSubWalletBalances();
        subWallets = balances;
      } catch (e) {
        // Sub-wallet fetch failed — return empty array
      }

      // Simulated balance per sub-wallet: "X.XX SOL (active)" if has open
      // position, else "0.00 SOL". Paper mode has no real SOL, so we surface
      // committed amounts (open positions) instead of the real RPC balance.
      // 2026-06-06: requested simplification — don't compute closed pnl.
      let activeBySubWallet = {};
      try {
        const pm = await import('../execution/position.js');
        const active = await pm.getActivePositions();
        for (const p of active) {
          const idx = p.sub_wallet_index;
          if (!idx) continue;
          activeBySubWallet[idx] = (activeBySubWallet[idx] || 0) + (p.amount_sol || 0);
        }
      } catch {}

      subWallets = subWallets.map(sw => {
        const committed = activeBySubWallet[sw.index] || 0;
        return {
          ...sw,
          balance_sol: sw.balance ?? sw.balance_sol ?? 0,  // real RPC balance (0 in paper)
          committed_sol: committed,
          display_balance: committed > 0
            ? `${committed.toFixed(2)} SOL (active)`
            : '0.00 SOL',
        };
      });

      res.json({
        main: {
          address: mainPubkey,
          balance_sol: mainBalance,
        },
        sub_wallets: subWallets,
        rpc_configured: authTokenPresent,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/config ──────────────────────────────────────────────────────────
  app.get('/api/config', (req, res) => {
    const cfg = loadConfig();
    res.json(redactConfig(cfg));
  });

  // ── POST /api/config ──────────────────────────────────────────────────────────
  app.post('/api/config', async (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Invalid config body' });
      }

      const configPath = path.join(__dirname, '..', 'config.json');
      const current = loadConfig();

      // Deep merge
      const merged = deepMerge(current, updates);

      // Log changes
      const changes = diffConfig(current, merged);
      if (changes.length > 0) {
        console.log('[config] Changes:', changes.join(' | '));
      }

      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));

      // Hot-reload: if rate_limits changed, reset cached buckets so the
      // next acquire() re-reads from the new config. 2026-06-06: added
      // so config.json edits take effect without restarting the agent.
      if (updates?.rate_limits) {
        for (const svc of Object.keys(updates.rate_limits)) {
          try { resetRateBucket(svc); } catch {}
        }
      }

      res.json({ success: true, message: 'Config updated', changes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Helper: deep merge objects
  function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
      ) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  // Helper: produce human-readable change list
  function diffConfig(before, after, prefix = '') {
    const changes = [];
    for (const key of Object.keys(after)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (before[key] !== after[key]) {
        if (
          after[key] && typeof after[key] === 'object' && !Array.isArray(after[key]) &&
          before[key] && typeof before[key] === 'object' && !Array.isArray(before[key])
        ) {
          changes.push(...diffConfig(before[key], after[key], fullKey));
        } else {
          changes.push(`${fullKey}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);
        }
      }
    }
    return changes;
  }

  // ── POST /api/pause ──────────────────────────────────────────────────────────
  app.post('/api/pause', (req, res) => {
    isPaused = true;
    res.json({ success: true, status: 'PAUSED' });
  });

  // ── POST /api/resume ─────────────────────────────────────────────────────────
  app.post('/api/resume', (req, res) => {
    isPaused = false;
    res.json({ success: true, status: 'RUNNING' });
  });

  // ── POST /api/circuit-breaker/reset ─────────────────────────────────────────
  app.post('/api/circuit-breaker/reset', async (req, res) => {
    try {
      const cb = await import('../core/circuit-breaker.js');
      await cb.reset();
      res.json({ success: true, status: 'reset' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// ─── Start server ──────────────────────────────────────────────────────────────

export function startServer() {
  const config = loadConfig();
  const port = config.dashboard?.port || 3000;
  const app = buildApp();

  app.listen(port, () => {
    console.log(`[dashboard] Server running on port ${port}`);
  });
}

// ─── Checksum helper ──────────────────────────────────────────────────────────

function checksum(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// ─── Run if called directly ──────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('server.js');
if (isMain) {
  startServer();
}