import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, '..', 'logs');

// ─── Logger ───────────────────────────────────────────────────────────────────

function getLogFilePath(dateStr) {
  return path.join(LOG_DIR, `agent-${dateStr}.log`);
}

function rotateLogs() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return;
  }

  try {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log') && !f.includes('.1'));
    for (const file of files) {
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);

      // Rotate files older than 7 days
      const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // Silently fail if log rotation fails
  }
}

export function createLogger(moduleName) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const logFile = getLogFilePath(dateStr);

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] [${moduleName}] ${message}`;

    try {
      fs.appendFileSync(logFile, logLine + (data ? ' ' + JSON.stringify(data) : '') + '\n');
    } catch {
      // Silently fail if log write fails
    }

    // 2026-06-07: push to shared buffer (circular, max 50 lines)
    SHARED_LOG_BUFFER.push(logLine + (data ? ' ' + JSON.stringify(data) : ''));
    if (SHARED_LOG_BUFFER.length > MAX_LOG_LINES) {
      SHARED_LOG_BUFFER.shift();
    }

    if (level === 'ERROR') {
      console.error(logLine, data || '');
    } else {
      console.log(logLine, data || '');
    }
  }

  return {
    info: (msg, data) => log('INFO', msg, data),
    warn: (msg, data) => log('WARN', msg, data),
    error: (msg, data) => log('ERROR', msg, data),
    debug: (msg, data) => log('DEBUG', msg, data),
  };
}

// 2026-06-07: shared circular log buffer for dashboard /api/log endpoint.
// Captures every log line from every createLogger instance (module-scoped state).
const SHARED_LOG_BUFFER = [];
const MAX_LOG_LINES = 50;

export function getLogBuffer() {
  return [...SHARED_LOG_BUFFER];  // return copy to prevent external mutation
}