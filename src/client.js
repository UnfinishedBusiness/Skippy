/**
 * Skippy client library — use this to talk to a running Skippy daemon from
 * any Node.js script without shelling out to the CLI.
 *
 * Usage:
 *   const skippy = require('./src/client');
 *
 *   // Simple prompt → returns the answer string
 *   const answer = await skippy.prompt('What time is it?');
 *
 *   // With options
 *   const answer = await skippy.prompt('Summarize this', {
 *     context: fileContents,   // extra context prepended to the prompt
 *     model:   'llama3:8b',    // override model for this call
 *   });
 *
 *   // Send result to Discord instead of returning it
 *   await skippy.prompt('Daily report', { output: 'discord', channel: 'general' });
 *
 *   // Send a raw message to Discord (no LLM)
 *   await skippy.message('Build finished ✅', { channel: 'general' });
 *
 *   // Stream tokens as they arrive
 *   await skippy.prompt('Tell me a story', {
 *     onChunk:  (token) => process.stdout.write(token),
 *     onStatus: (line)  => console.error('[status]', line),
 *   });
 */

'use strict';

const { sendIpcRequest } = require('./core/ipc');

/**
 * Send a prompt to the Skippy daemon and return the final answer.
 *
 * @param {string} promptText
 * @param {object} [opts]
 * @param {string}   [opts.context]   - Extra text prepended to the prompt inside <context> tags
 * @param {string}   [opts.model]     - Override the active model for this call only
 * @param {string}   [opts.output]    - 'stdout' (default) or 'discord'
 * @param {string}   [opts.channel]   - Discord channel name (when output='discord')
 * @param {string}   [opts.user]      - Discord username to DM (when output='discord')
 * @param {function} [opts.onChunk]   - Called with each streamed token as it arrives
 * @param {function} [opts.onStatus]  - Called with status/progress lines
 * @returns {Promise<string>}         - Resolves with the final answer text
 */
async function prompt(promptText, opts = {}) {
  if (!promptText || typeof promptText !== 'string') {
    throw new Error('prompt: promptText must be a non-empty string');
  }

  const request = {
    type:    'prompt',
    prompt:  promptText,
    output:  opts.output  || 'stdout',
    channel: opts.channel || null,
    user:    opts.user    || null,
    model:   opts.model   || null,
    context: opts.context || null,
  };

  const result = await sendIpcRequest(request, {
    onChunk:  opts.onChunk,
    onStatus: opts.onStatus,
  });

  return result.content || '';
}

/**
 * Send a raw message directly to Discord (no LLM involved).
 *
 * @param {string} messageText
 * @param {object} [opts]
 * @param {string} [opts.channel]  - Discord channel name
 * @param {string} [opts.user]     - Discord username to DM
 * @returns {Promise<string>}      - Resolves with a confirmation string
 */
async function message(messageText, opts = {}) {
  if (!messageText || typeof messageText !== 'string') {
    throw new Error('message: messageText must be a non-empty string');
  }

  const request = {
    type:    'message',
    message: messageText,
    channel: opts.channel || null,
    user:    opts.user    || null,
  };

  const result = await sendIpcRequest(request);
  return result.content || '';
}

module.exports = { prompt, message };
