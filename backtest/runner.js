import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Mock position manager for backtest ──────────────────────────────────────

const backtestPositions = new Map();

const backtestPositionManager = {
  openPosition: async (data) => {
    const id = require('crypto').randomUUID();
    const position = { id, ...data, status: 'open', entry_time: Date.now() };
    backtestPositions.set(data.token_address, position);
    return position;
  },
  closePosition: async (tokenAddress, exitData) => {
    const pos = backtestPositions.get(tokenAddress);
    if (!pos) return null;
    pos.status = 'closed';
    pos.exit_time = Date.now();
    pos.exit_price_usd = exitData.exit_price_usd;
    pos.pnl_sol = exitData.pnl_sol;
    pos.pnl_pct = exitData.pnl_pct;
    pos.exit_reason = exitData.exit_reason;
    backtestPositions.delete(tokenAddress);
    return pos;
  },
  getActivePositions: () => Array.from(backtestPositions.values()).filter(p => p.status === 'open'),
  getPosition: (addr) => backtestPositions.get(addr) || null,
  clearAllPositions: () => backtestPositions.clear(),
  updatePositionTPSL: async (addr, sl, tp) => {
    const pos = backtestPositions.get(addr);
    if (pos) {
      pos.stop_loss_pct = sl;
      pos.take_profit_pct = tp;
    }
    return pos;
  },
};

// ─── Simulate entry/exit from OHLCV ────────────────────────────────────────────

/**
 * Simulate a BUY at a given candle (entry price = close of that candle).
 * Returns simulated entry result.
 */
function simulateEntry(tokenData, candle, amountSol) {
  const entryPriceUsd = candle.close;
  return {
    txHash: `BT_${Date.now()}_${tokenData.address?.slice(0, 8)}`,
    amountIn: amountSol,
    amountOut: amountSol / entryPriceUsd,
    priceImpactPct: 0.05,
    entryPriceUsd,
  };
}

/**
 * Simulate an EXIT at a given candle.
 * Returns simulated exit result.
 */
function simulateExit(position, candle, exitPct = 100) {
  const exitPriceUsd = candle.close;
  const pnlPct = ((exitPriceUsd - position.entry_price_usd) / position.entry_price_usd) * 100;
  const pnlSol = (pnlPct / 100) * position.amount_sol;
  return {
    txHash: `BT_EXIT_${Date.now()}`,
    amountIn: position.amount_sol,
    amountOut: position.amount_sol * (exitPct / 100),
    solReceived: position.amount_sol * (exitPct / 100),
    exitPriceUsd,
    pnl_sol: pnlSol,
    pnl_pct: pnlPct,
  };
}

// ─── Backtest main ─────────────────────────────────────────────────────────────

/**
 * Run backtest over tokens from data-fetcher.
 * Uses same pipeline as live (hard rules + LLM decision + position tracking)
 * but simulates execution from historical OHLCV data.
 */
