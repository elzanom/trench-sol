import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createLogger } from '../core/logger.js';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createLogger('jupiter');

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Jupiter API ─────────────────────────────────────────────────────────────

const JUPITER_API_BASE = 'https://quote-api.jup.ag/v6';
const JUPITER_DEVNET_API_BASE = 'https://quote-api.jup.ag/devnet/v6';
const JUPITER_SWAP_API = '/swap';
const JUPITER_QUOTE_API = '/quote';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── Jito config ──────────────────────────────────────────────────────────────

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
];

function getRpcUrl(config) {
  if (config.wallet?.use_devnet) {
    return process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
  }
  return process.env.SOLANA_RPC_URL || config.wallet?.rpc_url || 'https://mainnet.helius-rpc.com';
}

function getConnection(config) {
  const { Connection } = require('@solana/web3.js');
  return new Connection(getRpcUrl(config), {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000,
  });
}

// ─── Jupiter quote ────────────────────────────────────────────────────────────

async function getJupiterQuote(inputMint, outputMint, amountLamports, slippageBps, useDevnet) {
  const baseUrl = useDevnet ? JUPITER_DEVNET_API_BASE : JUPITER_API_BASE;
  const url = `${baseUrl}${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}&onlyDirectRoutes=false&computeAutoSlippage=false`;

  const response = await axios.get(url, {
    timeout: 10000,
    headers: { 'Accept': 'application/json' },
  });

  return response.data;
}

// ─── Jupiter swap ──────────────────────────────────────────────────────────────

async function doJupiterSwap(swapRequest, useDevnet) {
  const baseUrl = useDevnet ? JUPITER_DEVNET_API_BASE : JUPITER_API_BASE;
  const url = `${baseUrl}${JUPITER_SWAP_API}`;

  const response = await axios.post(url, swapRequest, {
    timeout: 30000,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  });

  return response.data;
}

// ─── Build transaction ────────────────────────────────────────────────────────

async function buildJupiterSwapTransaction(keypair, quote, useDevnet) {
  const config = loadConfig();
  const { Connection, Transaction, VersionedTransaction } = require('@solana/web3.js');

  const connection = new Connection(getRpcUrl(config), { commitment: 'confirmed' });

  const { swapTransaction } = quote;

  // Deserialize the transaction
  const transaction = Transaction.from(
    Buffer.from(swapTransaction, 'base64')
  );

  // Sign the transaction
  transaction.sign(keypair);

  return transaction;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Buy a token using Jupiter
 * @param {Keypair} keypair - Wallet keypair
 * @param {string} mintAddress - Token mint address to buy
 * @param {number} amountSol - Amount in SOL to spend
 * @param {object} options - Options { slippageBps, useDevnet, useJito }
 * @returns {Promise<object>} Swap result with transaction hash
 */
export async function buyToken(keypair, mintAddress, amountSol, options = {}) {
  const config = loadConfig();
  const {
    slippageBps = 500,
    useDevnet = false,
    paperTrading = config.paper_trading || false,
  } = options;

  // Paper trading mode
  if (paperTrading) {
    log.info(`[JUPITER] Paper trading: would buy ${amountSol} SOL of ${mintAddress}`);
    return {
      success: true,
      mock: true,
      mintAddress,
      amountSol,
      txHash: 'paper_' + Date.now(),
    };
  }

  try {
    const amountLamports = Math.round(amountSol * 1e9);

    // Get quote
    const quote = await getJupiterQuote(SOL_MINT, mintAddress, amountLamports, slippageBps, useDevnet);

    if (!quote || !quote.swapTransaction) {
      throw new Error('No quote returned from Jupiter');
    }

    // Build and sign transaction
    const transaction = await buildJupiterSwapTransaction(keypair, quote, useDevnet);

    // Send transaction
    const connection = getConnection(config);
    const { signature } = await connection.sendTransaction(transaction, [keypair], {
      skipPreflight: false,
    });

    // Wait for confirmation
    await connection.confirmTransaction(signature, { commitment: 'confirmed' });

    log.info(`[JUPITER] Buy tx confirmed: ${signature}`);

    return {
      success: true,
      signature,
      mintAddress,
      amountSol,
      inputAmount: amountSol,
      outputAmount: quote.outAmount ? parseFloat(quote.outAmount) / 1e9 : null,
    };
  } catch (err) {
    log.error(`[JUPITER] Buy failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Sell a token using Jupiter
 * @param {Keypair} keypair - Wallet keypair
 * @param {string} mintAddress - Token mint address to sell
 * @param {number} amountPct - Percentage of holdings to sell (0-100)
 * @param {object} options - Options { slippageBps, useDevnet }
 * @returns {Promise<object>} Swap result
 */
export async function sellToken(keypair, mintAddress, amountPct = 100, options = {}) {
  const config = loadConfig();
  const {
    slippageBps = 500,
    useDevnet = false,
    paperTrading = config.paper_trading || false,
  } = options;

  if (paperTrading) {
    log.info(`[JUPITER] Paper trading: would sell ${amountPct}% of ${mintAddress}`);
    return {
      success: true,
      mock: true,
      mintAddress,
      amountPct,
      txHash: 'paper_' + Date.now(),
    };
  }

  try {
    // Get current token balance
    const { Connection, PublicKey } = require('@solana/web3.js');
    const connection = getConnection(config);

    const tokenAccounts = await connection.getTokenAccountsByOwner(keypair.publicKey, {
      mint: new PublicKey(mintAddress),
    });

    if (!tokenAccounts.value.length) {
      throw new Error('No token account found for this mint');
    }

    const tokenAccount = tokenAccounts.value[0].pubkey;
    const balance = await connection.getTokenAccountBalance(tokenAccount);

    const amountLamports = Math.floor(
      parseFloat(balance.value.amount) * (amountPct / 100)
    );

    if (amountLamports < 1) {
      throw new Error('Amount too small');
    }

    // Get quote for selling
    const quote = await getJupiterQuote(mintAddress, SOL_MINT, amountLamports, slippageBps, useDevnet);

    if (!quote || !quote.swapTransaction) {
      throw new Error('No quote returned from Jupiter');
    }

    // Build and sign transaction
    const transaction = await buildJupiterSwapTransaction(keypair, quote, useDevnet);

    // Send transaction
    const { signature } = await connection.sendTransaction(transaction, [keypair], {
      skipPreflight: false,
    });

    await connection.confirmTransaction(signature, { commitment: 'confirmed' });

    log.info(`[JUPITER] Sell tx confirmed: ${signature}`);

    return {
      success: true,
      signature,
      mintAddress,
      amountPct,
      inputAmount: parseFloat(balance.value.amount) / 1e9,
      outputAmount: quote.outAmount ? parseFloat(quote.outAmount) / 1e9 : null,
    };
  } catch (err) {
    log.error(`[JUPITER] Sell failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Get quote for a swap without executing
 */
export async function getQuote(inputMint, outputMint, amountLamports, slippageBps = 500) {
  try {
    const quote = await getJupiterQuote(inputMint, outputMint, amountLamports, slippageBps, false);
    return quote;
  } catch (err) {
    return null;
  }
}