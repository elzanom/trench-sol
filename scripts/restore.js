import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import { createReadStream, createWriteStream } from 'fs';
import { rm, mkdir } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function loadConfig() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8');
  return JSON.parse(raw);
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

function decrypt(data, password) {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

async function confirm(question) {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question + ' (y/N): ', answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}

// ─── Restore from backup ──────────────────────────────────────────────────────

export async function restoreBackup(backupFilePath) {
  const password = process.env.BACKUP_ENCRYPTION_PASSWORD;
  if (!password) {
    throw new Error('BACKUP_ENCRYPTION_PASSWORD not set');
  }

  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`Backup file not found: ${backupFilePath}`);
  }

  const stat = fs.statSync(backupFilePath);
  console.log(`[restore] File: ${backupFilePath} (${(stat.size / 1024).toFixed(1)} KB)`);

  // Read encrypted data
  const encryptedData = fs.readFileSync(backupFilePath);

  // Decrypt
  let zipBuffer;
  try {
    zipBuffer = decrypt(encryptedData, password);
    console.log('[restore] Decryption successful');
  } catch (err) {
    throw new Error(`Decryption failed — wrong password? (${err.message})`);
  }

  // Extract to temp directory
  const tempDir = path.join(__dirname, '..', '.restore_temp');
  const extractDir = path.join(tempDir, 'extracted');

  try {
    if (fs.existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true });
    }
    await mkdir(extractDir, { recursive: true });

    const unzip = (await import('node:zlib')).createUnzip();
    const writeStream = createWriteStream(path.join(extractDir, 'backup.zip'));
    await pipeline(unzip, writeStream);
    // Write the zip data
    fs.writeFileSync(path.join(extractDir, 'backup.zip'), zipBuffer);
  } catch {
    // Try extracting manually
    const { extract } = await import('archiver');
    // Instead just write the zip buffer to a temp file and use node tar
    fs.writeFileSync(path.join(extractDir, 'data.zip'), zipBuffer);
  }

  // List files in backup
  const files = [];
  try {
    const entries = fs.readdirSync(extractDir);
    for (const entry of entries) {
      if (entry.endsWith('.zip')) {
        // It's the zip — extract using node stream
        const AdmZip = await import('adm-zip').catch(() => null);
        if (AdmZip) {
          const zip = new AdmZip.default(path.join(extractDir, entry));
          zip.extractAllTo(extractDir, true);
        }
      } else if (fs.statSync(path.join(extractDir, entry)).isFile()) {
        files.push(entry);
      }
    }
  } catch {}

  // Find actual files (not the zip itself)
  const actualFiles = [];
  const allEntries = fs.readdirSync(extractDir);
  for (const entry of allEntries) {
    const full = path.join(extractDir, entry);
    if (fs.statSync(full).isFile() && !entry.endsWith('.zip')) {
      actualFiles.push({ source: full, relative: entry });
    }
  }

  if (actualFiles.length === 0) {
    // Fallback: the zip is the content, use adm-zip
    try {
      const AdmZip = (await import('adm-zip')).default;
      const zipPath = allEntries.find(e => e.endsWith('.zip'));
      if (zipPath) {
        const zip = new AdmZip(path.join(extractDir, zipPath));
        const zipEntries = zip.getEntries();
        for (const ze of zipEntries) {
          const targetPath = path.join(extractDir, ze.entryName);
          if (ze.isDirectory) {
            fs.mkdirSync(targetPath, { recursive: true });
          } else {
            fs.writeFileSync(targetPath, ze.getData());
            actualFiles.push({ source: targetPath, relative: ze.entryName });
          }
        }
      }
    } catch {}
  }

  console.log(`[restore] Files to restore: ${actualFiles.map(f => f.relative).join(', ')}`);

  // Confirm overwrite
  const confirmed = await confirm(`[restore] This will overwrite ${actualFiles.length} file(s). Continue?`);
  if (!confirmed) {
    console.log('[restore] Cancelled');
    await rm(tempDir, { recursive: true, force: true });
    return;
  }

  // Restore files
  const projectRoot = path.join(__dirname, '..');
  let restored = 0;
  for (const { source, relative } of actualFiles) {
    const dest = path.join(projectRoot, relative);
    const destDir = path.dirname(dest);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const content = fs.readFileSync(source);
    fs.writeFileSync(dest, content);
    restored++;
    console.log(`[restore] Restored: ${relative}`);
  }

  // Cleanup
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});

  console.log(`[restore] Done — ${restored} file(s) restored`);
  return restored;
}

// ─── Run if called directly ──────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('restore.js');
if (isMain) {
  const backupFile = process.argv.find(a => a.startsWith('--file='))?.slice(7);

  if (!backupFile) {
    console.error('Usage: node scripts/restore.js --file=backup_[timestamp].zip.enc');
    process.exit(1);
  }

  restoreBackup(backupFile).catch(err => {
    console.error(`[restore] Fatal: ${err.message}`);
    process.exit(1);
  });
}