export async function runBacktest() {
  const config = loadConfig();
  const backtestConfig = config.backtest || {};

  console.log('[backtest] Starting backtest...');
  console.log(`[backtest]   lookback: ${backtestConfig.lookback_days || 7} days`);
  console.log(`[backtest]   min_liquidity: $${backtestConfig.min_liquidity_usd || 5000}`);
  console.log(`[backtest]   starting_balance: ${backtestConfig.starting_balance_sol || 10} SOL`);

  // Fetch tokens
  const { fetchBacktestTokens } = await import('./data-fetcher.js');
  const tokens = await fetchBacktestTokens();
  console.log(`[backtest] Fetched ${tokens.length} tokens`);

  if (tokens.length === 0) {
    console.warn('[backtest] No tokens found — check API keys or filters');
    return;
  }

  // Load brain and hard-rules
  const { makeEntryDecision } = await import('../brain/decision.js');
  const { runAllChecks } = await import('../core/hard-rules.js');

  // Backtest state
  let balanceSol = backtestConfig.starting_balance_sol || 10;
  const trades = [];
  const wins = 0, losses = 0;

  backtestPositionManager.clearAllPositions();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const tokenNum = i + 1;
    process.stdout.write(`\r[backtest] Token ${tokenNum}/${tokens.length}: ${token.symbol}...`);

    // Build synthetic context
    const tokenData = {
      address: token.address,
      symbol: token.symbol,
      price_usd: token.price || 0,
      liquidity_usd: token.liquidity || 0,
      holder_count: token.holders || 0,
      age_days: token.age_days || 0,
      volume_24h_usd: token.volume_24h || 0,
      raydium_pool: null,
      mtx_holders: null,
      dev_token_balance_pct: 0,
      is_mintable: false,
      bundled: false,
      bundle_detected: false,
      dev_wallet: null,
    };

    const context = {
      activePositions: backtestPositionManager.getActivePositions(),
      consecutiveLosses: 0,
      totalExposureSol: 0,
      dailyStats: { trade_count_today: 0, loss_sol_today: 0, is_tripped: false },
    };

    // Hard rules check
    try {
      const check = await runAllChecks(tokenData, context);
      if (!check.passed) {
        continue;
      }
    } catch {
      continue;
    }

    // LLM decision
    let decision;
    try {
      decision = await makeEntryDecision(tokenData, context, {
        similarTrades: [],
        ledgerStats: { total_trades: 0, win_rate: 0, avg_pnl_pct: 0 },
        marketContext: { feeds: 'backtest', sourceConfidence: 1.0 },
      });
    } catch {
      continue;
    }

    if (decision.decision !== 'BUY') {
      continue;
    }

    // Simulate entry on the first candle we have
    const multiplier = decision.position_size_multiplier || 1.0;
    const amountSol = (backtestConfig.default_position_size_sol || 0.5) * multiplier;

    if (amountSol > balanceSol) {
      continue; // not enough balance
    }

    // Use current price as "entry" candle
    const entryCandle = { close: token.price || 0 };
    const entryResult = simulateEntry(tokenData, entryCandle, amountSol);

    balanceSol -= amountSol;

    // Open position
    const position = await backtestPositionManager.openPosition({
      token_address: token.address,
      symbol: token.symbol,
      sub_wallet_index: 0,
      entry_price_usd: entryResult.entryPriceUsd,
      amount_sol: amountSol,
      hard_stop_loss_pct: config.position?.hard_stop_loss_pct || 20,
      take_profit_pct: decision.entry_params?.take_profit_pct || null,
      source: 'backtest',
      entry_reasoning: decision.reasoning || '',
      llm_confidence: decision.confidence || 0,
      signal_tags: decision.signal_tags || [],
    });

    // Simulate holding for lookback period then exit
    // For simplicity: if price went up > 20% at any point = win, else = loss
    const priceChangePct = token.price_change_24h || 0;

    let exitReason = 'backtest_end';
    let exitPnlPct = priceChangePct;
    let pnlSol = (exitPnlPct / 100) * amountSol;

    if (exitPnlPct >= (decision.entry_params?.take_profit_pct || 50)) {
      exitReason = 'take_profit';
    } else if (exitPnlPct <= -(config.position?.hard_stop_loss_pct || 20)) {
      exitReason = 'hard_stop_loss';
    }

    const exitCandle = { close: token.price * (1 + exitPnlPct / 100) };
    const exitResult = simulateExit(position, exitCandle, 100);

    balanceSol += amountSol + exitResult.pnl_sol;

    await backtestPositionManager.closePosition(token.address, {
      exit_price_usd: exitResult.exitPriceUsd,
      pnl_sol: exitResult.pnl_sol,
      pnl_pct: exitResult.pnl_pct,
      exit_reason: exitReason,
    });

    trades.push({
      symbol: token.symbol,
      entry_price_usd: entryResult.entryPriceUsd,
      exit_price_usd: exitResult.exitPriceUsd,
      amount_sol: amountSol,
      pnl_sol: exitResult.pnl_sol,
      pnl_pct: exitResult.pnl_pct,
      exit_reason: exitReason,
      llm_confidence: decision.confidence || 0,
      signal_tags: decision.signal_tags || [],
    });

    if (exitResult.pnl_sol >= 0) wins++;
    else losses++;
  }

  console.log(`\n[backtest] Complete — ${trades.length} trades, ${wins}W/${losses}L`);

  // Save results
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  // ── Populate ledger & RAG with backtest trades ──────────────────────────
  if (trades.length > 0) {
    try {
      const { recordTrade, updateSignalStats } = await import('../memory/ledger.js');
      for (const t of trades) {
        await recordTrade({
          id: `backtest-${t.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          token_address: t.token_address || `bt-${t.symbol}`,
          symbol: t.symbol,
          entry_time: Date.now() - 86400000,
          exit_time: Date.now(),
          amount_sol_invested: t.amount_sol,
          pnl_sol: t.pnl_sol,
          pnl_pct: t.pnl_pct,
          exit_reason: t.exit_reason,
          source: 'backtest',
          signal_tags: t.signal_tags || [],
          llm_confidence: t.llm_confidence || 0,
        });

        // Update signal stats
        if (t.signal_tags && t.signal_tags.length > 0) {
          await updateSignalStats(t.signal_tags, t.pnl_sol, t.pnl_sol >= 0);
        }
      }
      console.log(`[backtest] Populated ledger with ${trades.length} trades`);
    } catch (e) {
      console.log(`[backtest] Ledger write failed: ${e.message}`);
    }

    try {
      const { indexTrade } = await import('../memory/rag.js');
      for (const t of trades) {
        await indexTrade({
          id: `backtest-${t.symbol}-${Date.now()}`,
          symbol: t.symbol,
          pnl_sol: t.pnl_sol,
          pnl_pct: t.pnl_pct,
          signal_tags: t.signal_tags || [],
          entry_reasoning: t.entry_reasoning || `Backtest: ${t.exit_reason}`,
          exit_reason: t.exit_reason,
        });
      }
      console.log(`[backtest] Populated RAG with ${trades.length} trades`);
    } catch (e) {
      console.log(`[backtest] RAG write failed: ${e.message}`);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultPath = path.join(resultsDir, `backtest_${timestamp}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ trades, balance: balanceSol, wins, losses }, null, 2));
  console.log(`[backtest] Results saved to ${resultPath}`);

  return { trades, balance: balanceSol, wins, losses };
}

// ─── Run if called directly ──────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('runner.js');
if (isMain) {
  runBacktest().catch(err => {
    console.error(`[backtest] Fatal: ${err.message}`);
    process.exit(1);
  });
}