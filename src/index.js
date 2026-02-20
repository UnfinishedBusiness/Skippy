// Main entry for the daemon
const winston = require('winston');
const process = require('process');
const fs = require('fs');

// All user data lives in ~/.Skippy — exit early if it doesn't exist.
const { SKIPPY_DIR, CONFIG_FILE, LOG_FILE } = require('./core/paths');
if (!fs.existsSync(SKIPPY_DIR)) {
  console.error(`\nSkippy: ~/.Skippy directory not found.\nCreate it and add Skippy.json before starting:\n\n  mkdir ~/.Skippy\n  cp Skippy.example.json ~/.Skippy/Skippy.json\n`);
  process.exit(1);
}
if (!fs.existsSync(CONFIG_FILE)) {
  console.error(`\nSkippy: ~/.Skippy/Skippy.json not found.\nAdd your config file before starting.\n`);
  process.exit(1);
}
global.SkippyConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const { startDiscordHandler, sendDiscordMessage } = require('./core/discord');
const { initTools } = require('./tools/tools');
const { startIpcServer } = require('./core/ipc');
const { fetchModelInfo } = require('./core/ollama-cloud');
const { loadContextItems } = require('./core/context-manager');

// Shared timestamp formatter (returns a plain string, ANSI added per-transport)
function formatTimestamp() {
  const now = new Date();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();
  let hour = now.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  return `[${month} ${day}, ${year} @ ${hour}:${min}:${sec}${ampm}]`;
}

// Strip all ANSI escape codes (for plain file output)
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf((info) => {
    const { colorizeCaller, colorizeMessage } = require('./core/color');
    const ts = `\x1b[38;5;208m${formatTimestamp()}\x1b[0m`;
    let output = `${ts} [${info.level}]`;
    if (info.caller) output += ` ${colorizeCaller(info.caller)}`;
    let rest = typeof info.message === 'string' ? info.message
             : typeof info.message === 'object' && info.message !== null ? JSON.stringify(info.message, null, 2)
             : String(info.message);
    return `${output} ${colorizeMessage(rest)}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.printf((info) => {
    const ts = formatTimestamp();
    // Strip any ANSI that winston.colorize() may have injected into the level string
    const level = stripAnsi(info.level).toUpperCase().padEnd(5);
    let rest = typeof info.message === 'string' ? info.message
             : typeof info.message === 'object' && info.message !== null ? JSON.stringify(info.message, null, 2)
             : String(info.message);
    rest = stripAnsi(rest);
    let output = `${ts} [${level}]`;
    if (info.caller) output += ` (${info.caller})`;
    return `${output} ${rest}`;
  })
);

// Truncate log file at startup so each run starts fresh
fs.writeFileSync(LOG_FILE, '');

// Crash handlers - log uncaught exceptions and unhandled rejections to the log file before exiting
function logCrashToFile(prefix, error) {
  const timestamp = formatTimestamp();
  const stack = error?.stack || String(error);
  const msg = `${timestamp} [${prefix}] (index.js:crash) ${stack}\n`;
  fs.appendFileSync(LOG_FILE, msg);
}

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logCrashToFile('FATAL', err);
  // Also try to log to stderr if possible
  console.error('FATAL: Uncaught exception:', err);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logCrashToFile('FATAL', reason);
  console.error('FATAL: Unhandled rejection:', reason);
  process.exit(1);
});

const isDebug = process.argv.includes('--debug');
const baseLogger = winston.createLogger({
  level: isDebug ? 'debug' : (global.SkippyConfig?.log_level ?? 'info'),
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: LOG_FILE,
      format: fileFormat,
      options: { flags: 'a' }   // file was already truncated above; append from here
    })
  ]
});

// Wrap logger methods to inject file:line
const logger = {};
['info', 'warn', 'error', 'debug', 'verbose'].forEach(level => {
  logger[level] = function(...args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    // Capture the stack from the caller of the logger function
    const orig = Error.prepareStackTrace;
    Error.prepareStackTrace = (_, stack) => stack;
    const err = new Error();
    Error.captureStackTrace(err, logger[level]);
    const stack = err.stack;
    Error.prepareStackTrace = orig;
    let caller = '';
    for (let i = 0; i < stack.length; i++) {
      const fileName = stack[i].getFileName && stack[i].getFileName();
      if (fileName && fileName.includes('src/')) {
        const file = fileName.split('/').slice(-2).join('/');
        caller = `${file}:${stack[i].getLineNumber()}`;
        break;
      }
    }
    baseLogger.log({ level, message: msg, caller });
  };
});
global.logger = logger;


function handleDiscordMessage(message) {
  // Custom logic for received messages (if any)
}

function resolveDiscordTarget(req) {
  const cfg = global.SkippyConfig?.discord || {};
  const target     = req.channel ? req.channel : (req.user || cfg.default_user);
  const targetType = req.channel ? 'channel' : 'user';
  return { target, targetType };
}

async function handleIpcRequest(req, conn) {
  const { runPrompt } = require('./core/prompt');
  logger.info(`[IPC] Received request: type=${req.type}`);

  // --- Direct Discord message (no LLM) ---
  if (req.type === 'message') {
    if (!req.message) {
      conn.send({ type: 'error', message: 'Missing message field' });
      conn.end();
      return;
    }
    const { target, targetType } = resolveDiscordTarget(req);
    if (!target) {
      conn.send({ type: 'error', message: 'No target specified and no default_user in config' });
      conn.end();
      return;
    }
    try {
      await sendDiscordMessage({ targetType, target, message: req.message });
      conn.send({ type: 'done', content: `Sent to Discord ${targetType}: ${target}` });
    } catch (e) {
      conn.send({ type: 'error', message: `Discord send failed: ${e.message}` });
    }
    conn.end();
    return;
  }

  // --- Prompt (LLM) ---
  if (req.type !== 'prompt') {
    conn.send({ type: 'error', message: `Unknown request type: ${req.type}` });
    conn.end();
    return;
  }

  if (!req.prompt) {
    conn.send({ type: 'error', message: 'Missing prompt field' });
    conn.end();
    return;
  }

  try {
    await runPrompt({ prompt: req.prompt, model: req.model || undefined, extraContext: req.context || undefined }, async (result, isDone) => {
      if (!isDone) return;

      const answer = result?.last_response?.final_answer || '';

      if (req.output === 'discord') {
        const { target, targetType } = resolveDiscordTarget(req);
        if (!target) {
          conn.send({ type: 'error', message: 'No discord target specified and no default_user in config' });
          conn.end();
          return;
        }
        try {
          await sendDiscordMessage({ targetType, target, message: answer });
          conn.send({ type: 'done', content: `Sent to Discord ${targetType}: ${target}` });
        } catch (e) {
          conn.send({ type: 'error', message: `Discord send failed: ${e.message}` });
        }
      } else {
        // stdout — send the answer back to the CLI
        conn.send({ type: 'done', content: answer });
      }

      conn.end();
    });
  } catch (err) {
    logger.error(`[IPC] Prompt error: ${err.message}`);
    conn.send({ type: 'error', message: err.message });
    conn.end();
  }
}

(async () => {
  await initTools();
  await fetchModelInfo();
  global.SkippyContextItems = loadContextItems();
  logger.info(`Daemon started. Loaded ${global.SkippyContextItems.length} persistent context item(s).`);
  try {
    startDiscordHandler(handleDiscordMessage);
    logger.info('Discord handler started.');
  } catch (e) {
    logger.error('Failed to start Discord handler: ' + e.message);
  }
  startIpcServer(handleIpcRequest);
})();
