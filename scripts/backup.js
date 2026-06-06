import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// ─── Encryption helpers ────────────────────────────────────────────────────────

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

function encrypt(buffer, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: salt (32) + iv (16) + authTag (16) + encrypted
  return Buffer.concat([salt, iv, authTag, encrypted]);
}

function decrypt(data, password) {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ─── Archive files ────────────────────────────────────────────────────────────

function createArchive(files, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(outputPath));
    archive.on('error', reject);

    archive.pipe(output);

    for (const { src, dest } of files) {
      try {
        if (fs.existsSync(src)) {
          archive.file(src, { name: dest });
        }
      } catch {}
    }

    archive.finalize();
  });
}

// ─── Prune old backups ───────────────────────────────────────────────────────

function pruneOldBackups(backupDir, maxAgeMs) {
  if (!fs.existsSync(backupDir)) return;

  const now = Date.now();
  const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip.enc'));

  let pruned = 0;
  for (const file of files) {
    const fullPath = path.join(backupDir, file);
    const stat = fs.statSync(fullPath);
    if (now - stat.mtimeMs > maxAgeMs) {
      try {
        fs.unlinkSync(fullPath);
        pruned++;
      } catch {}
    }
  }

  if (pruned > 0) {
    console.log(`[backup] Pruned ${pruned} backup(s) older than 7 days`);
  }
}

// ─── Run backup ───────────────────────────────────────────────────────────────

export async function runBackup() {
  const config = loadConfig();
  const backupConfig = config.backup || {};

  const includeFiles = backupConfig.include_files || ['config.json', '.env'];
  const destination = backupConfig.destination_path || path.join(__dirname, '..', 'backups');
  const intervalMin = backupConfig.interval_minutes || 60;
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  const password = process.env.BACKUP_ENCRYPTION_PASSWORD;
  if (!password) {
    console.error('[backup] BACKUP_ENCRYPTION_PASSWORD not set — skipping');
    return;
  }

  console.log(`[backup] Starting backup...`);

  try {
    // Ensure destination exists
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true });
    }

    // Prune old backups first
    pruneOldBackups(destination, maxAgeMs);

    // Prepare files to archive
    const projectRoot = path.join(__dirname, '..');
    const filesToArchive = includeFiles.map(f => {
      const src = path.isAbsolute(f) ? f : path.join(projectRoot, f);
      return { src, dest: f };
    }).filter(f => fs.existsSync(f.src));

    if (filesToArchive.length === 0) {
      console.warn('[backup] No files to archive');
      return;
    }

    // Create archive in memory first
    const archiveBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      for (const { src, dest } of filesToArchive) {
        if (fs.existsSync(src)) {
          archive.file(src, { name: dest });
        }
      }

      archive.finalize();
    });

    // Encrypt
    const encrypted = encrypt(archiveBuffer, password);

    // Write
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(destination, `backup_${timestamp}.zip.enc`);
    fs.writeFileSync(backupFile, encrypted);

    console.log(`[backup] Created: ${backupFile} (${(encrypted.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    // Don't crash agent
    console.error(`[backup] Failed: ${err.message}`);
  }
}

// ─── Run scheduled backup ────────────────────────────────────────────────────

export function startBackupScheduler() {
  const config = loadConfig();
  const intervalMs = (config.backup?.interval_minutes || 60) * 60 * 1000;

  console.log(`[backup] Scheduler started — every ${config.backup?.interval_minutes || 60} minutes`);

  return setInterval(() => {
    runBackup().catch(err => {
      console.error(`[backup] Scheduled run failed: ${err.message}`);
    });
  }, intervalMs);
}

// ─── Run if called directly ──────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('backup.js');
if (isMain) {
  runBackup().catch(err => {
    console.error(`[backup] Fatal: ${err.message}`);
    process.exit(1);
  });
}