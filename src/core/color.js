// Color utility for Skippy logging
const color = {
  green:   (text) => `\x1b[32m${text}\x1b[0m`,
  red:     (text) => `\x1b[31m${text}\x1b[0m`,
  magenta: (text) => `\x1b[35m${text}\x1b[0m`,
  cyan:    (text) => `\x1b[36m${text}\x1b[0m`,
  yellow:  (text) => `\x1b[33m${text}\x1b[0m`,
  blue:    (text) => `\x1b[34m${text}\x1b[0m`,
  bold:    (text) => `\x1b[1m${text}\x1b[0m`,
  dim:     (text) => `\x1b[2m${text}\x1b[0m`,
  reset:   (text) => `\x1b[0m${text}`,
};

/**
 * Colorizes a caller string like "core/prompt.js:99" into a styled bracket.
 * Output: [dim][dim-cyan dir][cyan file][dim :][yellow line][dim]]
 */
function colorizeCaller(caller) {
  if (!caller) return '';

  // Split "core/prompt.js:99" → dir="core/", file="prompt.js", line="99"
  const lineMatch = caller.match(/^(.*):(\d+)$/);
  if (!lineMatch) {
    return `\x1b[38;5;240m[\x1b[0m\x1b[90m${caller}\x1b[0m\x1b[38;5;240m]\x1b[0m`;
  }
  const pathPart = lineMatch[1]; // e.g. "core/prompt.js"
  const lineNum  = lineMatch[2]; // e.g. "99"

  const slashIdx = pathPart.lastIndexOf('/');
  const dir      = slashIdx >= 0 ? pathPart.slice(0, slashIdx + 1) : '';
  const filename  = slashIdx >= 0 ? pathPart.slice(slashIdx + 1)  : pathPart;

  return (
    `\x1b[38;5;240m[\x1b[0m`  +         // dim gray [
    `\x1b[2;36m${dir}\x1b[0m`  +         // dim cyan directory
    `\x1b[96m${filename}\x1b[0m` +        // bright cyan filename
    `\x1b[38;5;240m:\x1b[0m`   +         // dim gray :
    `\x1b[33m${lineNum}\x1b[0m` +         // yellow line number
    `\x1b[38;5;240m]\x1b[0m`              // dim gray ]
  );
}

/**
 * Colorizes a log message string.
 * - Separator lines (===) → dimmed
 * - [TAG] prefixes → dim bracket + bright-cyan tag
 * - Quoted strings → green
 * - Numbers → yellow
 * - true/false/null → magenta/red/purple
 * - Absolute paths → blue
 *
 * Safe: splits on existing ANSI codes first so we never re-color escape sequences.
 */
function colorizeMessage(msg) {
  if (!msg || typeof msg !== 'string') return msg;

  // Separator lines (===== ... =====) → whole line dimmed
  if (/^\s*={5,}/.test(msg)) {
    return `\x1b[2m\x1b[90m${msg}\x1b[0m`;
  }

  // First pass on the raw string: replace [TAG] structural labels.
  // e.g. [runPrompt] → dim[ + bright-cyan TAG + dim]
  let result = msg.replace(/\[([A-Za-z][A-Za-z0-9_\s]*)\]/g, (_, tag) =>
    `\x1b[38;5;240m[\x1b[0m\x1b[96m${tag}\x1b[0m\x1b[38;5;240m]\x1b[0m`
  );

  // Split on any ANSI codes already present so we only process raw text segments.
  // Odd-indexed parts are ANSI sequences (from the TAG pass); even-indexed are text.
  const ansiSplit = /(\x1b\[[0-9;]*m)/;
  const parts = result.split(ansiSplit);

  const processed = parts.map((part, idx) => {
    if (idx % 2 === 1) return part; // ANSI code — leave it alone

    let p = part;

    // Absolute file paths → blue (do before numbers to capture path digits)
    p = p.replace(/(\/(?:[\w.\-]+\/)*[\w.\-]+)/g, `\x1b[34m$1\x1b[0m`);

    // Quoted strings → green
    p = p.replace(/"([^"\n]{0,300})"/g, `\x1b[32m"$1"\x1b[0m`);

    // Standalone numbers → yellow
    p = p.replace(/\b(\d+(?:\.\d+)?)\b/g, `\x1b[33m$1\x1b[0m`);

    // Boolean / null keywords → colors
    p = p.replace(/\btrue\b/g,  `\x1b[32mtrue\x1b[0m`);
    p = p.replace(/\bfalse\b/g, `\x1b[31mfalse\x1b[0m`);
    p = p.replace(/\bnull\b/g,  `\x1b[35mnull\x1b[0m`);

    return p;
  });

  return processed.join('');
}

module.exports = { ...color, colorizeCaller, colorizeMessage };
