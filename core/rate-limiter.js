// ─── core/rate-limiter.js ──────────────────────────────────────────────────────
// Token bucket rate limiter — supports per-service rate limits from config

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

// Service-name → config key mapping
const SERVICE_CONFIG_KEYS = {
  helius: 'helius_rps',
  gmgn: 'gmgn_rps',
  rugcheck: 'rugcheck_rps',
  jupiter: 'jupiter_rps',
  llm: 'llm_rpm',
};

// Per-service default fallback (used if config doesn't specify the key).
// 2026-06-06: gmgn lowered 3 → 1 to match GMGN free-tier rate limit.
const SERVICE_DEFAULT_RATE = {
  helius: 10,
  gmgn: 1,
  rugcheck: 2,
  jupiter: 5,
  llm: 20,
};

const KNOWN_SERVICES = ['helius', 'gmgn', 'rugcheck', 'jupiter', 'llm'];

// ─── State ────────────────────────────────────────────────────────────────────

const _buckets = new Map();

function getConfigRate(service) {
  const config = loadConfig();
  const key = SERVICE_CONFIG_KEYS[service];
  if (key && config.rate_limits?.[key] !== undefined) {
    return config.rate_limits[key];
  }
  return SERVICE_DEFAULT_RATE[service] ?? 10;
}

/**
 * Invalidate a service's bucket so the next acquire() re-reads config.
 * Used by hot-reload (config change via /api/config).
 */
export function resetBucket(service) {
  _buckets.delete(service);
}

function ensureBucket(service) {
  if (_buckets.has(service)) return _buckets.get(service);

  const rate = getConfigRate(service);
  const bucket = {
    service,
    rate,
    burst: rate, // burst = rate (1-second worth of tokens)
    tokens: rate,
    lastRefill: Date.now(),
    interval: 1000 / rate, // ms per token
    _waiters: [], // queue of { resolve, reject, service }
  };
  _buckets.set(service, bucket);
  return bucket;
}

function refill(bucket) {
  const now = Date.now();
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  const tokensToAdd = elapsed / bucket.interval;
  bucket.tokens = Math.min(bucket.burst, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire a token, blocking if necessary until one is available.
 */
export async function acquire(service) {
  const bucket = ensureBucket(service);
  refill(bucket);

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }

  // Wait for next token
  const waitMs = Math.max(1, bucket.interval - (Date.now() - bucket.lastRefill));
  return new Promise((resolve) => {
    setTimeout(() => {
      refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
      }
      resolve();
    }, waitMs);
  });
}

/**
 * Try to acquire a token without waiting. Returns true if acquired.
 */
export function tryAcquire(service) {
  const bucket = ensureBucket(service);
  refill(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Get status of a single service's bucket.
 * Returns { service, rate, tokens, burst }
 */
export function getBucketStatus(service) {
  const bucket = ensureBucket(service);
  refill(bucket);
  return {
    service,
    rate: bucket.rate,
    tokens: Math.floor(bucket.tokens),
    burst: bucket.burst,
  };
}

/**
 * Get status of all known services. Returns an array.
 */
export function getAllBucketStatus() {
  return KNOWN_SERVICES.map(svc => getBucketStatus(svc));
}

/**
 * Reset all bucket state.
 */
export function resetAll() {
  _buckets.clear();
}

/**
 * Reload a specific bucket's configuration.
 */
export function reloadBucket(service, options = {}) {
  if (_buckets.has(service)) {
    const bucket = _buckets.get(service);
    bucket.rate = options.rps ?? options.rate ?? bucket.rate;
    bucket.burst = options.burst ?? bucket.burst;
    bucket.interval = 1000 / bucket.rate;
  } else {
    const rate = options.rps ?? options.rate ?? getConfigRate(service);
    _buckets.set(service, {
      service,
      rate,
      burst: options.burst ?? rate,
      tokens: rate,
      lastRefill: Date.now(),
      interval: 1000 / rate,
      _waiters: [],
    });
  }
}

// Backwards-compat exports
export function createBucket(key, options = {}) {
  reloadBucket(key, options);
}

export function checkRateLimit(key) {
  const ok = tryAcquire(key);
  return ok
    ? { allowed: true, remaining: Math.floor(_buckets.get(key).tokens) }
    : { allowed: false, remaining: 0, retryAfter: Math.ceil(1000 / _buckets.get(key).rate) };
}
