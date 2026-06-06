// ─── core/wallet.js ───────────────────────────────────────────────────────────
// Solana wallet manager — supports main wallet + multiple sub-wallets
// Exports: WalletManager class (for index.js) + 14 standalone functions (for tests)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as web3 from '@solana/web3.js';
import bs58 from 'bs58';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config loader (supports __TEST_CONFIG_PATH) ─────────────────────────────

function loadConfig() {
  if (process.env.__TEST_CONFIG_PATH) {
    return JSON.parse(fs.readFileSync(process.env.__TEST_CONFIG_PATH, 'utf8'));
  }
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Module-level state ───────────────────────────────────────────────────────

let _connection = null;
let _connectionCreatedAt = 0;
let _mainKeypair = null;
const CONNECTION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Sub-wallet state (lazily populated)
let _subWallets = null; // { 1: keypair, 2: keypair, 3: keypair, ... }
let _rotationCounter = 0;
let _lastDay = null;
let _lastDayIndex = 1;

// ─── Keypair loading ──────────────────────────────────────────────────────────

function loadKeypairFromEnv(envVar) {
  const value = process.env[envVar];
  if (!value) return null;

  // Try base58 first
  try {
    const decoded = bs58.decode(value);
    return web3.Keypair.fromSecretKey(decoded);
  } catch {
    // Fall back to JSON array
    try {
      const arr = JSON.parse(value);
      return web3.Keypair.fromSecretKey(new Uint8Array(arr));
    } catch {
      return null;
    }
  }
}

export function loadWallet() {
  if (_mainKeypair) return _mainKeypair;

  // 1) Try env var
  const envKey = loadKeypairFromEnv('WALLET_PRIVATE_KEY');
  if (envKey) {
    _mainKeypair = envKey;
    return _mainKeypair;
  }

  // 2) Try config keypair_path
  const config = loadConfig();
  const keypairPath = config.wallet?.keypair_path;
  if (keypairPath && fs.existsSync(keypairPath)) {
    const secretKey = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
    _mainKeypair = web3.Keypair.fromSecretKey(new Uint8Array(secretKey));
    return _mainKeypair;
  }

  throw new Error('No wallet configured: set WALLET_PRIVATE_KEY env var or wallet.keypair_path in config');
}

function loadSubWallets() {
  if (_subWallets) return _subWallets;

  _subWallets = {};
  for (let i = 1; i <= 10; i++) {
    const kp = loadKeypairFromEnv(`SUB_WALLET_${i}_PRIVATE_KEY`);
    if (kp) {
      _subWallets[i] = kp;
    }
  }

  // ── Paper mode fallback: generate dummy sub-wallets if none configured ──
  if (Object.keys(_subWallets).length === 0) {
    const config = loadConfig();
    if (config.agent?.paper_trading === true) {
      console.warn('[WALLET] No sub-wallets in env — generating 3 dummies for paper mode');
      for (let i = 1; i <= 3; i++) {
        _subWallets[i] = web3.Keypair.generate();
      }
    }
  }
  return _subWallets;
}

function resetSubWalletCache() {
  _subWallets = null;
  _rotationCounter = 0;
  _lastDay = null;
  _lastDayIndex = 1;
}

// ─── Connection management ────────────────────────────────────────────────────

export function getRpcUrl() {
  const config = loadConfig();
  return config.wallet?.rpc_endpoint || process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com';
}

export function getConnection() {
  const now = Date.now();
  if (_connection && (now - _connectionCreatedAt) < CONNECTION_TTL_MS) {
    return _connection;
  }

  const rpcUrl = getRpcUrl();
  const apiKey = process.env.HELIUS_API_KEY || '';
  _connection = new web3.Connection(rpcUrl + apiKey, 'confirmed');
  _connectionCreatedAt = now;
  return _connection;
}

export function invalidateConnection() {
  if (_connection) {
    try { _connection.close(); } catch {}
    _connection = null;
  }
  _connectionCreatedAt = 0;
}

// ─── Public key & balance helpers ─────────────────────────────────────────────

export function getMainPublicKey() {
  const wallet = loadWallet();
  return wallet.publicKey.toString();
}

export async function getMainBalance() {
  const wallet = loadWallet();
  const conn = getConnection();
  try {
    const balance = await conn.getBalance(wallet.publicKey);
    return balance / web3.LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

export async function getBalance(publicKeyOrString) {
  const pk = typeof publicKeyOrString === 'string'
    ? new web3.PublicKey(publicKeyOrString)
    : publicKeyOrString;
  const conn = getConnection();
  const balance = await conn.getBalance(pk);
  return balance / web3.LAMPORTS_PER_SOL;
}

export async function getTokenBalance(walletAddress, mintAddress) {
  const conn = getConnection();
  const walletPk = typeof walletAddress === 'string'
    ? new web3.PublicKey(walletAddress)
    : walletAddress;
  const mintPk = typeof mintAddress === 'string'
    ? new web3.PublicKey(mintAddress)
    : mintAddress;

  try {
    const ata = await web3.getAssociatedTokenAddress(mintPk, walletPk);
    const accountInfo = await conn.getTokenAccountBalance(ata);
    return {
      amount: accountInfo.value.amount,
      decimals: accountInfo.value.decimals,
      uiAmount: accountInfo.value.uiAmount,
    };
  } catch (e) {
    return { amount: '0', decimals: 0, uiAmount: 0, error: e.message };
  }
}

// ─── Sub-wallet management ────────────────────────────────────────────────────

export function getSubWallet(index) {
  const subs = loadSubWallets();
  if (!subs[index]) {
    throw new Error(`Sub-wallet ${index} not found in env vars`);
  }
  return { keypair: subs[index], index };
}

export function getSubWalletPublicKey(index) {
  try {
    const sub = getSubWallet(index);
    return sub.keypair.publicKey.toString();
  } catch {
    return null;
  }
}

export async function getSubWalletBalance(index) {
  const subs = loadSubWallets();
  if (!subs[index]) return null;
  const conn = getConnection();
  try {
    const balance = await conn.getBalance(subs[index].publicKey);
    return balance / web3.LAMPORTS_PER_SOL;
  } catch {
    return 0;
  }
}

export async function getAllSubWalletBalances() {
  const subs = loadSubWallets();
  const result = [];
  for (const [index, keypair] of Object.entries(subs)) {
    const i = parseInt(index);
    let balance = null;
    try {
      const conn = getConnection();
      const lamports = await conn.getBalance(keypair.publicKey);
      balance = lamports / web3.LAMPORTS_PER_SOL;
    } catch {}
    result.push({
      index: i,
      publicKey: keypair.publicKey.toString(),
      balance,
    });
  }
  return result;
}

export function getNextSubWallet() {
  const config = loadConfig();

  if (!config.wallet?.sub_wallets_enabled) {
    throw new Error('No sub-wallets configured');
  }

  const subs = loadSubWallets();
  const indices = Object.keys(subs).map(Number).sort((a, b) => a - b);
  if (indices.length === 0) {
    throw new Error('No sub-wallets configured');
  }

  const mode = config.wallet?.sub_wallet_rotation || 'per_trade';
  let selectedIndex;

  if (mode === 'per_trade') {
    // Round-robin: 1, 2, 3, 1, 2, 3...
    selectedIndex = indices[_rotationCounter % indices.length];
    _rotationCounter++;
  } else if (mode === 'per_day') {
    // Same sub-wallet within same day
    const today = new Date().toISOString().slice(0, 10);
    if (_lastDay !== today) {
      _lastDay = today;
      _lastDayIndex = indices[Math.floor(Math.random() * indices.length)];
    }
    selectedIndex = _lastDayIndex;
  } else if (mode === 'random') {
    selectedIndex = indices[Math.floor(Math.random() * indices.length)];
  } else {
    // Default to per_trade
    selectedIndex = indices[_rotationCounter % indices.length];
    _rotationCounter++;
  }

  return {
    index: selectedIndex,
    keypair: subs[selectedIndex],
  };
}

// ─── Fund / sweep / send ──────────────────────────────────────────────────────

export async function fundSubWallet(index, amountSol = null) {
  const config = loadConfig();
  const amount = amountSol ?? config.wallet?.sub_wallet_fund_amount_sol ?? 0.05;

  const mainKp = loadWallet();
  const sub = getSubWallet(index);
  const conn = getConnection();

  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: mainKp.publicKey,
      toPubkey: sub.keypair.publicKey,
      lamports: amount * web3.LAMPORTS_PER_SOL,
    })
  );
  tx.feePayer = mainKp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  const sig = await web3.sendAndConfirmTransaction(conn, tx, [mainKp]);
  return { signature: sig, amount, subWalletIndex: index };
}

