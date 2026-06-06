/**
 * Brain/Prompts: Entry Decision Prompt
 *
 * System prompt for the entry decision LLM call.
 * Returns { system: string, messages: array }
 *
 * Data is injected as user message content (not in system prompt).
 * Format follows spec section 9.1 and 12.1.
 *
 * GMGN-updated: includes smart_money_count, kol_count, bundle_pct, sniper_pct
 * signals for the LLM to weigh.
 */

export function buildEntryPrompt(tokenData, similarTrades = [], ledgerStats = {}, marketContext = {}) {
  // ─── Build similar trades context ──────────────────────────────────────
  let similarTradesBlock = '';
  if (similarTrades && similarTrades.length > 0) {
    const tradeLines = similarTrades.slice(0, 5).map(t => {
      const pnlStr = (t.pnl_pct || 0) >= 0 ? `+${(t.pnl_pct || 0).toFixed(1)}%` : `${(t.pnl_pct || 0).toFixed(1)}%`;
      const tags = (t.signal_tags || []).join(', ');
      return `  - [${t.symbol || 'UNKNOWN'}] ${pnlStr} (tags: ${tags || 'none'}, hold: ${t.hold_duration_minutes || 0}min, exit: ${t.exit_reason || 'N/A'})`;
    });
    similarTradesBlock = `\nSimilar historical trades (learn from these):\n${tradeLines.join('\n')}\n`;
  } else {
    similarTradesBlock = `\nNo similar trades found in memory — be extra selective.`;
  }

  // ─── Build ledger stats context ────────────────────────────────────────
  let ledgerBlock = '';
  if (ledgerStats && ledgerStats.total_trades > 0) {
    const winStr = (ledgerStats.win_rate_pct || 0).toFixed(1);
    const avgStr = (ledgerStats.avg_pnl_pct || 0).toFixed(1);
    const totalStr = (ledgerStats.total_pnl_sol || 0).toFixed(4);
    ledgerBlock = `\nYour ledger stats (last ${ledgerStats.total_trades} trades): ${ledgerStats.total_trades} trades, ${winStr}% win rate, avg PnL ${avgStr}%, total PnL ${totalStr} SOL.`;
  } else {
    ledgerBlock = `\nYour ledger is empty — first trade. Be extremely careful.`;
  }

  // ─── Build market context ───────────────────────────────────────────────
  let marketBlock = '';
  if (marketContext && Object.keys(marketContext).length > 0) {
    const btcPrice = marketContext.btc_price ? `BTC $${Number(marketContext.btc_price).toLocaleString()}` : '';
    const marketSentiment = marketContext.sentiment || 'unknown';
    marketBlock = `\nMarket context: ${btcPrice}${btcPrice ? ', ' : ''}sentiment: ${marketSentiment}.`;
  }

  // ─── Build GMGN-specific signal block ─────────────────────────────────
  // Smart money / KOL are the most important NEW signals.
  // Bundler/sniper % indicate launch manipulation.
  const gmgnSignals = [];
  if (tokenData.smart_money_count && tokenData.smart_money_count > 0) {
    gmgnSignals.push(`🧠 Smart money holders: ${tokenData.smart_money_count}`);
  }
  if (tokenData.kol_count && tokenData.kol_count > 0) {
    gmgnSignals.push(`⭐ KOL holders: ${tokenData.kol_count}`);
  }
  if (tokenData.bundler_pct && tokenData.bundler_pct > 0) {
    gmgnSignals.push(`⚠️ Bundler %: ${tokenData.bundler_pct.toFixed(1)}%${tokenData.bundler_pct > 20 ? ' (HIGH — possible coordinated launch)' : ''}`);
  }
  if (tokenData.sniper_pct && tokenData.sniper_pct > 0) {
    gmgnSignals.push(`🎯 Sniper %: ${tokenData.sniper_pct.toFixed(1)}%${tokenData.sniper_pct > 30 ? ' (HIGH — bot-dominated launch)' : ''}`);
  }
  if (tokenData.signal_type) {
    const signalType = tokenData.signal_type;
    const confidence = tokenData.source_confidence ? ` (confidence ${(tokenData.source_confidence * 100).toFixed(0)}%)` : '';
    gmgnSignals.push(`📡 Source: ${signalType}${confidence}`);
  }
  if (tokenData.is_honeypot) {
    gmgnSignals.push(`🚨 IS HONEYPOT — REJECT`);
  }
  if (tokenData.is_blacklist) {
    gmgnSignals.push(`🚨 BLACKLISTED — REJECT`);
  }
  if (tokenData.buy_tax > 5 || tokenData.sell_tax > 5) {
    gmgnSignals.push(`⚠️ High tax: buy ${tokenData.buy_tax}% / sell ${tokenData.sell_tax}%`);
  }
  if (tokenData.renounced_mint === false) {
    gmgnSignals.push(`⚠️ Mint authority NOT renounced — supply can be inflated`);
  }
  if (tokenData.renounced_freeze_account === false) {
    gmgnSignals.push(`⚠️ Freeze authority NOT renounced — wallets can be frozen`);
  }

  const gmgnBlock = gmgnSignals.length > 0
    ? `\n[GMGN SIGNALS]\n${gmgnSignals.join('\n')}\n`
    : '';

  // ─── System prompt ─────────────────────────────────────────────────────
  const systemPrompt = `You are TrenchAgent — an experienced, pragmatic Solana meme coin trader.

You are part of a learning system. Before making any decision, you MUST consider:
1. Similar historical trades from your memory (shown in user message)
2. Your ledger statistics (win rate, avg PnL, signal accuracy)
3. Market conditions
4. GMGN signals (smart money, KOL, bundler, sniper) — see user message

You operate with immutable hard rules that you CANNOT override:
- hard_stop_loss_pct is a HARD floor. You can suggest a stop loss that is CLOSER to market (higher %), but NEVER further away (lower %). Example: if hard_stop_loss_pct = -20%, you can suggest -25% (tighter), but not -15% (looser).
- Maximum position size is capped by your conviction tier — see below.
- You must reject tokens that fail any hard rule (liquidity, holders, rug score, etc.)

GMGN SIGNAL WEIGHTING (use these to inform your confidence):
- Smart money holders (smart_degen_count > 0) is a STRONG bullish signal. KOL holders (renowned_count > 0) is even STRONGER.
- Bundler % > 20% or sniper % > 30% are BEARISH signals indicating coordinated launch manipulation. Reduce confidence accordingly or SKIP.
- signal_type from gmgn feed: 'kol_new' is highest confidence (KOL already bought = proven thesis), 'near_graduation' is high (organic momentum), 'trending_5m' is medium, 'new_creation' is low (could rug).
- IS HONEYPOT, BLACKLIST, mint not renounced, or freeze not renounced → automatic SKIP regardless of other signals.

You MUST be SELECTIVE. Your job is to filter, not to find every opportunity.
Better to skip a questionable trade than to lose money on a bad one.
When in doubt, SKIP.

Your output MUST be a valid JSON object with EXACTLY these fields:

{
  "decision": "BUY" | "SKIP",
  "confidence": 0.0 - 1.0,
  "reasoning": "string (short explanation, 1-3 sentences max)",
  
  // REQUIRED ONLY if decision == "BUY"
  "entry_params": {
    "suggested_tp_pct": number,       // Take-profit % from entry price
    "suggested_sl_pct": number,       // Stop-loss % from entry price (MUST be >= hard_stop_loss_pct)
    "position_size_multiplier": 0.5 | 1.0 | 1.5 | 2.0,  // Relative to base position size
    "notes": "string"                  // Monitoring notes for position manager
  },
  
  // REQUIRED for both BUY and SKIP — max 3 tags
  "signal_tags": ["tag1", "tag2", "tag3"]  // Max 3, for ledger tracking
}

CONVICTION TIERS — determine max position size:
- confidence 0.90-1.0 → tier "high" → max_multiplier 2.0
- confidence 0.70-0.89 → tier "medium" → max_multiplier 1.0
- confidence 0.50-0.69 → tier "low" → max_multiplier 0.5
- confidence < 0.50 → SKIP regardless

If decision is SKIP, include a clear reason in "reasoning" field.
If decision is BUY, "entry_params" MUST be present and valid.

Reference the signal_tags from profitable similar trades when making your decision.
Example: if similar trades with "telegram_alpha" tag were profitable, weigh that signal higher.`;

  // ─── Build user message with token data ───────────────────────────────
  const tokenLines = [
    `Token: ${tokenData.symbol || tokenData.address || 'UNKNOWN'}`,
    `Address: ${tokenData.address || 'N/A'}`,
    tokenData.price_usd ? `Price: $${Number(tokenData.price_usd).toFixed(6)}` : null,
    tokenData.market_cap ? `Market Cap: $${Number(tokenData.market_cap).toLocaleString()}` : null,
    tokenData.liquidity_usd ? `Liquidity: $${Number(tokenData.liquidity_usd).toLocaleString()}` : null,
    tokenData.holder_count ? `Holders: ${Number(tokenData.holder_count).toLocaleString()}` : null,
    tokenData.volume_24h_usd ? `24h Volume: $${Number(tokenData.volume_24h_usd).toLocaleString()}` : null,
    tokenData.buy_sell_ratio ? `Buy/Sell Ratio: ${Number(tokenData.buy_sell_ratio).toFixed(2)}` : null,
    tokenData.token_age_minutes ? `Age: ${Math.round(tokenData.token_age_minutes)} minutes` : null,
    tokenData.is_mintable ? `⚠️ Mintable: YES` : null,
    tokenData.is_freezable ? `⚠️ Freezable: YES` : null,
    tokenData.lp_locked !== undefined ? `LP Locked: ${tokenData.lp_locked ? 'YES' : 'NO'}` : null,
  ].filter(Boolean);

  const userContent = `[CURRENT TOKEN]
${tokenLines.join('\n')}
${gmgnBlock}
[HARD STOP LOSS] This token's hard_stop_loss_pct is set to your config's hard_stop_loss_pct (immutable, non-negotiable).

${similarTradesBlock}
${ledgerBlock}
${marketBlock}

Based on the above, make your entry decision. Output valid JSON only.`;

  return {
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };
}
