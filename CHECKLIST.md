# Hardening Checklist — TrenchAgent

## 1. ERROR HANDLING AUDIT

| File | Issue | Status |
|------|-------|--------|
| `core/llm.js` | All async fns have try/catch; LLM calls have retry + backoff | ✅ FIXED |
| `core/hard-rules.js` | Axios calls wrapped in try/catch; rugcheck fails closed | ✅ FIXED |
| `core/rate-limiter.js` | All methods have try/catch; queue sleep wrapped | ✅ FIXED |
| `analysis/onchain.js` | `withRetry()` has fallback + 429 backoff; all API calls in try/catch | ✅ FIXED |
| `feeds/screener.js` | DexScreener + Birdeye in try/catch; handler errors caught | ✅ FIXED |
| `feeds/pumpfun.js` | WebSocket wrapped in try/catch; reconnect auto-scheduled | ✅ FIXED |
| `feeds/aggregator.js` | All feed start() wrapped in try/catch; handler errors caught | ✅ FIXED |
| `brain/decision.js` | LLM call in try/catch → SKIP; JSON parse errors caught | ✅ FIXED |
| `brain/position-manager.js` | LLM call in try/catch → HOLD; parse errors caught | ✅ FIXED |
| `execution/jupiter.js` | All swap calls in try/catch; slippage retry; Jito fallback | ✅ FIXED |
| `memory/ledger.js` | All DB ops in try/catch; SQLite errors propagate | ✅ FIXED |
| `index.js` | All init steps in try/catch; monitor loop continues on error | ✅ FIXED |
| `dashboard/server.js` | Express error handler registered; all routes have try/catch | ✅ FIXED |

**Timeouts:**
- Jupiter: 10s per request, 3 retries
- Birdeye: 8s timeout per request
- DexScreener: 8s timeout
- Pumpfun WS: 15s connect timeout
- All axios calls use explicit `timeout` + `AbortSignal`

**RPC Fallback (onchain.js):**
- Primary + fallback endpoints tried in sequence
- 429 → exponential backoff (2s, 4s, 8s)
- Non-429 error → try next endpoint

**Uncaught exception in main loop:**
- Monitor loop: errors caught per-position, loop continues
- Token handler: errors propagate to caller (caught at top level)
- `isShuttingDown` flag prevents new work during shutdown

---

## 2. LOGGING AUDIT

| Item | Status |
|------|--------|
| `core/logger.js` created | ✅ |
| Winston-compatible API (debug/info/warn/error/fatal + child()) | ✅ |
| Rotating file logs (max 10MB, keep 5 files) | ✅ |
| Console output for dev, file for prod | ✅ |
| Sensitive data redaction (api_key, private_key, password, token, etc.) | ✅ |
| `core/llm.js` → `log.warn/info/error` | ✅ FIXED |
| `core/hard-rules.js` → `log.error/warn` | ✅ FIXED |
| `core/rate-limiter.js` → `log.info/warn` | ✅ FIXED |
| `analysis/onchain.js` → `log.warn/error` | ✅ FIXED |
| `feeds/screener.js` → `log.info/warn/debug` | ✅ FIXED |
| `feeds/pumpfun.js` → `log.info/warn` | ✅ FIXED |
| `feeds/aggregator.js` → `log.info/warn/error` | ✅ FIXED |
| `brain/decision.js` → `log.info/warn/error` | ✅ FIXED |
| `brain/position-manager.js` → `log.info/warn/error` | ✅ FIXED |
| `execution/jupiter.js` → `log.info/warn` | ✅ FIXED |
| `index.js` → `log.info/warn/error` (replaced custom logger) | ✅ FIXED |

**Log format:** `[ISO timestamp] [LEVEL] [prefix] message [meta JSON]`
**Rotation:** Files named `YYYY-MM-DD.log`, rotated when >10MB, max 5 kept

---

## 3. RESILIENCE CHECKS

