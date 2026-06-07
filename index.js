import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createLogger } from './core/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const log = createLogger('main');

// ─── Load config ───────────────────────────────────────────────────────────────

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  return JSON.parse(raw);
}

function validateConfig(config) {
  const required = [
    'llm.api_key',
    'wallet.private_key',
    'feeds.screener.enabled',
    'position.max_concurrent_positions',
    'position.hard_stop_loss_pct',
    'memory.ledger.db_path',
  ];

  const missing = [];
  for (const key of required) {
    const parts = key.split('.');
    let val = config;
    for (const p of parts) {
      val = val?.[p];
    }
    if (val === undefined || val === null) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required config fields: ${missing.join(', ')}`);
  }

  // ── Type validation ──────────────────────────────────────────────────────
  const typeErrors = [];

  const numFields = [
    'position.max_concurrent_positions',
    'position.hard_stop_loss_pct',
    'position.default_take_profit_pct',
    'wallet.max_sub_wallets',
  ];
  for (const key of numFields) {
    const parts = key.split('.');
    let val = config;
    for (const p of parts) val = val?.[p];
    if (val !== undefined && typeof val !== 'number') {
      typeErrors.push(`${key} must be number, got ${typeof val}`);
    }
  }

  const boolFields = [
    'feeds.screener.enabled',
    'agent.paper_trading',
    'wallet.use_devnet',
  ];
  for (const key of boolFields) {
    const parts = key.split('.');
    let val = config;
    for (const p of parts) val = val?.[p];
    if (val !== undefined && typeof val !== 'boolean') {
      typeErrors.push(`${key} must be boolean, got ${typeof val}`);
    }
  }

  if (typeErrors.length > 0) {
    throw new Error(`Config type errors: ${typeErrors.join('; ')}`);
  }

  return true;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

let isShuttingDown = false;
let activeLlmCalls = 0;

// Simple async mutex — serializes buy decisions to prevent race condition
// on max_concurrent_positions check. Parallel handleToken calls previously all
// saw the same activePositions count and all passed the check, opening more
// positions than max_concurrent allows. With this lock, the max check + buy
// execution are atomic across concurrent handleToken calls.
let buyLock = Promise.resolve();
async function withBuyLock(fn) {
  const prev = buyLock;
  let release;
  buyLock = new Promise(r => { release = r; });
  try { return await fn(); } finally { release(); }
}

// ─── Pause state (2026-06-07: dashboard Pause/Resume button) ────────────────
let isPaused = false;
export function setPaused(v) { isPaused = v; }
export function getPaused() { return isPaused; }

// ─── Dashboard state buffers (read by /api/decisions, /api/rejections,
//      /api/feed-stats via dashboard/server.js) ─────────────────────────
export const dashboardState = {
  recentDecisions: [],   // circular buffer, max 10, newest first
  rejectionStats: {},    // reason → count
  feedStats: {           // source → count
    gmgn_trending: 0,
    gmgn_new: 0,
    telegram: 0,
    twitter: 0,
  },
};

const MAX_DECISIONS = 10;

export function pushDecision(dec) {
  dashboardState.recentDecisions.unshift(dec);
  if (dashboardState.recentDecisions.length > MAX_DECISIONS) {
    dashboardState.recentDecisions.pop();
  }
}

export function incrementRejection(reason) {
  dashboardState.rejectionStats[reason] =
    (dashboardState.rejectionStats[reason] || 0) + 1;
}

export function incrementFeedStat(source) {
  dashboardState.feedStats[source] = (dashboardState.feedStats[source] || 0) + 1;
}

// ─── CLI args parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isBacktest = args.includes('--backtest');
const isSeedBacktest = args.includes('--seed');
const isDashboard = args.includes('--dashboard');

async function main() {
  // ── 0a. Seed backtest mode (synthetic data for ledger/RAG population) ──
  if (isSeedBacktest) {
    log.info('backtest', 'Running seed backtest...');
    const { runSeedBacktest } = await import('./backtest/seed.js');
    const results = await runSeedBacktest();
    if (results) {
      const { generateReport } = await import('./backtest/report.js');
      const resultsDir = path.join(__dirname, 'backtest', 'results');
      const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('seed_') && f.endsWith('.json'))
        .sort().reverse();
      if (files.length > 0) {
        const latest = path.join(resultsDir, files[0]);
        await generateReport(latest);
      }
    }
    process.exit(0);
  }

  // ── 0. Backtest mode (short-circuits before full init) ───────────────────
  if (isBacktest) {
    log.info('backtest', 'Starting backtest mode...');
    const { runBacktest } = await import('./backtest/runner.js');
    const results = await runBacktest();
    if (results) {
      const { generateReport } = await import('./backtest/report.js');
      const resultsDir = path.join(__dirname, 'backtest', 'results');
      const files = fs.readdirSync(resultsDir)
        .filter(f => f.startsWith('backtest_') && f.endsWith('.json'))
        .sort().reverse();
      if (files.length > 0) {
        const latest = path.join(resultsDir, files[0]);
        await generateReport(latest);
      }
    }
    process.exit(0);
  }

  log.info('Starting TrenchAgent...');

  // ── 1. Load and validate config ────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
    validateConfig(config);
    log.info('config', 'Config loaded and validated');
  } catch (err) {
    log.error('config', `Failed to load config: ${err.message}`);
    process.exit(1);
  }

  // ── 2. Initialize rate limiter (module-level state, no class needed) ─────
  let rateLimiter;
  try {
    rateLimiter = await import('./core/rate-limiter.js');
    log.info('rate-limiter', 'Initialized');
  } catch (err) {
    log.error('rate-limiter', `Failed: ${err.message}`);
    process.exit(1);
  }

  // ── 3. Initialize circuit breaker ─────────────────────────────────────────
  let circuitBreaker;
  try {
    circuitBreaker = await import('./core/circuit-breaker.js');
    const stats = await circuitBreaker.getDailyStats();
    if (stats.is_tripped) {
      log.warn('circuit-breaker', `Tripped: ${stats.tripped_reason} — trading disabled until reset`);
    } else {
      log.info('circuit-breaker', `Daily: ${stats.trade_count_today} trades, ${stats.loss_sol_today.toFixed(3)} SOL lost`);
    }
  } catch (err) {
    log.error('circuit-breaker', `Failed: ${err.message}`);
    process.exit(1);
  }

  // ── 4. Initialize wallet ──────────────────────────────────────────────────
  let wallet;
  try {
    const { WalletManager } = await import('./core/wallet.js');
    wallet = new WalletManager(config);
    await wallet.loadSubWallets();
    const mainBalance = await wallet.getMainBalance();
    const subCount = wallet.getSubWalletCount();
    log.info('wallet', `Main: ${mainBalance.toFixed(4)} SOL, ${subCount} sub-wallets`);
  } catch (err) {
    log.error('wallet', `Failed: ${err.message}`);
    process.exit(1);
  }

  // ── 5. Initialize database (DB auto-initializes on first getDb call) ─────
  let db;
  try {
    const { getDbInstance } = await import('./memory/ledger.js');
    db = getDbInstance();
    log.info('db', 'SQLite initialized');
  } catch (err) {
    log.error('db', `Failed: ${err.message}`);
    process.exit(1);
  }

  // ── 6. Initialize RAG (module-level functions, no class needed) ───────────
  let rag;
  try {
    rag = await import('./memory/rag.js');
    const dbDir = path.dirname(config.memory.ledger.db_path);
    const vectorDbPath = path.join(dbDir, 'vector-index');
    log.info('rag', `Vector index module loaded (path: ${vectorDbPath})`);
  } catch (err) {
    log.error('rag', `Failed: ${err.message}`);
    // Non-fatal — RAG can be lazy-initialized
    rag = null;
  }

  // ── 7. Recover active positions ────────────────────────────────────────────
  let positionManager;
  try {
    const pm = await import('./execution/position.js');
    await pm.loadPositionsFromDb();
    const active = await pm.getActivePositions();
    log.info('positions', `Recovered ${active.length} active position(s)`);
    positionManager = pm;
  } catch (err) {
    log.error('positions', `Failed to recover: ${err.message}`);
    positionManager = await import('./execution/position.js');
  }

  // ── 8. Initialize onchain data fetcher ───────────────────────────────────
  const onchain = await import('./analysis/onchain.js');
  const onchainSnapshot = await import('./analysis/onchain-snapshot.js');

  // ── 9. Initialize brain ────────────────────────────────────────────────────
  const brain = await import('./brain/decision.js');
  const positionBrain = await import('./brain/position-manager.js');

  // ── 10. Initialize executor (paper or jupiter based on config) ─────────
  const isPaperMode = config.agent?.paper_trading === true;
  const executor = await import(
    isPaperMode ? './execution/paper.js' : './execution/jupiter.js'
  );

  // ── 10b. Print trading mode banner ─────────────────────────────────────
  if (isPaperMode) {
    log.warn('══════════════════════════════════════');
    log.warn('  🟡 PAPER TRADING MODE AKTIF         ');
    log.warn('  Tidak ada transaksi nyata            ');
    log.warn('══════════════════════════════════════');
  } else {
    log.info('══════════════════════════════════════');
    log.info('  🟢 LIVE TRADING MODE AKTIF          ');
    log.info('  Dana nyata akan digunakan           ');
    log.info('══════════════════════════════════════');
  }

  // ── 11. Initialize feed aggregator ────────────────────────────────────────
  let aggregator;
  try {
    const { FeedAggregator } = await import('./feeds/aggregator.js');
    aggregator = new FeedAggregator();
    log.info('feeds', 'Aggregator created');

    // ── Wire feed sources (GMGN primary; legacy pumpfun + screener disabled) ──
    // GMGN replaces both pumpfun.js + screener.js (migrated 2026-06-06).
    // The legacy files (feeds/screener.js, feeds/pumpfun.js) are shims that
    // re-export from feeds/gmgn.js for backward compat.
    // To rollback: rename feeds/gmgn.js.bak → feeds/gmgn.js + revert this block.
    if (config.feeds?.gmgn?.enabled !== false) {
      try {
        const { createGmgnFeed } = await import('./feeds/gmgn.js');
        const gmgn = createGmgnFeed(config.feeds.gmgn || config.gmgn);
        aggregator.addSource(gmgn);
        log.info('feeds', 'Wired: gmgn (trending_5m, new_creation, near_graduation, kol_new)');
      } catch (e) {
        log.warn('feeds', `gmgn wire failed: ${e.message}`);
      }
    }
    // Legacy: pumpfun + screener disabled (see config.json)
    // Original blocks kept here for rollback reference:
    //   if (config.feeds?.pumpfun?.enabled !== false) { ... feeds/pumpfun.js ... }
    //   if (config.feeds?.screener?.enabled) { ... feeds/screener.js ... }
  } catch (err) {
    log.error('feeds', `Failed to create aggregator: ${err.message}`);
    aggregator = null;
  }

  // ── 11b. Aggregator poll loop (every 30s) ─────────────────────────────────
  // aggregate() returns deduped tokens but does NOT emit them.
  // Track emitted addresses locally so we only fire onToken once per token.
  if (aggregator) {
    const pollIntervalMs = 30000;
    const emittedAddresses = new Set();
    const aggregatorPoll = setInterval(async () => {
      if (isShuttingDown) return;
      try {
        const tokens = await aggregator.aggregate();
        let pushed = 0;
        for (const t of tokens) {
          const addr = t.address || t.mint;
          if (emittedAddresses.has(addr)) continue;
          emittedAddresses.add(addr);
          aggregator._emit(t); // emit directly, bypassing dedupe (already deduped)
          pushed++;
        }
        if (tokens.length > 0) {
          log.info('aggregator', `Poll: ${tokens.length} unique, ${pushed} new emitted`);
        }
      } catch (e) {
        log.warn('aggregator', `Poll failed: ${e.message}`);
      }
    }, pollIntervalMs);
    log.info('aggregator', `Poll loop started (every ${pollIntervalMs}ms)`);
  }

  // ── 12. Start feed aggregator ─────────────────────────────────────────────
  if (aggregator) {
    try {
      await aggregator.start();
      const feeds = aggregator.getActiveFeeds();
      log.info('feeds', `Started: ${feeds.join(', ')}`);
    } catch (err) {
      log.error('feeds', `Failed to start: ${err.message}`);
    }
  }

  // ── 13. Register token handler ────────────────────────────────────────────
  if (aggregator) {
    aggregator.onToken(async (token) => {
      if (isShuttingDown) return;
      if (isPaused) return;  // 2026-06-07: dashboard Pause — monitor positions still runs in main loop
      // Track feed source for dashboard /api/feed-stats
      if (token.signal_type === 'trending_5m') {
        incrementFeedStat('gmgn_trending');
      } else if (['new_creation', 'near_graduation', 'kol_new'].includes(token.signal_type)) {
        incrementFeedStat('gmgn_new');
      } else if (token.source === 'telegram') {
        incrementFeedStat('telegram');
      } else if (token.source === 'twitter') {
        incrementFeedStat('twitter');
      }
      await handleToken(token, {
        config, wallet, circuitBreaker, rateLimiter,
        brain, positionBrain, onchain, onchainSnapshot,
        executor, positionManager, rag, log,
        isPaperMode,
      });
    });
  }

  // ── 14. Position monitor loop ────────────────────────────────────────────
  const monitorIntervalMs = config.position?.monitor_interval_ms ?? 30000;
  const monitorLoop = setInterval(async () => {
    if (isShuttingDown) return;
    await runPositionMonitor({
      config, circuitBreaker, positionBrain, onchain,
      executor, positionManager, wallet, log,
      isPaperMode,
    });
  }, monitorIntervalMs);
  log.info('monitor', `Position monitor started (every ${monitorIntervalMs}ms)`);

  // ── 15. Snapshot loop ────────────────────────────────────────────────────
  const snapshotIntervalMs = config.position?.snapshot_interval_ms ?? 300000;
  const snapshotLoop = setInterval(async () => {
    if (isShuttingDown) return;
    const active = await positionManager.getActivePositions();
    for (const pos of active) {
      try {
        await onchainSnapshot.takeSnapshot(pos);
      } catch (err) {
        log.warn('snapshot', `Failed for ${pos.symbol}: ${err.message}`);
      }
    }
  }, snapshotIntervalMs);
  log.info('snapshot', `Snapshot loop started (every ${snapshotIntervalMs}ms)`);

  // ── 16. Register shutdown handlers ───────────────────────────────────────
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.warn('shutdown', `Received ${signal} — graceful shutdown initiated`);

    // Stop accepting new tokens
    if (aggregator) aggregator.stop();
    clearInterval(monitorLoop);
    clearInterval(snapshotLoop);

    // Wait for active LLM calls to finish (max 30s)
    let waited = 0;
    while (activeLlmCalls > 0 && waited < 30000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }

    // Log active positions
    const active = await positionManager.getActivePositions();
    if (active.length > 0) {
      log.warn('shutdown', `${active.length} active position(s) still open:`);
      for (const pos of active) {
        log.warn('shutdown', `  - ${pos.symbol} @ ${pos.entry_price_usd} USD, wallet #${pos.sub_wallet_index}`);
      }
    }

    log.info('shutdown', 'Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info('main', `TrenchAgent running — ${(await positionManager.getActivePositions()).length} active positions`);

  // Start dashboard server in-process (no separate command needed)
  try {
    const { startServer: startDashboard } = await import('./dashboard/server.js');
    // Pass setters via state so dashboard endpoints can pause/resume
    dashboardState.setPaused = (v) => { isPaused = v; };
    dashboardState.getPaused = () => isPaused;
    startDashboard(dashboardState);
  } catch (err) {
    log.warn('dashboard', `Failed to start dashboard: ${err.message}`);
  }
}

