// ─── feeds/screener.js (shim) ───────────────────────────────────────────────
// DEPRECATED: re-exports from feeds/gmgn.js for backward compatibility.
// Real implementation lives in feeds/gmgn.js (migrated from Birdeye + DexScreener).
//
// To rollback: rename feeds/gmgn.js.bak to feeds/gmgn.js + revert this file
// + revert the matching import in feeds/pumpfun.js + revert the wire in index.js.
export {
  Screener,
  createScreener,
  fetchAllScreeners,
  fetchDexScreener,
  fetchBirdeyeTrending,
  fetchGmgnTrending,
  fetchGmgnTrenches,
  GmgnFeed,
  getGmgnFeed,
  createGmgnFeed,
} from './gmgn.js';
