// src/core/context.js

const { promptOllama } = require('./ollama-cloud');
// Utility to compress and clean context before sending to promptOllama

/**
 * Compresses and cleans the context string for prompt injection.
 * - Removes duplicate lines
 * - Trims whitespace from each line
 * - Removes empty lines
 * - Optionally truncates to a max length (tokens/chars)
 * @param {string} context
 * @param {object} [options]
 * @param {number} [options.maxLength] - Optional max character length
 * @returns {string}
 */
function compressContext(context, options = {}) {
  if (!context || typeof context !== 'string') return '';
  // Split into lines, trim, deduplicate, remove empty
  const seen = new Set();
  let lines = context
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !seen.has(line) && seen.add(line));
  let result = lines.join('\n');
  if (options.maxLength && result.length > options.maxLength) {
    result = result.slice(-options.maxLength); // Keep the last N chars (most recent context)
  }
  return result;
}

/**
 * Summarizes context using a prompt (LLM) or fallback heuristics.
 * @param {string} context - The context to summarize
 * @param {object} [options] - Optional settings
 * @returns {Promise<string>} - Summarized context
 */
async function summarizeContext(context, options = {}) {
  if (!context || typeof context !== 'string') return '';
  // Fallback: simple deduplication and compression
  let summary = context;
  // Use promptOllama for LLM summarization
  if (typeof promptOllama === 'function') {
    try {
      const summarizationPrompt = (options.prompt || 'Summarize the following context for efficient use in AI prompts. Only include schemas and essential instructions.') + '\n' + summary;
      let summarized = '';
      await promptOllama({ prompt: summarizationPrompt }, (part, done) => {
        if (!done && part && part.trim()) summarized += part;
      });
      summary = summarized.trim() || summary;
    } catch (err) {
      // Fallback to compressed context
    }
  }
  return summary;
}

module.exports = { compressContext, summarizeContext };
