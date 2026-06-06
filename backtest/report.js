import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Report generator ─────────────────────────────────────────────────────────

/**
 * Generate backtest report from results JSON.
 * Writes to config.backtest.output_path/report_[timestamp].md
 */
export async function generateReport(resultsPath) {
  let results;
  try {
    results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read results: ${err.message}`);
  }

  const { trades = [], balance = 0, wins = 0, losses = 0 } = results;
  const total = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';

  // Calculate stats
  const pnls = trades.map(t => t.pnl_sol || 0);
  const totalPnlSol = pnls.reduce((a, b) => a + b, 0);
  const avgPnlPct = trades.length > 0
    ? (trades.reduce((a, t) => a + (t.pnl_pct || 0), 0) / trades.length).toFixed(2)
    : '0.00';
  const bestTrade = trades.reduce((best, t) => (t.pnl_sol > (best?.pnl_sol || 0)) ? t : best, null);
  const worstTrade = trades.reduce((worst, t) => (t.pnl_sol < (worst?.pnl_sol || 0)) ? t : worst, null);

  // Signal accuracy
  const signalCounts = {};
  for (const trade of trades) {
    for (const tag of (trade.signal_tags || [])) {
      if (!signalCounts[tag]) signalCounts[tag] = { total: 0, wins: 0 };
      signalCounts[tag].total++;
      if ((trade.pnl_sol || 0) > 0) signalCounts[tag].wins++;
    }
  }

  const signalAccuracy = Object.entries(signalCounts).map(([tag, data]) => ({
    tag,
    total: data.total,
    wins: data.wins,
    winRate: ((data.wins / data.total) * 100).toFixed(1),
    avgPnl: (trades.filter(t => t.signal_tags?.includes(tag)).reduce((a, t) => a + (t.pnl_pct || 0), 0) / (data.total || 1)).toFixed(2),
  })).sort((a, b) => parseFloat(b.winRate) - parseFloat(a.winRate));

  // Build markdown report
  const config = loadConfig();
  const timestamp = new Date().toISOString();
  const outputDir = config.backtest?.output_path || path.join(__dirname, 'results');
  const outputFile = path.join(outputDir, `report_${timestamp.split('T')[0]}_${Date.now()}.md`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const lines = [
    `# Backtest Report — ${timestamp.split('T')[0]}`,
    '',
    '## Summary',
    '',
    `| Metric | Value |`,
    `|---|---|`,
    `| Lookback | ${config.backtest?.lookback_days || 7} days |`,
    `| Starting Balance | ${config.backtest?.starting_balance_sol || 10} SOL |`,
    `| Ending Balance | ${balance.toFixed(4)} SOL |`,
    `| Total Trades | ${trades.length} |`,
    `| Win Rate | ${winRate}% |`,
    `| Total P&L | ${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL |`,
    `| Avg PnL % | ${avgPnlPct}% |`,
    '',
    '## Performance',
    '',
    `| Metric | Value |`,
    `|---|---|`,
    `| Best Trade | ${bestTrade ? `${bestTrade.symbol} — ${bestTrade.pnl_sol >= 0 ? '+' : ''}${bestTrade.pnl_sol.toFixed(4)} SOL (${bestTrade.pnl_pct}%)` : 'N/A'} |`,
    `| Worst Trade | ${worstTrade ? `${worstTrade.symbol} — ${worstTrade.pnl_sol >= 0 ? '+' : ''}${worstTrade.pnl_sol.toFixed(4)} SOL (${worstTrade.pnl_pct}%)` : 'N/A'} |`,
    '',
    '## Signal Accuracy',
    '',
    `| Signal | Trades | Wins | Win Rate | Avg PnL% |`,
    `|---|---|---|---|---|`,
    ...signalAccuracy.map(s => `| ${s.tag} | ${s.total} | ${s.wins} | ${s.winRate}% | ${s.avgPnl}% |`),
    '',
    '## Trade Log',
    '',
    `| # | Symbol | Entry | Exit | Amount | P&L SOL | P&L% | Exit Reason | LLM Conf |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...trades.map((t, i) => `| ${i + 1} | ${t.symbol} | $${t.entry_price_usd?.toFixed(6)} | $${t.exit_price_usd?.toFixed(6)} | ${t.amount_sol} SOL | ${(t.pnl_sol >= 0 ? '+' : '') + t.pnl_sol.toFixed(4)} | ${(t.pnl_pct >= 0 ? '+' : '') + t.pnl_pct.toFixed(2)}% | ${t.exit_reason} | ${(t.llm_confidence || 0).toFixed(2)} |`),
    '',
    `*Generated: ${timestamp}*`,
  ];

  const reportContent = lines.join('\n');
  fs.writeFileSync(outputFile, reportContent);
  console.log(`[report] Written to ${outputFile}`);

  return outputFile;
}

// ─── Run if called directly ──────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('report.js');
if (isMain) {
  const resultsPath = process.argv[2];
  if (!resultsPath) {
    console.error('Usage: node backtest/report.js <results.json>');
    process.exit(1);
  }
  generateReport(resultsPath).catch(err => {
    console.error(`[report] Fatal: ${err.message}`);
    process.exit(1);
  });
}