| Scenario | Implementation | Status |
|----------|---------------|--------|
| Feed disconnect | Pumpfun: auto-reconnect with exponential backoff (1s→30s cap) | ✅ |
| Feed disconnect | Screener: backoff after consecutive errors, resets on success | ✅ |
| LLM timeout | LLM: 10s default, 3 retries with backoff (1s, 2s, 4s) | ✅ |
| RPC error | `withRetry()` in onchain.js: fallback endpoints + 429 backoff | ✅ |
| DB lock | `better-sqlite3` is synchronous; all DB operations are atomic | ✅ |
| Uncaught exception in main loop | try/catch per-position in monitor loop; token handler errors caught | ✅ |
| Circuit breaker trip during loop | Monitor loop checks `dailyStats.is_tripped` before LLM call | ✅ |

---

## 4. HARD RULES FINAL AUDIT

| Check | Location | Status |
|-------|----------|--------|
| `hard_stop_loss_pct` always enforced | `decision.js` line ~270: `Math.min(suggestedSlPct, hardStopLoss)` | ✅ |
| `position_size_multiplier` capped | `decision.js` `calculatePositionMultiplier()`: min(tier_max, absolute_cap=3.0) | ✅ |
| Emergency triggers cannot be disabled | `position-manager.js` `checkEmergencyTriggers()`: hardcoded, no LLM override | ✅ |
| SL clamping in `updatePositionTPSL()` | `position-manager.js`: `newSlPct > hardStopLoss → clamped` | ✅ |
| No brain/ imports in execution/ | `jupiter.js`, `position.js` — verified no brain/ imports | ✅ |
| LLM cannot bypass hard rules | `decision.js` `runAllChecks()` always called before LLM | ✅ |
| Emergency triggers: no LLM override | `positionBrain.checkEmergencyTriggers()` always runs first in monitor | ✅ |

---

## 5. CONFIG VALIDATION

| Check | Implementation | Status |
|-------|---------------|--------|
| Required fields checked at startup | `validateConfig()` in `index.js`: 6 required fields | ✅ |
| Missing field → clear error + exit | `process.exit(1)` with message listing missing keys | ✅ |
| Number fields type-checked | 4 numeric fields validated: `max_concurrent_positions`, `hard_stop_loss_pct`, etc. | ✅ |
| Boolean fields type-checked | 3 boolean fields validated: `screener.enabled`, `paper_trading`, `use_devnet` | ✅ |
| Type error → clear message + exit | `process.exit(1)` with list of type errors | ✅ |

---

## 6. SECURITY CHECKS

| Check | Status |
|------|--------|
| Private key never logged | All `console.log/error/warn` replaced with structured logger; redaction patterns in logger | ✅ |
| API keys never logged | Logger has sensitive pattern redaction (api_key, secret, token, password, etc.) | ✅ |
| Dashboard `/api/config` redaction | `dashboard/server.js`: redacts all `*_key`, `*_secret`, `private_key`, `token` fields | ✅ |
| `index.js` no private key in logs | Logger bound to prefix, redaction active; no raw key printing | ✅ |
| Jito tip is configurable | `config.execution.jito_tip_lamports` (not hardcoded) | ✅ |

---

## FILE: `CHECKLIST.md`

All 6 hardening categories completed:

1. ✅ **ERROR HANDLING** — All async functions have try/catch; all external API calls have timeouts and fallbacks
2. ✅ **LOGGING** — `core/logger.js` implemented; all modules updated from `console.*` to `log.*`; rotating files + sensitive redaction
3. ✅ **RESILIENCE** — Feed reconnect, LLM retry/backoff, RPC fallback, DB atomic ops, uncaught exception guards
4. ✅ **HARD RULES AUDIT** — `hard_stop_loss_pct` enforced in 2 places; `position_size_multiplier` capped; emergency triggers immune to LLM
5. ✅ **CONFIG VALIDATION** — Required fields + type checking at startup with clear error messages
6. ✅ **SECURITY** — Private keys/API keys redacted; dashboard config endpoint sanitized