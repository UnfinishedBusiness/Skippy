#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT  = path.join(__dirname, '..');
const ENTRY = path.join(__dirname, 'index.js');
const { LOG_FILE, PID_FILE } = require('./core/paths');

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

function print(msg)  { process.stdout.write(msg + '\n'); }
function ok(msg)     { print(`${c.green}✔${c.reset}  ${msg}`); }
function warn(msg)   { print(`${c.yellow}⚠${c.reset}  ${msg}`); }
function err(msg)    { print(`${c.red}✖${c.reset}  ${msg}`); }
function info(msg)   { print(`${c.cyan}→${c.reset}  ${msg}`); }

// Returns the PID from daemon.pid, or null if not present / not a number.
function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

// Returns true if the process with this PID is alive.
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writePid(pid) {
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function clearPid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ---- Commands ----

function cmdStart(debug) {
  // In debug mode: run in the foreground, inherit stdio, no PID file.
  if (debug) {
    print(`${c.cyan}${c.bold}Skippy${c.reset} ${c.gray}[debug — press Ctrl+C to stop]${c.reset}`);
    const child = spawn(process.execPath, [ENTRY, '--debug'], { stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
    return;
  }

  // Daemon mode: check for existing process first.
  const existing = readPid();
  if (existing && isAlive(existing)) {
    warn(`Already running (PID ${existing}). Use ${c.yellow}./skippy restart${c.reset} to restart.`);
    process.exit(1);
  }

  // Spawn detached, inheriting nothing — logs go to Skippy.log via index.js.
  const child = spawn(process.execPath, [ENTRY], {
    detached: true,
    stdio:    'ignore',
    cwd:      ROOT,
  });

  writePid(child.pid);
  child.unref();

  ok(`Daemon started  ${c.gray}(PID ${child.pid})${c.reset}`);
  info(`Logs → ${c.gray}${LOG_FILE}${c.reset}`);
}

// Kill all running index.js processes (daemon or --debug), returns count killed.
function killAllInstances() {
  const { execSync } = require('child_process');
  let killed = 0;
  try {
    const out = execSync(`pgrep -f "node.*Skippy/src/index\\.js"`, { encoding: 'utf8' }).trim();
    const pids = out.split('\n').map(Number).filter(p => p && p !== process.pid);
    for (const p of pids) {
      try { process.kill(p, 'SIGTERM'); killed++; } catch {}
    }
  } catch {}  // pgrep exits non-zero if no matches
  return killed;
}

function cmdStop() {
  const pid = readPid();
  const killed = killAllInstances();
  clearPid();
  if (killed === 0 && !pid) {
    warn('No running Skippy processes found.');
    process.exit(1);
  }
  ok(`Stopped ${killed} process(es).`);
}

function cmdRestart() {
  const killed = killAllInstances();
  clearPid();
  if (killed > 0) {
    ok(`Stopped ${killed} process(es).`);
  } else {
    info('No running Skippy found — starting fresh.');
  }
  // Brief pause so old processes can release connections.
  setTimeout(() => cmdStart(false), 500);
}

// Parse flags out of an argv slice, returns { flags, positional }
// e.g. ["--output", "discord", "--user", "travis", "hello world"]
//   → { flags: { output: "discord", user: "travis" }, positional: ["hello world"] }
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < argv.length) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positional.push(argv[i]);
      i++;
    }
  }
  return { flags, positional };
}

// Read all of stdin if it's a pipe (non-TTY). Returns null if stdin is a terminal.
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      resolve(text || null);
    });
    process.stdin.on('error', () => resolve(null));
  });
}