export async function sweepSubWallet(index, destinationPublicKey = null) {
  const sub = getSubWallet(index);
  const mainKp = loadWallet();
  const conn = getConnection();

  const dest = destinationPublicKey
    ? new web3.PublicKey(destinationPublicKey)
    : mainKp.publicKey;

  const balance = await conn.getBalance(sub.keypair.publicKey);
  const feeReserve = 5000; // lamports for tx fee
  const sweepAmount = balance - feeReserve;
  if (sweepAmount <= 0) {
    return { signature: null, swept: 0, reason: 'insufficient balance' };
  }

  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: sub.keypair.publicKey,
      toPubkey: dest,
      lamports: sweepAmount,
    })
  );
  tx.feePayer = sub.keypair.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

  const sig = await web3.sendAndConfirmTransaction(conn, tx, [sub.keypair]);
  return {
    signature: sig,
    swept: sweepAmount / web3.LAMPORTS_PER_SOL,
    subWalletIndex: index,
  };
}

export async function sendTransaction(transaction, signers = []) {
  const conn = getConnection();
  // Auto-fill recentBlockhash + feePayer if missing
  if (!transaction.recentBlockhash) {
    transaction.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  }
  if (!transaction.feePayer && signers.length > 0) {
    transaction.feePayer = signers[0].publicKey;
  }
  return await web3.sendAndConfirmTransaction(conn, transaction, signers);
}

