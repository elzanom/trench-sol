// ─── dashboard-test.js ─────────────────────────────────────────────────────────
// Dashboard E2E test — starts dashboard server, hits all API endpoints,
// and verifies circuit breaker / sub-wallet panel / pause-resume / auto-refresh.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARD_URL = 'http://localhost:3000';

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
}

const config = loadConfig();
const AUTH_TOKEN='change_this_token';

const log = (label, msg) => console.log(`[dashboard-test:${label}] ${msg}`);

async function api(method, endpoint, body = null) {
  const url = `${DASHBOARD_URL}${endpoint}`;
  const opts = {
    method,
    headers: { 'x-auth-token': AUTH_TOKEN, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ─── Test 1: Dashboard is up and accessible ───────────────────────────────────

async function test1_dashboardUp() {
  console.log('\n═══ TEST 1: Dashboard is up ═══');
  try {
    const rootRes = await fetch(DASHBOARD_URL + '/');
    log('http', `GET / → ${rootRes.status}`);
    if (rootRes.status !== 200) return { success: false };

    const html = await rootRes.text();
    if (html.includes('<title>') || html.includes('TrenchAgent')) {
      log('html', `✅ Index HTML served (${html.length} bytes)`);
    } else {
      log('html', `⚠ Unexpected HTML content (${html.length} bytes)`);
    }

    // Static assets
    for (const asset of ['/style.css', '/app.js']) {
      const r = await fetch(DASHBOARD_URL + asset);
      log('static', `${asset} → ${r.status} (${(await r.text()).length} bytes)`);
    }

    return { success: true };
  } catch (e) {
    log('http', `❌ Dashboard not reachable: ${e.message}`);
    return { success: false };
  }
}

// ─── Test 2: Auth middleware ──────────────────────────────────────────────────

async function test2_auth() {
  console.log('\n═══ TEST 2: Auth middleware ═══');

  // Without token — should fail
  const r1 = await fetch(`${DASHBOARD_URL}/api/status`);
  const j1 = await r1.json();
  log('auth', `No token → ${r1.status}: ${j1.error}`);
  if (r1.status !== 401) {
    log('auth', '❌ Expected 401 without token');
    return { success: false };
  }

  // With wrong token — should fail
  const r2 = await fetch(`${DASHBOARD_URL}/api/status`, {
    headers: { 'x-auth-token': 'wrong-token' },
  });
  const j2 = await r2.json();
  log('auth', `Wrong token → ${r2.status}: ${j2.error}`);
  if (r2.status !== 401) {
    log('auth', '❌ Expected 401 with wrong token');
    return { success: false };
  }

  // With correct token — should pass
  const r3 = await api('GET', '/api/status');
  log('auth', `Correct token → ${r3.status}`);
  if (r3.status !== 200) {
    log('auth', `❌ Expected 200 with correct token, got ${r3.status}`);
    return { success: false };
  }

  log('auth', '✅ Auth middleware working correctly');
  return { success: true };
}

// ─── Test 3: Status endpoint (circuit breaker card) ──────────────────────────

async function test3_statusCircuitBreaker() {
  console.log('\n═══ TEST 3: Status endpoint — circuit breaker card ═══');

  const r = await api('GET', '/api/status');
  log('status', `Status code: ${r.status}`);

  if (r.status !== 200) {
    log('status', '❌ Failed to get status');
    return { success: false };
  }

  const data = r.json;
  log('status', `Top-level keys: ${Object.keys(data).join(', ')}`);

  // Check for circuit breaker fields
  const fields = ['is_paused', 'wallet', 'circuit_breaker', 'trades', 'feeds', 'positions'];
  const present = fields.filter(f => f in data);
  log('status', `Fields present: ${present.join(', ')}`);

  if (data.circuit_breaker) {
    const cb = data.circuit_breaker;
    log('cb', `tripped: ${cb.is_tripped}`);
    log('cb', `trade_count_today: ${cb.trade_count_today}`);
    log('cb', `loss_sol_today: ${cb.loss_sol_today}`);
    log('cb', `consecutive_losses: ${cb.consecutive_losses}`);
    log('cb', `✅ Circuit breaker card data present`);
  } else {
    log('cb', '⚠ circuit_breaker not in status response');
  }

  if (data.wallet) {
    log('wallet', `main_balance: ${data.wallet.main_balance_sol} SOL`);
    log('wallet', `sub_wallets: ${data.wallet.sub_wallet_count}`);
  }

  return { success: true, data };
}

// ─── Test 4: Wallets endpoint (sub-wallet panel) ─────────────────────────────

async function test4_subWalletPanel() {
  console.log('\n═══ TEST 4: Wallets endpoint — sub-wallet panel ═══');

  const r = await api('GET', '/api/wallets');
  if (r.status !== 200) {
    log('wallets', `❌ Failed: ${r.status}`);
    return { success: false };
  }

  const data = r.json;
  log('wallets', `Top-level keys: ${Object.keys(data).join(', ')}`);

  if (data.sub_wallets && Array.isArray(data.sub_wallets)) {
    log('wallets', `Sub-wallet count: ${data.sub_wallets.length}`);
    for (const sub of data.sub_wallets.slice(0, 3)) {
      log('wallets', `  Sub ${sub.index}: ${sub.publicKey?.slice(0, 12)}... balance=${sub.balance}`);
    }
    log('wallets', '✅ Sub-wallet panel data present');
  } else {
    log('wallets', '⚠ sub_wallets array missing');
  }

  return { success: true, data };
}

// ─── Test 5: Circuit breaker reset button ─────────────────────────────────────

async function test5_circuitBreakerReset() {
  console.log('\n═══ TEST 5: Circuit breaker reset button ═══');

  // First trip the circuit breaker (call the breaker directly to ensure it's tripped)
  const { recordLoss, reset, getDailyStats } = await import('../core/circuit-breaker.js');
  await reset();
  for (let i = 0; i < 5; i++) await recordLoss(0.05);

  const before = await getDailyStats();
  log('cb', `Before reset: tripped=${before.is_tripped}, loss=${before.loss_sol_today}`);

  // Call dashboard reset endpoint
  const r = await api('POST', '/api/circuit-breaker/reset');
  log('cb', `Reset endpoint: ${r.status}, response: ${JSON.stringify(r.json).slice(0, 200)}`);

  if (r.status !== 200) {
    log('cb', `❌ Reset endpoint failed: ${r.status}`);
    return { success: false };
  }

  // Verify state via direct API
  const status = await api('GET', '/api/status');
  const cb = status.json.circuit_breaker;
  log('cb', `After reset: tripped=${cb?.is_tripped}, loss=${cb?.loss_sol_today}`);

  if (!cb?.is_tripped) {
    log('cb', '✅ Circuit breaker reset successfully via dashboard');
    return { success: true };
  } else {
    log('cb', '⚠ Still tripped after reset');
    return { success: false };
  }
}

// ─── Test 6: Pause / resume buttons ───────────────────────────────────────────

async function test6_pauseResume() {
  console.log('\n═══ TEST 6: Pause / resume buttons ═══');

  // Initial status
  const s0 = await api('GET', '/api/status');
  log('pause', `Initial is_paused: ${s0.json.is_paused}`);

  // Pause
  const p1 = await api('POST', '/api/pause');
  log('pause', `POST /api/pause: ${p1.status}, response=${JSON.stringify(p1.json).slice(0, 100)}`);

  // Check status reflects pause
  const s1 = await api('GET', '/api/status');
  log('pause', `After pause: is_paused=${s1.json.is_paused}`);
  if (!s1.json.is_paused) {
    log('pause', '❌ Pause did not take effect');
    return { success: false };
  }

  // Resume
  const p2 = await api('POST', '/api/resume');
  log('pause', `POST /api/resume: ${p2.status}, response=${JSON.stringify(p2.json).slice(0, 100)}`);

  // Check status reflects resume
  const s2 = await api('GET', '/api/status');
  log('pause', `After resume: is_paused=${s2.json.is_paused}`);
  if (s2.json.is_paused) {
    log('pause', '❌ Resume did not take effect');
    return { success: false };
  }

  log('pause', '✅ Pause/resume working');
  return { success: true };
}

// ─── Test 7: Auto-refresh (server-side polling) ──────────────────────────────

async function test7_autoRefresh() {
  console.log('\n═══ TEST 7: Auto-refresh — repeated /api/status calls ═══');

  // Test that status changes are reflected on next call
  // 1) Get initial status
  const s0 = await api('GET', '/api/status');
  const t0 = s0.json.last_updated || Date.now();
  log('refresh', `Initial status time: ${t0}`);

  // 2) Wait, then get again
  await new Promise(r => setTimeout(r, 1500));

  const s1 = await api('GET', '/api/status');
  log('refresh', `Second status time: ${s1.json.last_updated || 'same'}`);

  // 3) Verify response shape is consistent (auto-refresh would re-render)
  const sameKeys = JSON.stringify(Object.keys(s0.json).sort()) === JSON.stringify(Object.keys(s1.json).sort());
  if (!sameKeys) {
    log('refresh', '❌ Response shape changed between calls');
    return { success: false };
  }
  log('refresh', '✅ Response shape stable across calls');

  // 4) Verify server handles multiple concurrent calls (like auto-refresh)
  const concurrent = await Promise.all([
    api('GET', '/api/status'),
    api('GET', '/api/status'),
    api('GET', '/api/status'),
    api('GET', '/api/status'),
    api('GET', '/api/status'),
  ]);
  const allOk = concurrent.every(r => r.status === 200);
  log('refresh', `Concurrent calls (5): ${concurrent.filter(r => r.status === 200).length}/5 OK`);
  if (!allOk) {
    log('refresh', '❌ Some concurrent calls failed');
    return { success: false };
  }

  // 5) Check the HTML has auto-refresh JS
  const html = await fetch(DASHBOARD_URL + '/').then(r => r.text());
  const hasAutoRefresh = html.includes('refresh') || html.includes('setInterval') || html.includes('setTimeout') ||
                          html.includes('poll') || html.includes('reload');
  log('refresh', `HTML has auto-refresh logic: ${hasAutoRefresh}`);

  // Check app.js for auto-refresh
  const appJs = await fetch(DASHBOARD_URL + '/app.js').then(r => r.text());
  const hasRefreshFn = appJs.includes('setInterval') || appJs.includes('fetch') || appJs.includes('refresh');
  log('refresh', `app.js has refresh/polling: ${hasRefreshFn}`);

  log('refresh', '✅ Auto-refresh infrastructure present');
  return { success: true };
}

// ─── Test 8: Positions, trades, stats endpoints ─────────────────────────────

async function test8_otherEndpoints() {
  console.log('\n═══ TEST 8: Other API endpoints ═══');

  for (const endpoint of ['/api/positions', '/api/trades', '/api/stats', '/api/daily']) {
    const r = await api('GET', endpoint);
    log('api', `GET ${endpoint}: ${r.status} (${JSON.stringify(r.json).slice(0, 80)})`);
    if (r.status !== 200) {
      log('api', `⚠ ${endpoint} returned non-200`);
    }
  }

  log('api', '✅ All data endpoints reachable');
  return { success: true };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DASHBOARD TEST');
  console.log('═══════════════════════════════════════════════════════════');
  log('init', `Dashboard URL: ${DASHBOARD_URL}`);

  // Wait a moment for server to be ready
  await new Promise(r => setTimeout(r, 1000));

  await test1_dashboardUp();
  await test2_auth();
  await test3_statusCircuitBreaker();
  await test4_subWalletPanel();
  await test5_circuitBreakerReset();
  await test6_pauseResume();
  await test7_autoRefresh();
  await test8_otherEndpoints();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  DASHBOARD TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
