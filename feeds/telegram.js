// ─── Telegram Bot ──────────────────────────────────────────────────────────────

let telegramClient = null;

/**
 * Create Telegram client
 */
export async function createClient() {
  const { TelegramClient } = await import('gramjs');

  const session = process.env.TELEGRAM_SESSION || 'telegram-session';
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0');
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID and TELEGRAM_API_HASH must be set');
  }

  telegramClient = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });
  await telegramClient.start();
  return telegramClient;
}

/**
 * Send message via Telegram
 */
export async function sendTelegramMessage(chatId, message) {
  if (!telegramClient) {
    await createClient();
  }

  const { Api } = await import('gramjs');
  await telegramClient.invoke(
    new Api.messages.SendMessage({
      peer: chatId,
      message,
      randomId: BigInt(Date.now()),
    })
  );
}

// ─── Telegram Feed ────────────────────────────────────────────────────────────

export class TelegramFeed {
  constructor() {
    this.mentionedTokens = [];
  }

  async checkForSignals() {
    // This would check Telegram messages for token signals
    return [];
  }

  extractSolanaAddresses(text) {
    const matches = text.match(/[A-Za-z0-9]{32,44}/g);
    return matches || [];
  }
}

export function createTelegramFeed() {
  return new TelegramFeed();
}