// ─── Token handler ────────────────────────────────────────────────────────────

async function handleToken(token, deps) {
  const {
    config, wallet, circuitBreaker, rateLimiter,
    brain, positionBrain, onchain, onchainSnapshot,
    executor, positionManager, rag, log, isPaperMode,
  } = deps;

  const { symbol, address } = token;
  log.info('token', `Processing: ${symbol} (${address})`);

  // Build context
  const activePositions = await positionManager.getActivePositions();
  const dailyStats = await circuitBreaker.getDailyStats();

  // Count consecutive losses from ledger (2026-06-07: walk backward from most recent)
  let consecutiveLosses = 0;
  let lastLossTime = null;  // 2026-06-07: BUG 1 fix — checkCooldown needs this to verify cooldown elapsed
  try {
    const { getRecentPerformance } = await import('./memory/ledger.js');
    const recent = await getRecentPerformance(20);  // wider window for accurate consecutive count
    const lastTrades = Array.isArray(recent) ? recent : [];
    for (const t of lastTrades) {
      if (t.pnl_sol < 0) {
        consecutiveLosses++;
        if (lastLossTime === null && t.exit_time) lastLossTime = t.exit_time;  // most recent loss
      } else {
        break;  // 2026-06-07: stop at first non-loss (replaces overly-conservative `every()`)
      }
    }
  } catch {}

  // Calculate total exposure
  const totalExposureSol = activePositions.reduce((sum, p) => sum + (p.amount_sol || 0), 0);

  const context = {
    activePositions,
    consecutiveLosses,
    lastLossTime,  // 2026-06-07: BUG 1 fix — was missing, caused agent stuck in cooldown
    totalExposureSol,
    dailyStats,
  };

  // ── Fetch on-chain data FIRST (enriches token with liquidity/holders) ──
  let tokenData;
  try {
    tokenData = await onchain.getTokenData(address, token);
    if (!tokenData || tokenData.error) {
      log.warn('onchain', `No data for ${symbol} — skipping`);
      return;
    }
    // Merge screener source info into enriched data
    tokenData.source = token.source;
    tokenData.source_confidence = token.source_confidence;
    if (token.pair_url) tokenData.pair_url = token.pair_url;
  } catch (err) {
    log.warn('onchain', `Fetch failed for ${symbol}: ${err.message}`);
    return;
  }

  // ── Hard rules check (single, with enriched data) ─────────────────────
  let hardRulesResult;
  try {
    const { runAllChecks } = await import('./core/hard-rules.js');
    hardRulesResult = await runAllChecks(tokenData, context);
    if (!hardRulesResult.passed) {
      log.info('skip', `${symbol}: ${hardRulesResult.failures.join(', ')}`);
      // Categorize rejection for dashboard /api/rejections
      for (const f of hardRulesResult.failures) {
        let cat = 'other';
        if (/dev_wallet/i.test(f)) cat = 'dev_wallet';
        else if (/liquidity|liq/i.test(f)) cat = 'liq_missing';
        else if (/honeypot/i.test(f)) cat = 'honeypot';
        else if (/bundler/i.test(f)) cat = 'bundler';
        incrementRejection(cat);
      }
      return;
    }
  } catch (err) {
    log.warn('hard-rules', `Check failed for ${symbol}: ${err.message}`);
    return;
  }

  // ── Circuit breaker ───────────────────────────────────────────────────────
  if (dailyStats.is_tripped) {
    log.info('skip', `${symbol}: circuit breaker tripped`);
    incrementRejection('circuit_breaker');
    return;
  }
  // NOTE: max_concurrent check moved INSIDE withBuyLock (see below) to prevent
  // race condition with parallel handleToken calls.

  // ── Fetch similar trades from RAG ─────────────────────────────────────────
  let similarTrades = [];
  if (rag) {
    try {
      const { findSimilarTrades } = await import('./memory/rag.js');
      similarTrades = await findSimilarTrades(tokenData, config.memory?.rag?.top_k ?? 5);
      log.info('rag', `Found ${similarTrades.length} similar trades for ${symbol}`);
    } catch (err) {
      log.warn('rag', `Similar trades lookup failed: ${err.message}`);
    }
  }

  // ── Fetch ledger stats ────────────────────────────────────────────────────
  let ledgerStats = {};
  try {
    const { getLedgerStats } = await import('./memory/ledger.js');
    ledgerStats = await getLedgerStats(50);
  } catch (err) {
    log.warn('ledger', `Stats fetch failed: ${err.message}`);
  }

  // ── LLM trade decision (paper mock or real LLM) ───────────────────────
  let decision;
  activeLlmCalls++;
  try {
    const { makeTradeDecision, generatePaperSignal } = await import('./brain/decision.js');
    // Paper mode: deterministic mock signal. Live mode: real LLM (TODO).
    const llmSignal = generatePaperSignal(tokenData);
    log.info('llm', `${symbol}: paper signal = ${llmSignal.signal} (confidence ${llmSignal.confidence.toFixed(2)})`);
    decision = await makeTradeDecision(tokenData, llmSignal, hardRulesResult);
  } catch (err) {
    log.error('brain', `Entry decision failed for ${symbol}: ${err.message}`);
    return;
  } finally {
    activeLlmCalls--;
  }

  // Record decision for dashboard /api/decisions
  pushDecision({
    symbol: symbol,
    token_address: address,
    decision: decision.decision,
    confidence: decision.confidence || 0,
    reasoning: decision.reasoning || decision.reason || '',
    signal_tags: decision.signal_tags || decision.tags || [],
    timestamp: Date.now(),
  });

  if (decision.decision !== 'BUY') {
    log.info('decision', `${symbol}: ${decision.decision} (confidence ${(decision.confidence || 0).toFixed(2)})`);
    incrementRejection('llm_skip');
    return;
  }

  log.info('decision', `${symbol}: BUY — confidence ${(decision.confidence || 0).toFixed(2)}, tier ${decision.tier || 'unknown'}`);

  // Define tradeSource OUTSIDE the lock so it's in scope for the RAG
  // indexTrade() call below (line ~642). Previously it was defined inside
  // withBuyLock which made it inaccessible → "tradeSource is not defined"
  // error in RAG. 2026-06-06.
  const tradeSource = isPaperMode ? 'paper' : 'live';
  const feedSource = token.source || 'unknown';

  // ── Execute buy (atomic with max_concurrent check) ────────────────────────
  // Wrap max check + buy execution in mutex to prevent race condition where
  // parallel handleToken calls all see the same activePositions count and
  // all pass the check. Inside the lock, re-fetch live count and abort if
  // max reached.
  const buyResult = await withBuyLock(async () => {
    const livePositions = await positionManager.getActivePositions();
    const maxConcurrent = config.position?.max_concurrent_positions ?? 3;
    if (livePositions.length >= maxConcurrent) {
      return { skipped: true, reason: `max concurrent positions reached (${livePositions.length}/${maxConcurrent}) inside lock` };
    }

    const subWallet = wallet.getNextSubWallet();
    if (!subWallet) {
      log.error('wallet', 'No sub-wallet available');
      return { skipped: true, reason: 'no sub-wallet available' };
    }

    const entryParams = decision.entry_params || {};
    // Default to config.position.size_sol (paper mode safe) or 0.5 as last-resort fallback
    const amountSol = entryParams.amount_sol ?? config.position?.size_sol ?? 0.5;
    const multiplier = decision.position_size_multiplier ?? 1.0;
    const finalAmount = amountSol * multiplier;

    log.info('trade', `BUY ${symbol}: ${finalAmount.toFixed(3)} SOL via wallet #${subWallet.index}`);

    // Fund sub-wallet (skip in paper mode — no actual SOL transfer)
    if (!isPaperMode) {
      try {
        await wallet.fundSubWallet(subWallet.index, finalAmount);
      } catch (err) {
        log.warn('wallet', `Fund sub-wallet failed: ${err.message}`);
      }
    }

    let result;
    try {
      result = await executor.buyToken(subWallet.keypair, address, finalAmount, {
        slippageBps: entryParams.slippage_bps ?? 300,
        useJito: config.wallet?.use_jito ?? false,
        useDevnet: config.wallet?.use_devnet ?? false,
      });
    } catch (err) {
      log.error('trade', `Buy failed for ${symbol}: ${err.message}`);
      return { skipped: true, reason: `buy failed: ${err.message}` };
    }

    // Open position INSIDE the lock so the map is updated atomically with
    // the max check (prevents race where parallel buys both pass the check
    // and openPosition is called outside the lock).
    // tradeSource + feedSource are defined OUTSIDE this lock (see above)
    // so they're in scope for the RAG indexTrade() call after the lock.
    const position = await positionManager.openPosition({
      token_address: address,
      symbol,
      sub_wallet_index: subWallet.index,
      entry_price_usd: result.entryPriceUsd || tokenData.price_usd || 0,
      entry_market_cap_usd: tokenData.market_cap ?? null,  // 2026-06-07
      amount_sol: finalAmount,
      hard_stop_loss_pct: config.position?.hard_stop_loss_pct ?? 20,
      take_profit_pct: entryParams.take_profit_pct ?? null,
      tp_sl_adjustor: null,
      source: tradeSource,
      feed_source: feedSource,
      entry_reasoning: decision.reasoning || '',
      llm_confidence: decision.confidence || 0,
      signal_tags: decision.signal_tags || [],
    });

    return { skipped: false, subWallet, finalAmount, result, entryParams, position };
  });

  if (buyResult.skipped) {
    log.info('skip', `${symbol}: ${buyResult.reason}`);
    return;
  }

  const { subWallet, finalAmount, result, entryParams, position } = buyResult;

  // (position already added to map inside the lock)

  try {
    // Record to circuit breaker
    circuitBreaker.recordTrade();

    // Index to RAG
    if (rag) {
      try {
        const { indexTrade } = await import('./memory/rag.js');
        await indexTrade(
          {
            trade_id: position.id,
            symbol,
            entry_reasoning: decision.reasoning || '',
            llm_confidence: decision.confidence || 0,
            signal_tags: decision.signal_tags || [],
            entry_time: Date.now(),
            hold_duration_minutes: 0,
            exit_reason: 'open',
            pnl_pct: 0,
            pnl_sol: 0,
            source: tradeSource,
            feed_source: feedSource,
          },
          [] // trajectory empty at entry
        );
      } catch (err) {
        log.warn('rag', `Index failed for ${symbol}: ${err.message}`);
      }
    }

    log.info('position', `Opened: ${symbol} — ${finalAmount} SOL, SL ${position.hard_stop_loss_pct}%`);
  } catch (err) {
    log.error('position', `Failed to record position for ${symbol}: ${err.message}`);
  }
}

