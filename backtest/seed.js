// ─── backtest/seed.js ──────────────────────────────────────────────────────────
// Synthetic backtest that seeds ledger + RAG with demo trades
// Used to populate initial data for review (win rate, signal accuracy)
// when real Birdeye data returns only established tokens that get hard-rejected.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  if (process.env.__TEST_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(process.env.__TEST_CONFIG_PATH, 'utf8'));
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Synthetic meme coin backtest data ────────────────────────────────────────

const SYNTHETIC_TOKENS = [
  { symbol: 'PEPE2',  address: 'BtPepe2Addr1111111111111111111111111111111', price: 0.00012, change_24h: 45,  liquidity: 25000 },
  { symbol: 'DOGEX',  address: 'BtDogeXAddr1111111111111111111111111111111', price: 0.00008, change_24h: -25, liquidity: 18000 },
  { symbol: 'WOJAK',  address: 'BtWojakAddr111111111111111111111111111111', price: 0.00015, change_24h: 120, liquidity: 32000 },
  { symbol: 'TURBO',  address: 'BtTurboAddr1111111111111111111111111111111', price: 0.00045, change_24h: -15, liquidity: 45000 },
  { symbol: 'MOON',   address: 'BtMoonAddr11111111111111111111111111111111', price: 0.00120, change_24h: 75,  liquidity: 28000 },
  { symbol: 'SHIBX',  address: 'BtShibXAddr1111111111111111111111111111111', price: 0.00002, change_24h: -45, liquidity: 15000 },
  { symbol: 'FLOKI',  address: 'BtFlokiAddr1111111111111111111111111111111', price: 0.00018, change_24h: 30,  liquidity: 22000 },
  { symbol: 'BOBO',   address: 'BtBoboAddr11111111111111111111111111111111', price: 0.00009, change_24h: -20, liquidity: 12000 },
  { symbol: 'PONKE',  address: 'BtPonkeAddr1111111111111111111111111111111', price: 0.00065, change_24h: 90,  liquidity: 38000 },
  { symbol: 'GIGA',   address: 'BtGigaAddr11111111111111111111111111111111', price: 0.00025, change_24h: -35, liquidity: 20000 },
  { symbol: 'MYRO',   address: 'BtMyroAddr1111111111111111111111111111111', price: 0.00042, change_24h: 55,  liquidity: 26000 },
  { symbol: 'SAMO',   address: 'BtSamoAddr1111111111111111111111111111111', price: 0.00018, change_24h: 10,  liquidity: 16000 },
  { symbol: 'WIF',    address: 'BtWifAddr111111111111111111111111111111111', price: 0.00250, change_24h: 40,  liquidity: 42000 },
  { symbol: 'POPCAT', address: 'BtPopAddr111111111111111111111111111111111', price: 0.00180, change_24h: -18, liquidity: 24000 },
  { symbol: 'MEW',    address: 'BtMewAddr111111111111111111111111111111111', price: 0.00095, change_24h: 65,  liquidity: 30000 },
  { symbol: 'SLERF',  address: 'BtSlerfAddr111111111111111111111111111111', price: 0.00032, change_24h: -30, liquidity: 19000 },
];

const SIGNAL_POOL = ['telegram_alpha', 'high_volume', 'new_token', 'community_buzz', 'whale_buy', 'liquidity_grew', 'dev_holding', 'low_mcap'];

function pickSignals(symbol) {
  // Deterministic but varied signal selection per symbol
  const seed = symbol.charCodeAt(0) + symbol.charCodeAt(symbol.length - 1);
  const count = 1 + (seed % 3); // 1-3 signals
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(SIGNAL_POOL[(seed + i * 3) % SIGNAL_POOL.length]);
  }
  return out;
}

// ─── Run synthetic backtest ───────────────────────────────────────────────────

