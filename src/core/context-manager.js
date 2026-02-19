'use strict';

const fs   = require('fs');
const path = require('path');

const { CONTEXT_FILE } = require('./paths');

function loadContextItems() {
  try {
    if (fs.existsSync(CONTEXT_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    const logger = global.logger || console;
    logger.warn('[context-manager] Failed to load context.json: ' + e.message);
  }
  return [];
}

function saveContextItems() {
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(global.SkippyContextItems || [], null, 2), 'utf8');
}

function getContextItems() {
  return global.SkippyContextItems || [];
}

function addContextItem(item) {
  if (!global.SkippyContextItems) global.SkippyContextItems = [];
  global.SkippyContextItems.push(item);
  saveContextItems();
}

function removeContextItem(index) {
  if (!global.SkippyContextItems || index < 0 || index >= global.SkippyContextItems.length) return false;
  global.SkippyContextItems.splice(index, 1);
  saveContextItems();
  return true;
}

function clearContextItems() {
  global.SkippyContextItems = [];
  saveContextItems();
}

/**
 * Build a text block of all file-type context items for injection into the LLM context.
 * Each file is wrapped in <file path="..."> tags.
 */
function buildFileContextString() {
  const items = getContextItems().filter(i => i.type === 'file');
  if (items.length === 0) return '';
  const logger = global.logger || console;
  let out = '\n## Persistent Context Files\n';
  for (const item of items) {
    try {
      const content = fs.readFileSync(item.path, 'utf8');
      out += `\n<file path="${item.path}">\n${content}\n</file>\n`;
    } catch (e) {
      logger.warn(`[context-manager] Failed to read file "${item.path}": ${e.message}`);
      out += `\n<file path="${item.path}" error="${e.message}" />\n`;
    }
  }
  return out;
}

/**
 * Return all image-type context item paths/URLs.
 * Prompt.js will download/load these alongside per-message attachments.
 */
function getContextImagePaths() {
  return getContextItems()
    .filter(i => i.type === 'image')
    .map(i => i.path);
}

/**
 * Calculate token estimates for all context items (for /context status).
 */
async function getContextStatus() {
  const items = getContextItems();
  let totalChars = 0;
  const breakdown = [];

  for (const item of items) {
    if (item.type === 'file') {
      try {
        const content = fs.readFileSync(item.path, 'utf8');
        const chars = content.length;
        totalChars += chars;
        breakdown.push({ ...item, chars, tokens: Math.round(chars / 4) });
      } catch (e) {
        breakdown.push({ ...item, chars: 0, tokens: 0, error: e.message });
      }
    } else {
      // Images are binary — no char estimate
      breakdown.push({ ...item, chars: null, tokens: null });
    }
  }

  const modelCtx  = global.SkippyModelContextWindow ?? 1_000_000;
  const usedPct   = totalChars > 0 ? ((Math.round(totalChars / 4) / modelCtx) * 100).toFixed(1) : '0.0';

  return {
    itemCount: items.length,
    totalChars,
    estimatedTokens: Math.round(totalChars / 4),
    modelContextWindow: modelCtx,
    usedPercent: usedPct,
    breakdown,
  };
}

module.exports = {
  loadContextItems,
  getContextItems,
  addContextItem,
  removeContextItem,
  clearContextItems,
  buildFileContextString,
  getContextImagePaths,
  getContextStatus,
};
