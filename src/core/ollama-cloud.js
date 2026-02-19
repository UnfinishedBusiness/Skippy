const { Ollama } = require("ollama");
// Resolve global.logger at call time so startup ordering doesn't matter.
const logger = {
  info:  (...a) => (global.logger || console).info(...a),
  warn:  (...a) => (global.logger || console).warn(...a),
  error: (...a) => (global.logger || console).error(...a),
  debug: (...a) => (global.logger || console).debug(...a),
};

// Configurable via Skippy.json ollama section:
//   timeout                  — total request timeout in ms (default 120s)
//   stream_inactivity_timeout — abort if no chunk arrives for this long (default 30s)
//   max_retries              — retry count for rate-limit / transient errors (default 3)
const DEFAULT_TIMEOUT_MS    = 120_000;
const DEFAULT_INACTIVITY_MS =  30_000;
const DEFAULT_MAX_RETRIES   =       3;

function getConfig() {
  return global.SkippyConfig?.ollama ?? {};
}

function getApiKey() {
  const key = getConfig().apiKey;
  if (!key) throw new Error("Ollama API key not found in config");
  return key;
}

function createOllamaClient() {
  const host = getConfig().host || "https://ollama.com";
  return new Ollama({
    host,
    headers: { Authorization: "Bearer " + getApiKey() },
  });
}

function getModel() {
  const cfg = getConfig();
  if (cfg.model) {
    logger.info("Using Ollama model from config: " + cfg.model);
    return cfg.model;
  }
  const fallback = "gpt-oss:120b";
  logger.error("No model in config, using fallback: " + fallback);
  return fallback;
}

// Classify whether an error is worth retrying.
function isRetryable(err) {
  const code = err.status_code;
  if (code === 429 || code === 503 || code === 502 || code === 504) return true;
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
  if (err.code && /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/.test(err.code)) return true;
  return false;
}

// Exponential backoff, respecting Retry-After header text if present in the message.
function retryDelayMs(err, attempt) {
  // Some APIs embed "Retry-After: N" in the error message
  const match = String(err.message || '').match(/retry[- ]after[:\s]+(\d+)/i);
  if (match) return parseInt(match[1], 10) * 1000;
  return Math.min(1000 * 2 ** (attempt - 1), 30_000); // 1s, 2s, 4s … cap 30s
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Log a rich error message with all available context.
function logError(label, err, extra = {}) {
  const parts = [
    `[${label}] ${err.message || err}`,
    err.status_code != null ? `HTTP ${err.status_code}` : null,
    err.code              ? `code=${err.code}`         : null,
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ].filter(Boolean);
  logger.error(parts.join(' | '));
}

// Core attempt — single request with total timeout + stream inactivity timeout.
async function attemptPrompt({ prompt, context, model, stream, images }, callback) {
  const cfg = getConfig();
  const timeoutMs    = cfg.timeout                   ?? DEFAULT_TIMEOUT_MS;
  const inactivityMs = cfg.stream_inactivity_timeout ?? DEFAULT_INACTIVITY_MS;

  const ollama = createOllamaClient();
  const fullPrompt = context ? `${context}\n${prompt}` : prompt;
  const startTime = Date.now();

  let timedOut = false;
  let inactivityTimer = null;

  // Hard total-request timeout — aborts the ollama client's ongoing requests.
  const totalTimer = setTimeout(() => {
    timedOut = true;
    logger.error(`[promptOllama] Total request timeout after ${timeoutMs}ms — aborting`);
    ollama.abort();
  }, timeoutMs);

  const clearInactivity = () => {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
  };
  const resetInactivity = () => {
    clearInactivity();
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      logger.error(`[promptOllama] Stream inactivity timeout after ${inactivityMs}ms — aborting`);
      ollama.abort();
    }, inactivityMs);
  };

  try {
    logger.debug(`[promptOllama] Sending request — model=${model} stream=${stream} timeout=${timeoutMs}ms inactivity=${inactivityMs}ms`);
    const userMessage = { role: "user", content: fullPrompt };
    if (images && images.length > 0) userMessage.images = images;

    const response = await ollama.chat({
      model,
      messages: [userMessage],
      stream,
    });

    let fullResponse = "";
    let firstChunk = true;

    resetInactivity(); // start inactivity clock once connection is established

    for await (const part of response) {
      resetInactivity();
      if (firstChunk) {
        logger.debug(`[promptOllama] First token in ${Date.now() - startTime}ms`);
        firstChunk = false;
      }
      fullResponse += part.message.content;
      if (callback) callback(part.message.content, false);
    }

    clearInactivity();

    if (timedOut) {
      // The abort fired — the stream ended early. Throw so the caller knows.
      throw new Error(`Request aborted due to timeout (${Date.now() - startTime}ms elapsed)`);
    }

    const elapsed = Date.now() - startTime;
    logger.debug(`[promptOllama] Completed — ${elapsed}ms, ${fullResponse.length} chars`);
    if (callback) callback(fullResponse, true);
    return fullResponse;

  } finally {
    clearTimeout(totalTimer);
    clearInactivity();
  }
}