// ─── Position monitor loop ────────────────────────────────────────────────────

async function runPositionMonitor(deps) {
  const {
    config, circuitBreaker, positionBrain, onchain,
    executor, positionManager, wallet, log, isPaperMode,
  } = deps;

  const active = await positionManager.getActivePositions();
  if (active.length === 0) return;

  log.debug('monitor', `Checking ${active.length} position(s)`);

  for (const position of active) {
    try {
      // ── Step 1: Hard stop loss check (no LLM) ────────────────────────────
      let currentPrice;
      try {
        const tokenData = await onchain.getTokenData(position.token_address);
        currentPrice = tokenData?.price_usd;
      } catch {
        log.warn('monitor', `Failed to get price for ${position.symbol}`);
        continue;
      }

      if (!currentPrice) continue;

      const pnlPct = calcPnl(position.entry_price_usd, currentPrice);

      // hard_stop_loss_pct convention: NEGATIVE (e.g., -35 means trigger at -35% loss).
      // config.position.hard_stop_loss_pct is the source of truth (set in config.json).
      // No negation here — the value should already be negative.
      const hardStopThreshold = position.hard_stop_loss_pct
        ?? config.position?.hard_stop_loss_pct
        ?? -20;
      if (pnlPct <= hardStopThreshold) {
        log.warn('monitor', `${position.symbol} hit hard stop: ${pnlPct.toFixed(2)}%`);
        await forceExit(position, 'hard_stop_loss', deps);
        continue;
      }

      // ── Step 2: Emergency triggers (no LLM) ─────────────────────────────
      let signals;
      try {
        signals = await onchain.getPositionSignals(position.token_address, position);
      } catch (err) {
        log.warn('monitor', `Failed to get signals for ${position.symbol}: ${err.message}`);
        continue;
      }

      const emergency = positionBrain.checkEmergencyTriggers(position, signals);
      if (emergency.triggered) {
        log.warn('monitor', `${position.symbol} emergency: ${emergency.reason}`);
        await forceExit(position, emergency.reason, deps);
        continue;
      }

      // ── Step 2.5: Time-based exit (stale position, no significant move) ───
      // Close positions that have been held > 2h with no significant movement
      // (pnl between -20% and +10%). Frees up slot, accumulates training data.
      const holdMinutes = (Date.now() - position.entry_time) / 60000;
      const tpThreshold = config.hard_rules?.take_profit_pct ?? 40;
      if (holdMinutes > 120 && pnlPct > -20 && pnlPct < 10) {
        log.warn('monitor', `${position.symbol} timeout (held ${holdMinutes.toFixed(0)}m, pnl ${pnlPct.toFixed(2)}%) — no significant move`);
        await forceExit(position, 'timeout_no_movement', deps);
        continue;
      }

      // ── Step 2.6: Take profit check (+40% by default) ──────────────────────
      if (pnlPct >= tpThreshold) {
        log.warn('monitor', `${position.symbol} hit take profit: +${pnlPct.toFixed(2)}% (target: +${tpThreshold}%)`);
        await forceExit(position, 'take_profit', deps);
        continue;
      }

      // ── Step 3: LLM evaluate ────────────────────────────────────────────
      let holdDuration;
      try {
        holdDuration = Math.round((Date.now() - position.entry_time) / 60000);
      } catch {
        holdDuration = 0;
      }

      let action;
      activeLlmCalls++;
      try {
        action = await positionBrain.evaluatePosition(position, signals, holdDuration);
      } catch (err) {
        log.error('brain', `Monitor decision failed for ${position.symbol}: ${err.message}`);
        continue;
      } finally {
        activeLlmCalls--;
      }

      await applyPositionAction(position, action, deps);
    } catch (err) {
      log.error('monitor', `Error monitoring ${position.symbol}: ${err.message}`);
    }
  }
}