async function cmdPrompt(argv) {
  const { sendIpcRequest } = require('./core/ipc');
  const { flags, positional } = parseFlags(argv);

  const promptText = positional.join(' ').trim();
  if (!promptText) {
    err('No prompt text provided.');
    print(`  Example: ${c.bold}./skippy prompt "What time is it?"${c.reset}`);
    process.exit(1);
  }

  const output  = flags.output  || 'stdout';
  const channel = flags.channel ? String(flags.channel).replace(/^#/, '') : null;
  const user    = flags.user    || null;
  const model   = flags.model   || null;

  // --context flag takes priority over stdin pipe
  const stdinContent = await readStdin();
  const context = flags.context || stdinContent || null;
  if (context) {
    info(`Context: ${context.length} chars${stdinContent && !flags.context ? ' (from stdin)' : ''}`);
  }

  if (output === 'discord' && !channel && !user) {
    // No target specified — daemon will fall back to config default_user
    info('No --channel or --user specified; will use discord.default_user from config.');
  }

  const request = { type: 'prompt', prompt: promptText, output, channel, user, model, context };

  try {
    const result = await sendIpcRequest(request, {
      onStatus: (s) => process.stderr.write(`${c.gray}${s}${c.reset}\n`),
    });

    if (output === 'stdout') {
      process.stdout.write((result.content || '') + '\n');
    } else {
      ok(result.content || 'Sent.');
    }
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

async function cmdDiscord(argv) {
  const { sendIpcRequest } = require('./core/ipc');
  const { flags, positional } = parseFlags(argv);

  const message = positional.join(' ').trim();
  if (!message) {
    err('No message text provided.');
    print(`  Example: ${c.bold}./skippy discord "Hello from the terminal"${c.reset}`);
    process.exit(1);
  }

  const channel = flags.channel ? String(flags.channel).replace(/^#/, '') : null;
  const user    = flags.user    || null;

  const request = { type: 'message', message, channel, user };

  try {
    const result = await sendIpcRequest(request);
    ok(result.content || 'Sent.');
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

// Colorize a single log line to match ./skippy start --debug output exactly.
// File format: [Feb 18, 2026 @ 11:17:47PM] [INFO ] (core/file.js:12) message
function colorizeLogLine(line) {
  const { colorizeCaller, colorizeMessage } = require('./core/color');
  const match = line.match(/^(\[[^\]]+\]) (\[[^\]]+\]) \(([^)]+)\) (.*)$/);
  if (!match) return line;
  const [, timestamp, level, caller, message] = match;

  // Orange timestamp — same \x1b[38;5;208m used by consoleFormat in index.js
  const ts = `\x1b[38;5;208m${timestamp}\x1b[0m`;

  // Level colors matching winston's defaults
  const tag = level.replace(/[\[\]\s]/g, '');
  let levelColored;
  switch (tag) {
    case 'ERROR': levelColored = `\x1b[31m${level}\x1b[0m`; break; // red
    case 'WARN':  levelColored = `\x1b[33m${level}\x1b[0m`; break; // yellow
    case 'DEBUG': levelColored = `\x1b[34m${level}\x1b[0m`; break; // blue
    default:      levelColored = `\x1b[32m${level}\x1b[0m`; break; // green (INFO)
  }

  return `${ts} ${levelColored} ${colorizeCaller(caller)} ${colorizeMessage(message)}`;
}

function cmdLog(follow) {
  if (!fs.existsSync(LOG_FILE)) {
    warn('No log file found at ' + LOG_FILE);
    process.exit(1);
  }

  if (follow) {
    print(`${c.cyan}→${c.reset}  Following ${c.gray}${LOG_FILE}${c.reset}  ${c.gray}(Ctrl+C to stop)${c.reset}`);
    const child = spawn('tail', ['-f', LOG_FILE], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    child.stdout.on('data', data => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // hold incomplete trailing line
      for (const line of lines) {
        process.stdout.write(colorizeLogLine(line) + '\n');
      }
    });
    child.on('exit', code => process.exit(code ?? 0));
    process.on('SIGINT', () => { child.kill('SIGINT'); process.exit(0); });
  } else {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    for (const line of lines) {
      if (line) process.stdout.write(colorizeLogLine(line) + '\n');
    }
  }
}

function cmdHelp() {
  print('');
  print(`${c.cyan}${c.bold}Skippy${c.reset}`);
  print('');
  print(`${c.yellow}Usage:${c.reset}`);
  print(`  ${c.bold}./skippy start${c.reset}                                      Start as a background daemon`);
  print(`  ${c.bold}./skippy start --debug${c.reset}                              Run in the foreground with live output`);
  print(`  ${c.bold}./skippy stop${c.reset}                                       Stop the running daemon`);
  print(`  ${c.bold}./skippy restart${c.reset}                                    Stop and restart the daemon`);
  print(`  ${c.bold}./skippy prompt${c.reset} ${c.yellow}"message"${c.reset}                                   Send a prompt, print result to stdout`);
  print(`  ${c.bold}./skippy prompt${c.reset} ${c.yellow}--context <text> "message"${c.reset}                  Attach extra context to the prompt`);
  print(`  ${c.bold}cat file | ./skippy prompt${c.reset} ${c.yellow}"message"${c.reset}                         Pipe content as context`);
  print(`  ${c.bold}./skippy prompt${c.reset} ${c.yellow}--model <name> "message"${c.reset}                    Use a specific model for this prompt`);
  print(`  ${c.bold}./skippy prompt${c.reset} ${c.yellow}--output discord "message"${c.reset}                  Send prompt result to Discord (DM default_user)`);
  print(`  ${c.bold}./skippy prompt${c.reset} ${c.yellow}--output discord --user <u> "msg"${c.reset}           Send prompt result as DM to a user`);
  print(`  ${c.bold}./skippy prompt${c.reset} ${c.yellow}--output discord --channel <c> "msg"${c.reset}        Send prompt result to a channel`);
  print(`  ${c.bold}./skippy discord${c.reset} ${c.yellow}"message"${c.reset}                         Send a message directly to Discord (DM default_user)`);
  print(`  ${c.bold}./skippy discord${c.reset} ${c.yellow}--user <u> "message"${c.reset}              DM a specific user directly`);
  print(`  ${c.bold}./skippy discord${c.reset} ${c.yellow}--channel <c> "message"${c.reset}           Post directly to a channel`);
  print(`  ${c.bold}./skippy log${c.reset}                                        Print the daemon log`);
  print(`  ${c.bold}./skippy log --follow${c.reset}                               Follow the log live (like tail -f)`);
  print(`  ${c.bold}./skippy --help${c.reset}                                     Show this message`);
  print('');
}

// ---- Dispatch ----

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'start':   cmdStart(rest.includes('--debug')); break;
  case 'stop':    cmdStop(); break;
  case 'restart': cmdRestart(); break;
  case 'prompt':  cmdPrompt(rest); break;
  case 'discord': cmdDiscord(rest); break;
  case 'log':     cmdLog(rest.includes('--follow')); break;
  case '--help':
  case 'help':
  case undefined: cmdHelp(); break;
  default:
    err(`Unknown command: ${cmd}`);
    cmdHelp();
    process.exit(1);
}