// ─── WalletManager class (used by index.js) ───────────────────────────────────

export class WalletManager {
  constructor(config = null) {
    this.config = config || loadConfig();
    this.mainKeypair = null;
    this.subWallets = {};
  }

  async loadSubWallets() {
    this.mainKeypair = loadWallet();
    // Reset sub-wallet cache to pick up new env vars
    resetSubWalletCache();
    const subs = loadSubWallets();
    for (const [idx, kp] of Object.entries(subs)) {
      this.subWallets[parseInt(idx)] = kp;
    }
  }

  getMainKeypair() {
    if (!this.mainKeypair) this.mainKeypair = loadWallet();
    return this.mainKeypair;
  }

  getMainPublicKey() {
    return this.getMainKeypair().publicKey.toString();
  }

  async getMainBalance() {
    return await getMainBalance();
  }

  getSubWalletCount() {
    return Object.keys(this.subWallets).length;
  }

  getSubWallet(index) {
    if (!this.subWallets[index]) {
      throw new Error(`Sub-wallet ${index} not loaded`);
    }
    return this.subWallets[index];
  }

  getSubWalletPublicKey(index) {
    const sub = this.getSubWallet(index);
    return sub.publicKey.toString();
  }

  async getSubWalletBalance(index) {
    if (!this.subWallets[index]) return null;
    const conn = getConnection();
    const balance = await conn.getBalance(this.subWallets[index].publicKey);
    return balance / web3.LAMPORTS_PER_SOL;
  }

  async getAllSubWalletBalances() {
    return await getAllSubWalletBalances();
  }

  getNextSubWallet() {
    return getNextSubWallet();
  }

  async fundSubWallet(index, amount) {
    return await fundSubWallet(index, amount);
  }

  async sweepSubWallet(index) {
    return await sweepSubWallet(index);
  }

  getConnection() {
    return getConnection();
  }

  invalidateConnection() {
    return invalidateConnection();
  }
}