// ─── Helper: force exit ───────────────────────────────────────────────────────

async function forceExit(position, reason, deps) {
  const { wallet, executor, positionManager, circuitBreaker, log, isPaperMode } = deps;
  const config = deps.config;

  log.warn('exit', `Force exit ${position.symbol}: ${reason}`);

  try {
    // Get sub-wallet
    const subWallet = wallet.getSubWallet(position.sub_wallet_index);
    if (!subWallet) {
      log.error('exit', `Sub-wallet #${position.sub_wallet_index} not found`);
      return;
    }

    // Execute sell
    let result;
    result = await executor.sellToken(subWallet.keypair, position.token_address, 100, {
      useJito: config.wallet?.use_jito ?? false,
      useDevnet: config.wallet?.use_devnet ?? false,
      // Pass position info so paper mode can compute realistic PnL
      entryPriceUsd: position.entry_price_usd,
      amountSol: position.amount_sol,
      symbol: position.symbol,
    });

    // Calculate PnL
    // 2026-06-07: BUG 2 fix — previous formula `(exitPrice - entryPrice) * amount_sol` was dimensionally
    // wrong (USD-per-token × SOL). Use percentage-based: pnl_sol = pnl_pct/100 × amount_sol.
    // Also moved pnlPct calculation up since pnlSol now depends on it.
    const exitPriceUsd = result.exitPriceUsd || position.entry_price_usd;
    const pnlPct = calcPnl(position.entry_price_usd, exitPriceUsd);
    const pnlSol = (pnlPct / 100) * position.amount_sol;

    // Record loss in circuit breaker if negative
    if (pnlSol < 0) {
      circuitBreaker.recordLoss(Math.abs(pnlSol));
    }

    // Close position
    const closed = await positionManager.closePosition(position.token_address, {
      exit_price_usd: exitPriceUsd,
      pnl_sol: pnlSol,
      pnl_pct: pnlPct,
      exit_reason: reason,
    });

    // Sweep funds back to main wallet (skip in paper mode — no actual SOL)
    if (!isPaperMode) {
      try {
        await wallet.sweepSubWallet(position.sub_wallet_index);
      } catch (err) {
        log.warn('sweep', `Sweep failed for wallet #${position.sub_wallet_index}: ${err.message}`);
      }
    }

    // Record to ledger
    try {
      const { recordTrade } = await import('./memory/ledger.js');
      await recordTrade({
        token_address: position.token_address,
        symbol: position.symbol,
        entry_time: position.entry_time ?? Date.now(),  // 2026-06-07: was missing
        exit_time: Date.now(),  // 2026-06-07: was missing
        sub_wallet_index: position.sub_wallet_index,
        entry_price_usd: position.entry_price_usd,
        exit_price_usd: exitPriceUsd,
        amount_sol: position.amount_sol,
        pnl_sol: pnlSol,
        pnl_pct: pnlPct,
        exit_reason: reason,
        signal_tags: position.signal_tags || [],
        entry_reasoning: position.entry_reasoning || '',
        llm_confidence: position.llm_confidence || 0,
        hold_duration_minutes: closed.hold_duration_minutes || 0,
        source: isPaperMode ? 'paper' : 'live',
        feed_source: position.feed_source || null,
        entry_market_cap_usd: position.entry_market_cap_usd ?? null,  // 2026-06-07
      });

      // 2026-06-07: BUG 3 fix — update signal_stats table for accuracy tracking.
      // Was never called before, so signal_accuracy card always showed "No signal data".
      try {
        const { updateSignalStats } = await import('./memory/ledger.js');
        await updateSignalStats(
          position.signal_tags || [],
          pnlSol,
          pnlSol > 0
        );
      } catch (err) {
        log.warn('signal-stats', `Failed: ${err.message}`);
      }
    } catch (err) {
      log.warn('ledger', `Failed to record trade: ${err.message}`);
    }

    // Index to RAG
    if (deps.rag) {
      try {
        const { indexTrade, getTrajectory } = await import('./memory/rag.js');
        const { getTrajectory: getSnapTraj } = await import('./analysis/onchain-snapshot.js');
        let trajectory = [];
        try {
          trajectory = await getSnapTraj(position.id);
        } catch {}

        const { indexTrade: ragIndex } = await import('./memory/rag.js');
        await ragIndex(
          {
            trade_id: position.id,
            symbol: position.symbol,
            entry_reasoning: position.entry_reasoning || '',
            llm_confidence: position.llm_confidence || 0,
            signal_tags: position.signal_tags || [],
            entry_time: position.entry_time,
            hold_duration_minutes: closed.hold_duration_minutes || 0,
            exit_reason: reason,
            pnl_pct: pnlPct,
            pnl_sol: pnlSol,
            source: isPaperMode ? 'paper' : 'live',
            feed_source: position.feed_source || null,
          },
          trajectory
        );
      } catch (err) {
        log.warn('rag', `RAG index failed: ${err.message}`);
      }
    }

    log.info('exit', `${position.symbol} exited: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) — ${reason}`);
  } catch (err) {
    log.error('exit', `Force exit failed for ${position.symbol}: ${err.message}`);
  }
}

