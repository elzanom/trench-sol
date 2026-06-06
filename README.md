# Solana Trench Meme Coin AI Agent

AI agent fully autonomous untuk trading meme coin di Solana. LLM (MiniMax M2.7) menangani semua keputusan entry, exit, dan manajemen posisi. Agent belajar dari setiap trade yang dilakukan (*learning by doing*) sehingga performa meningkat seiring waktu.

## Prinsip Utama

- LLM mengambil semua keputusan trading — bukan rule-based bot
- Hard rules adalah batas absolut yang **tidak bisa** disentuh atau di-override LLM
- Semua parameter/filter bisa dikustomisasi via `config.json`
- LLM provider bisa diganti hanya dengan mengubah config
- Agent belajar dari histori trade via RAG Memory + Structured Ledger

## Fitur

- **Multi-wallet system** — Main wallet + sub-wallets untuk proteksi dana
- **Tiered conviction sizing** — Position size berdasarkan confidence LLM
- **Circuit breaker** — Daily loss limit + trade count limiter
- **Rate limiter** — Token bucket per service (Helius, Birdeye, Jupiter, LLM)
- **Jito MEV protection** — Bundle swap + tip untuk avoid sandwich attack
- **Position snapshots** — Trajectory learning untuk pattern detection
- **Backtest mode** — Historical replay untuk validate strategy
- **Paper trading** — Test tanpa real money
- **Backup terenkripsi** — AES-256 encrypted ZIP

## Stack Teknologi

| Komponen | Teknologi |
|---|---|
| Runtime | Node.js 20+ |
| LLM SDK | `@anthropic-ai/sdk` |
| Solana RPC | `@solana/web3.js` |
| Swap Execution | Jupiter Aggregator API v6 |
| Telegram Feed | `gramjs` (MTProto) |
| Twitter Feed | `puppeteer-extra` + `puppeteer-extra-plugin-stealth` |
| On-chain Data | Helius RPC / Birdeye API |
| RAG Memory | `vectra` (local vector DB) |
| Structured Storage | SQLite via `better-sqlite3` |
| Dashboard | Express.js + vanilla JS |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env dan isi semua API keys dan private keys
```

### 3. Edit config.json

```bash
# Adjust parameters sesuai kebutuhan
# Lokasi config.json: ./config.json
```

### 4. Generate sub-wallets (optional)

```bash
# Tambah sub-wallets di .env:
# SUB_WALLET_1_PRIVATE_KEY=...
# SUB_WALLET_2_PRIVATE_KEY=...
# SUB_WALLET_3_PRIVATE_KEY=...
```

## Cara Run

### Development / Paper Trading

```bash
# Paper trading mode (semua logic jalan, tidak ada actual transaction)
# Set "paper_trading": true di config.json
node index.js
```

### Backtest

```bash
# Aktifkan backtest di config.json:
# "backtest": { "enabled": true, "lookback_days": 7 }
node index.js --backtest
```

### Live Trading

```bash
# Pastikan:
# 1. config.agent.paper_trading = false
# 2. config.wallet.use_devnet = false
# 3. Semua API keys sudah di-set di .env
node index.js
```

### Devnet Testing

```bash
# Set config.wallet.use_devnet = true
# Pastikan ada SOL di devnet
node index.js
```

## Struktur Project

```
solana-trench-agent/
├── .env                          # secrets — TIDAK di-commit
├── config.json                   # semua parameter agent
├── index.js                      # entry point, orchestrator
│
├── core/
│   ├── llm.js                    # LLM abstraction layer
│   ├── hard-rules.js             # filter immutable
│   ├── wallet.js                 # multi-wallet manager
│   ├── rate-limiter.js           # token bucket rate limiter
│   └── circuit-breaker.js        # daily loss + trade limit
│
├── feeds/
│   ├── aggregator.js             # merge semua feed
│   ├── pumpfun.js                # pump.fun watcher
│   ├── screener.js               # DexScreener + Birdeye
│   ├── telegram.js               # GramJS session
│   └── twitter.js                # Puppeteer scraper
│
├── analysis/
│   ├── onchain.js                # holder, liquidity, volume
│   ├── onchain-snapshot.js       # position trajectory
│   ├── rugcheck.js               # rugcheck.xyz wrapper
│   └── bundler-check.js          # bundled detection
│
├── brain/
│   ├── decision.js               # LLM entry decision
│   ├── position-manager.js       # LLM TP/SL adjustment
│   └── prompts/
│       ├── entry.js              # entry prompt template
│       ├── monitor.js            # monitor prompt template
│       └── feed-filter.js        # telegram/twitter filter
│
├── execution/
│   ├── jupiter.js                # Jupiter swap + Jito
│   └── position.js               # position tracker
│
├── memory/
│   ├── ledger.js                 # structured stats
│   └── rag.js                    # vector index
│
├── backtest/
│   ├── runner.js                 # backtest engine
│   ├── data-fetcher.js            # historical data
│   └── report.js                  # generate report
│
├── scripts/
│   ├── backup.js                  # encrypted backup
│   └── restore.js                  # restore from backup
│
├── dashboard/
│   ├── server.js                  # Express server
│   └── public/
│       ├── index.html
│       ├── style.css
│       └── app.js
│
└── logs/
    └── agent.log                  # rotating log
```

## Testing

```bash
# Jalankan semua unit tests
npm test

# Atau jalankan step-by-step:
# 1. Paper trading 1 jam
# 2. Verifikasi feeds, snapshots, circuit breaker, backup
```

## Security

- **Private keys** hanya di `.env` — JANGAN masukkan ke `config.json` atau commit ke git
- **API keys** juga di `.env`
- **Dashboard** diamankan dengan `X-Auth-Token` header
- **Backup** dienkripsi dengan AES-256

## License

MIT