async function promptOllama({ prompt, context = "", model, stream = true, images }, callback) {
  if (!model) model = getModel();

  const cfg = getConfig();
  const maxRetries = cfg.max_retries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await attemptPrompt({ prompt, context, model, stream, images }, callback);
    } catch (err) {
      const retryable = isRetryable(err);
      const isLast = attempt >= maxRetries;

      logError('promptOllama', err, { attempt: `${attempt}/${maxRetries}`, retryable });

      if (!retryable || isLast) {
        // Surface a clean, informative error up to the caller
        const hint = err.status_code === 429 ? ' (rate limited)'
                   : err.status_code === 503 ? ' (service unavailable)'
                   : err.status_code === 401 ? ' (unauthorized — check API key)'
                   : '';
        throw new Error(`Ollama request failed${hint}: ${err.message}`);
      }

      const delay = retryDelayMs(err, attempt);
      logger.warn(`[promptOllama] Retrying in ${delay}ms (attempt ${attempt}/${maxRetries}) — ${err.message}`);
      await sleep(delay);
    }
  }
}

// Fetch and log model info at startup. Stores detected context length on
// global.SkippyModelContextWindow so prompt.js can use it as a fallback.
async function fetchModelInfo() {
  const model = getModel();
  try {
    const ollama = createOllamaClient();
    const info = await ollama.show({ model });

    // Context length lives under model_info with an architecture-prefixed key,
    // e.g. "llama.context_length", "mistral.context_length", etc.
    // Fall back to details.context_length for older Ollama versions.
    let contextLength = null;
    if (info.model_info) {
      const ctxKey = Object.keys(info.model_info).find(k => k.endsWith('.context_length'));
      if (ctxKey) contextLength = info.model_info[ctxKey];
    }
    if (!contextLength && info.details?.context_length) {
      contextLength = info.details.context_length;
    }

    const paramSize  = info.details?.parameter_size  ?? 'unknown';
    const quant      = info.details?.quantization_level ?? 'unknown';
    const ctxDisplay = contextLength ? contextLength.toLocaleString() + ' tokens' : 'unknown';
    logger.info(`[model] ${model} | params: ${paramSize} | quant: ${quant} | context: ${ctxDisplay}`);

    if (contextLength) {
      global.SkippyModelContextWindow = contextLength;
      const configCap = global.SkippyConfig?.ollama?.context_window;
      if (configCap) {
        logger.info(`[model] Detected context window: ${contextLength.toLocaleString()} tokens — config cap active: ${configCap.toLocaleString()} tokens (effective)`);
      } else {
        logger.info(`[model] Detected context window: ${contextLength.toLocaleString()} tokens (set ollama.context_window in Skippy.json to override)`);
      }
    } else {
      const configCap = global.SkippyConfig?.ollama?.context_window;
      logger.warn(`[model] Could not detect context window from model info — using ${configCap ? 'config: ' + configCap.toLocaleString() : 'default: 1,000,000'} tokens`);
    }

    return info;
  } catch (err) {
    logger.warn(`[model] Could not fetch model info for "${model}": ${err.message}`);
    return null;
  }
}

// List all models available on the Ollama server.
// Returns an array of model objects: [{ name, size, details: { parameter_size, quantization_level } }]
async function listModels() {
  try {
    const ollama = createOllamaClient();
    const result = await ollama.list();
    return result.models ?? [];
  } catch (err) {
    logger.warn(`[listModels] Failed to list models: ${err.message}`);
    return [];
  }
}

// List models with full details (context length, params, quant).
// Calls list() then show() in parallel for each model to get context_length,
// which is not returned by list() alone.
async function listModelsWithDetails() {
  try {
    const ollama = createOllamaClient();
    const result = await ollama.list();
    const models = result.models ?? [];

    const detailed = await Promise.all(models.map(async (m) => {
      try {
        const info = await ollama.show({ model: m.name });
        let contextLength = null;
        if (info.model_info) {
          const ctxKey = Object.keys(info.model_info).find(k => k.endsWith('.context_length'));
          if (ctxKey) contextLength = info.model_info[ctxKey];
        }
        if (!contextLength && info.details?.context_length) {
          contextLength = info.details.context_length;
        }
        return { ...m, contextLength };
      } catch {
        return { ...m, contextLength: null };
      }
    }));

    return detailed;
  } catch (err) {
    logger.warn(`[listModelsWithDetails] Failed: ${err.message}`);
    return [];
  }
}

module.exports = { promptOllama, fetchModelInfo, listModels, listModelsWithDetails };