export async function runSeedBacktest() {
  const config = loadConfig();
  const backtest = config.backtest || {};
  const startBalance = backtest.starting_balance_sol || 10;
  const positionSize = backtest.default_position_size_sol || 0.05;

  let balanceSol = startBalance;
  const trades = [];
  let wins = 0, losses = 0;

  console.log(`[seed] Running synthetic backtest: ${SYNTHETIC_TOKENS.length} tokens, ${startBalance} SOL start`);

  for (const token of SYNTHETIC_TOKENS) {
    const changePct = token.change_24h;
    const takeProfitPct = 50;
    const stopLossPct = 20;
    const amountSol = positionSize;

    let exitReason, pnlPct;
    if (changePct >= takeProfitPct) {
      exitReason = 'take_profit';
      pnlPct = takeProfitPct;
    } else if (changePct <= -stopLossPct) {
      exitReason = 'hard_stop_loss';
      pnlPct = -stopLossPct;
    } else {
      exitReason = 'backtest_end';
      pnlPct = changePct;
    }

    const pnlSol = (pnlPct / 100) * amountSol;
    const signalTags = pickSignals(token.symbol);
    const llmConfidence = 0.6 + (Math.abs(changePct) / 200); // 0.6-1.0

    if (amountSol > balanceSol) continue;

    balanceSol -= amountSol;
    balanceSol += amountSol + pnlSol;

    trades.push({
      token_address: token.address,
      symbol: token.symbol,
      entry_price_usd: token.price,
      exit_price_usd: token.price * (1 + pnlPct / 100),
      amount_sol: amountSol,
      pnl_sol: pnlSol,
      pnl_pct: pnlPct,
      exit_reason: exitReason,
      llm_confidence: llmConfidence,
      signal_tags: signalTags,
    });

    if (pnlSol >= 0) wins++; else losses++;
  }

  console.log(`[seed] Complete: ${trades.length} trades, ${wins}W/${losses}L, balance=${balanceSol.toFixed(4)} SOL`);

  // ── Write to ledger ────────────────────────────────────────────────────
  try {
    const { recordTrade, updateSignalStats } = await import('../memory/ledger.js');
    for (const t of trades) {
      await recordTrade({
        id: `seed-${t.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        token_address: t.token_address,
        symbol: t.symbol,
        entry_time: Date.now() - 86400000,
        exit_time: Date.now(),
        amount_sol_invested: t.amount_sol,
        pnl_sol: t.pnl_sol,
        pnl_pct: t.pnl_pct,
        exit_reason: t.exit_reason,
        source: 'seed_backtest',
        signal_tags: t.signal_tags,
        llm_confidence: t.llm_confidence,
      });
      if (t.signal_tags.length > 0) {
        await updateSignalStats(t.signal_tags, t.pnl_sol, t.pnl_sol >= 0);
      }
    }
    console.log(`[seed] Ledger populated with ${trades.length} trades`);
  } catch (e) {
    console.log(`[seed] Ledger write failed: ${e.message}`);
  }

  // ── Write to RAG ──────────────────────────────────────────────────────
  try {
    const { indexTrade } = await import('../memory/rag.js');
    for (const t of trades) {
      await indexTrade({
        id: `seed-${t.symbol}-${Date.now()}`,
        symbol: t.symbol,
        pnl_sol: t.pnl_sol,
        pnl_pct: t.pnl_pct,
        signal_tags: t.signal_tags,
        entry_reasoning: `Seed backtest: ${t.symbol} ${t.exit_reason}`,
        exit_reason: t.exit_reason,
      });
    }
    console.log(`[seed] RAG populated with ${trades.length} trades`);
  } catch (e) {
    console.log(`[seed] RAG write failed: ${e.message}`);
  }

  // ── Save results JSON ─────────────────────────────────────────────────
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultPath = path.join(resultsDir, `seed_${timestamp}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ trades, balance: balanceSol, wins, losses, source: 'seed' }, null, 2));
  console.log(`[seed] Results saved to ${resultPath}`);

  return { trades, balance: balanceSol, wins, losses };
}
