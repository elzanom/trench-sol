import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = createLogger('llm');

// Load config.json fresh each time (hot-reload support)
function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Get Anthropic client configured from current config
 */
function getClient() {
  const config = loadConfig();
  return new Anthropic({
    baseURL: config.llm.base_url,
    apiKey: process.env.LLM_API_KEY,
  });
}

/**
 * Simple exponential backoff sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Strip markdown code fences from text
 */
function stripMarkdownFences(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

/**
 * Parse JSON from text, throwing helpful error on failure
 */
function parseJson(text) {
  const cleaned = stripMarkdownFences(text);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`JSON parse failed: ${err.message}. Raw text: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Sleep durations for exponential backoff: 1s, 2s, 4s
 */
const BACKOFF_DELAYS = [1000, 2000, 4000];

/**
 * Wraps a function with retry logic for transient errors
 */
async function withRetry(fn, maxAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err.code === 'timeout' ||
        err.code === 'rate_limit_error' ||
        err.status === 429 ||
        err.status === 503 ||
        err.message?.includes('timeout') ||
        err.message?.includes('rate limit') ||
        err.message?.includes('Service Unavailable');

      if (isRetryable && attempt < maxAttempts - 1) {
        const delay = BACKOFF_DELAYS[attempt] || 4000;
        log.warn(`retry ${attempt + 1}/${maxAttempts} after ${delay}ms: ${err.message}`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Basic chat — sends messages + systemPrompt to LLM, returns raw response text
 *
 * @param {Array} messages - Array of {role, content} message objects
 * @param {string} systemPrompt - System prompt string
 * @param {object} options - Optional overrides: { temperature, max_tokens, top_p }
 * @returns {Promise<{text: string, usage: {input_tokens, output_tokens}, latency_ms: number}>}
 */
export async function chat(messages, systemPrompt, options = {}) {
  return withRetry(async () => {
    const config = loadConfig();
    const client = getClient();

    const startTime = Date.now();
    const model = options.model || config.llm.model;
    const temperature = options.temperature ?? config.llm.temperature;
    const maxTokens = options.max_tokens || config.llm.max_tokens;
    const topP = options.top_p ?? config.llm.top_p;
    const timeoutMs = options.timeout_ms || config.llm.timeout_ms;

    const allMessages = systemPrompt
      ? [{ role: 'user', content: systemPrompt }, ...messages]
      : messages;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      messages: allMessages,
      timeout: timeoutMs,
    });

    const latencyMs = Date.now() - startTime;
    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Log the call
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    log.info(`chat model=${model} input_tokens=${inputTokens} output_tokens=${outputTokens} latency_ms=${latencyMs}`);

    return {
      text,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
      latency_ms: latencyMs,
    };
  });
}

/**
 * Chat with structured JSON output — auto-parses JSON, strips markdown fences,
 * retries max 3x if parse fails with helpful error message
 *
 * @param {Array} messages - Array of {role, content} message objects
 * @param {string} systemPrompt - System prompt string
 * @param {object} schema - Optional JSON schema for structured output
 * @param {object} options - Optional overrides
 * @returns {Promise<{data: object, text: string, usage: object, latency_ms: number}>}
 */
export async function chatJSON(messages, systemPrompt, schema = null, options = {}) {
  return withRetry(async () => {
    const config = loadConfig();
    const client = getClient();

    const startTime = Date.now();
    const model = options.model || config.llm.model;
    const temperature = options.temperature ?? config.llm.temperature;
    const maxTokens = options.max_tokens || config.llm.max_tokens;
    const topP = options.top_p ?? config.llm.top_p;
    const timeoutMs = options.timeout_ms || config.llm.timeout_ms;

    const allMessages = systemPrompt
      ? [{ role: 'user', content: systemPrompt }, ...messages]
      : messages;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      top_p: topP,
      messages: allMessages,
      timeout: timeoutMs,
    });

    const latencyMs = Date.now() - startTime;
    const rawText = response.content[0].type === 'text' ? response.content[0].text : '';
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    log.info(`chatJSON model=${model} input_tokens=${inputTokens} output_tokens=${outputTokens} latency_ms=${latencyMs}`);

    // Parse JSON with retry on parse failure
    let data;
    let parseAttempts = 0;
    const maxParseAttempts = 3;

    while (parseAttempts < maxParseAttempts) {
      try {
        data = parseJson(rawText);
        break;
      } catch (err) {
        parseAttempts++;
        if (parseAttempts >= maxParseAttempts) {
          throw new Error(
            `chatJSON parse failed after ${maxParseAttempts} attempts. Last error: ${err.message}`
          );
        }
        log.warn(`JSON parse retry ${parseAttempts}/${maxParseAttempts}: ${err.message}`);
        await sleep(500);
      }
    }

    return {
      data,
      text: rawText,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
      latency_ms: latencyMs,
    };
  });
}

/**
 * Convenience shorthand for single user message
 *
 * @param {string} userMessage - Single user message string
 * @param {string} systemPrompt - Optional system prompt
 * @param {object} options - Optional overrides
 * @returns {Promise<{text: string, usage: object, latency_ms: number}>}
 */
export async function ask(userMessage, systemPrompt = '', options = {}) {
  return chat([{ role: 'user', content: userMessage }], systemPrompt, options);
}