// ─── Helper: apply position action ────────────────────────────────────────────

async function applyPositionAction(position, action, deps) {
  if (!action || !action.action) return;

  const { positionManager, circuitBreaker, log } = deps;

  switch (action.action) {
    case 'HOLD':
      // Update TPSL if provided
      if (action.new_sl_pct !== undefined || action.new_tp_pct !== undefined) {
        try {
          const newSl = action.new_sl_pct ?? position.stop_loss_pct;
          const newTp = action.new_tp_pct ?? position.take_profit_pct;
          await positionManager.updatePositionTPSL(position.token_address, newSl, newTp);
          log.info('action', `${position.symbol}: HOLD — SL updated to ${newSl}%${newTp ? `, TP ${newTp}%` : ''}`);
        } catch (err) {
          log.warn('action', `TPSL update failed: ${err.message}`);
        }
      } else {
        log.debug('action', `${position.symbol}: HOLD — no changes`);
      }
      break;

    case 'EXIT_FULL':
      await forceExit(position, 'llm_exit_full', deps);
      break;

    case 'EXIT_PARTIAL': {
      const exitPct = Math.min(Math.max(action.exit_pct ?? 50, 10), 90);
      log.info('action', `${position.symbol}: EXIT_PARTIAL ${exitPct}%`);
      // Partial sell not fully implemented — treat as full exit for safety
      await forceExit(position, 'llm_exit_partial', deps);
      break;
    }

    case 'EMERGENCY_EXIT':
      log.warn('action', `${position.symbol}: EMERGENCY_EXIT triggered by LLM`);
      await forceExit(position, 'llm_emergency', deps);
      break;

    default:
      log.warn('action', `${position.symbol}: Unknown action ${action.action}`);
  }
}

// ─── Helper: calculate PnL % ───────────────────────────────────────────────────

function calcPnl(entryPriceUsd, currentPriceUsd) {
  if (!entryPriceUsd || !currentPriceUsd) return 0;
  return ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});