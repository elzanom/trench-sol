/**
 * Brain/Prompts: Position Monitor Prompt
 *
 * System prompt for the position monitoring LLM call.
 * Returns { system: string, messages: array }
 *
 * Called every monitor_interval_ms for each active position.
 * Format follows spec section 9.2 and 12.2.
 */

export function buildMonitorPrompt(position, signals = {}, holdDurationMinutes = 0) {
  // ─── Build position context ────────────────────────────────────────────────
  const pnlStr = (position.current_pnl_pct || 0) >= 0
    ? `+${(position.current_pnl_pct || 0).toFixed(2)}%`
    : `${(position.current_pnl_pct || 0).toFixed(2)}%`;

  const positionLines = [
    `Token: ${position.symbol || position.token_address || 'UNKNOWN'}`,
    `Address: ${position.token_address || 'N/A'}`,
    `Entry Price: $${Number(position.entry_price_usd || 0).toFixed(6)}`,
    `Current Price: $${Number(position.current_price_usd || 0).toFixed(6)}`,
    `Current PnL: ${pnlStr}`,
    `Hold Duration: ${holdDurationMinutes} minutes`,
    position.current_tp_pct ? `Current TP: ${position.current_tp_pct}%` : null,
    position.current_sl_pct ? `Current SL: ${position.current_sl_pct}%` : null,
    `Hard Stop Loss: ${position.hard_stop_loss_pct || -20}% (IMMUTABLE — informational only, cannot be changed by you)`,
    position.entry_reasoning ? `Entry Reasoning: ${position.entry_reasoning}` : null,
    position.notes ? `Entry Notes: ${position.notes}` : null,
  ].filter(Boolean);

  // ─── Build signals context ──────────────────────────────────────────────────
  let signalsBlock = '';
  if (signals && Object.keys(signals).length > 0) {
    const sigParts = [];
    if (signals.price_change_pct_since_entry !== undefined) {
      const sign = signals.price_change_pct_since_entry >= 0 ? '+' : '';
      sigParts.push(`price: ${sign}${signals.price_change_pct_since_entry.toFixed(2)}%`);
    }
    if (signals.holder_count_delta !== undefined) {
      const sign = signals.holder_count_delta >= 0 ? '+' : '';
      sigParts.push(`holders: ${sign}${signals.holder_count_delta}`);
    }
    if (signals.liquidity_delta_pct !== undefined) {
      const sign = signals.liquidity_delta_pct >= 0 ? '+' : '';
      sigParts.push(`liquidity: ${sign}${signals.liquidity_delta_pct.toFixed(1)}%`);
    }
    if (signals.dev_wallet_activity) {
      sigParts.push(`dev wallet: ${signals.dev_wallet_activity}`);
    }
    if (signals.large_wallet_movement !== undefined) {
      sigParts.push(`large wallet movement: ${signals.large_wallet_movement ? 'YES' : 'no'}`);
    }
    if (signals.buy_sell_ratio_current !== undefined) {
      const ratioStr = signals.buy_sell_ratio_current > 1 ? 'buy dominant' : signals.buy_sell_ratio_current < 0.5 ? 'sell dominant' : 'balanced';
      sigParts.push(`buy/sell: ${signals.buy_sell_ratio_current.toFixed(2)} (${ratioStr})`);
    }
    if (sigParts.length > 0) {
      signalsBlock = `\nLive Signals (since entry):\n  ${sigParts.join('\n  ')}`;
    }
  }

  // ─── System prompt ──────────────────────────────────────────────────────────
  const systemPrompt = `You are TrenchAgent's Position Monitor — a capital preservation specialist.

Your role is to protect gains and limit losses. You are called every few minutes for each active position.

CRITICAL CONSTRAINTS:
1. hard_stop_loss_pct is a HARD IMMUTABLE FLOOR. The position WILL be force-sold if price hits it. You can suggest adjustments that move SL CLOSER to market (higher %), but NEVER further away (lower %). Example: if hard_stop_loss_pct = -20%, you can suggest -22% (tighter), but not -18% (looser).
2. Take profit (TP) can be adjusted freely.
3. Emergency triggers are handled by the system — you don't need to handle them.
4. You should consider hold duration — deadcoins that stagnate for too long waste capital.

Your available actions:
- HOLD: Maintain position. You can adjust TP/SL within allowed bounds.
- EXIT_FULL: Sell 100% of position at market.
- EXIT_PARTIAL: Sell 25%, 50%, or 75% of position. Reduces exposure, keeps rest running.
- EMERGENCY_EXIT: Urgently exit. Use when something is clearly wrong (dev rugged, massive dump, etc.)

Your output MUST be a valid JSON object with EXACTLY these fields:

{
  "action": "HOLD" | "EXIT_FULL" | "EXIT_PARTIAL" | "EMERGENCY_EXIT",
  
  // REQUIRED for HOLD — can adjust TP/SL
  "adjustments": {
    "new_tp_pct": number | null,   // New take-profit % from current price (null = no change)
    "new_sl_pct": number | null    // New stop-loss % (MUST be >= hard_stop_loss_pct, null = no change)
  },
  
  // REQUIRED for EXIT_PARTIAL
  "exit_pct": 25 | 50 | 75,        // How much to sell (percentage of remaining position)
  
  "reasoning": "string (1-3 sentences)"
}

HOLD examples:
  {"action": "HOLD", "adjustments": {"new_tp_pct": 40, "new_sl_pct": -10}, "exit_pct": null, "reasoning": "Strong momentum continuing, raising TP to 40%"}
  
EXIT_FULL examples:
  {"action": "EXIT_FULL", "adjustments": null, "exit_pct": null, "reasoning": "Dev wallet started selling — taking profits now"}
  
EXIT_PARTIAL examples:
  {"action": "EXIT_PARTIAL", "adjustments": {"new_tp_pct": 30, "new_sl_pct": -15}, "exit_pct": 50, "reasoning": "Securing partial gains, reducing exposure"}
  
EMERGENCY_EXIT examples:
  {"action": "EMERGENCY_EXIT", "adjustments": null, "exit_pct": null, "reasoning": "Rug detected — contract mint authority not revoked, exiting immediately"}

Consider hold duration. Positions that go nowhere for 60+ minutes are often better exited and capital redeployed elsewhere.`;

  // ─── Build user message ──────────────────────────────────────────────────────
  const userContent = `[ACTIVE POSITION]
${positionLines.join('\n')}
${signalsBlock}

Hold duration: ${holdDurationMinutes} minutes.

Output valid JSON only.`;

  return {
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };
}