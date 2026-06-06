// ─── feeds/pumpfun.js (shim) ────────────────────────────────────────────────
// DEPRECATED: re-exports from feeds/gmgn.js for backward compatibility.
// Real implementation lives in feeds/gmgn.js (migrated from Birdeye + DexScreener).
//
// To rollback: rename feeds/gmgn.js.bak to feeds/gmgn.js + revert this file
// + revert the matching import in feeds/screener.js + revert the wire in index.js.
export {
  PumpfunFeed,
  createPumpfunFeed,
  getPumpfunFeed,
  fetchPumpfunTokens,
  fetchGmgnTrenches,
  fetchGmgnTrending,
  GmgnFeed,
  getGmgnFeed,
  createGmgnFeed,
} from './gmgn.js';
