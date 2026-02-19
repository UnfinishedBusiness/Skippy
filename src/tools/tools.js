/**
 * Initializes tools and stores condensed tool context in global.CondensedToolContext
 * Call this early in your app (e.g., in index.js)
 */
const util = require('util');
async function initTools() {
  global.CondensedToolContext = await getCompiledToolsContext();
}
const TOOL_CALL_REGEX = /^\[TOOL_CALL:?\s*(\w+)\s*\]/im;

/**
 * Checks if a response is a tool call.
 * @param {string} response
 * @returns {boolean}
 */

function isToolCall(response) {
  const logger = global.logger || console;
  const result = TOOL_CALL_REGEX.test(response.trim());
  logger.info(`isToolCall: ${result} for response: ${JSON.stringify(response)}`);
  return result;
}

/**
 * Parses the tool call and returns the tool name and the rest of the call.
 * @param {string} response
 * @returns {{ tool: string, body: string } | null}
 */


function parseToolCall(response) {
  const logger = global.logger || console;
  const match = response.trim().match(TOOL_CALL_REGEX);
  if (!match) {
    logger.info('parseToolCall: No tool call found.');
    return null;
  }
  const tool_name = match[1].toLowerCase();
  // Extract instructions between [TOOL_CALL:tool] and [/TOOL_CALL]
  let instructions = response.trim().replace(TOOL_CALL_REGEX, '').trim();
  const endTagIndex = instructions.indexOf('[/TOOL_CALL]');
  if (endTagIndex !== -1) {
    instructions = instructions.substring(0, endTagIndex).trim();
  }
  const instructionsArray = instructions.split('\n').map(line => line.trim()).filter(line => line);
  logger.info(`parseToolCall: tool_name=${tool_name}, tool_instructions=${JSON.stringify(instructionsArray)}`);
  return { tool_name, tool_instructions: instructionsArray };
}




const BashTool = require('./bash/bash');
const FileReadTool = require('./file_read/file_read');
const FileWriteTool = require('./file_write/file_write');
const PatchFileTool = require('./patch_file/patch_file');
const DiscordTool = require('./discord/discord');
const HttpRequestTool = require('./http_request/http_request');
const CronJobsTool = require('./cron_jobs/cron_jobs');
const MemoryTool = require('./memory/memory');
const FileDownloadTool = require('./file_download/file_download');
const WeatherTool = require('./weather/weather');
const TrelloTool = require('./trello/trello');
const WebSearchTool = require('./web_search/web_search');
const PdfTool = require('./pdf/pdf_tool');

// Array of tool instances for registration
const tools = [
  new BashTool(),
  new FileReadTool(),
  new FileWriteTool(),
  new PatchFileTool(),
  new DiscordTool(),
  new HttpRequestTool(),
  new CronJobsTool(),
  new MemoryTool(),
  new FileDownloadTool(),
  new WeatherTool(),
  new TrelloTool(),
  new WebSearchTool(),
  new PdfTool(),
];

// Build a registry for fast lookup by class name (e.g., 'FileWriteTool')
const toolRegistry = Object.fromEntries(
  tools.map(tool => [tool.constructor.name, tool])
);
/**
 * Returns the compiled context from each registered tool's getContext method.
 * @returns {string}
 */
async function getCompiledToolsContext() {
  const logger = global.logger || console;
  let context = '';
  for (const tool of tools) {
    if (typeof tool.init === 'function') {
      await tool.init();
    }
    if (typeof tool.getContext === 'function') {
      const toolContext = tool.getContext();
      if (toolContext && toolContext.trim()) {
        logger.debug(`Loaded context from ${tool.constructor.name}`);
        context += toolContext + '\n';
      }
    }
  }
  // Summarize tool instructions using summarizeContext from context.js
  const { compressContext } = require('../core/context');
  //logger.debug('Summarizing tool context for efficient use in AI prompts... Waiting for prompt completion');
  let summary = await compressContext(context, { prompt: 'Summarize the following tool instructions for efficient use in AI prompts. Only include schemas and essential instructions.' });
  global.CondensedToolContext = summary;
  //logger.debug("Compiled Tools Context (len:" + global.CondensedToolContext.length + "):\n" + global.CondensedToolContext);
  return summary;
}

/**
 * Executes the parsed tool call if supported.
 * @param {{ tool_name: string, tool_instructions: string[] }} parsed
 * @returns {Promise<any>}
 */
async function executeToolCall(parsed) {
  const logger = global.logger || console;
  if (!parsed || !parsed.tool_name) {
    logger.error('executeToolCall: No tool_name provided.');
    return null;
  }
  const tool = toolRegistry[parsed.tool_name];
  if (!tool) {
    logger.warn(`executeToolCall: Unsupported tool: ${parsed.tool_name}`);
    return null;
  }
  logger.info(`executeToolCall: Running ${parsed.tool_name} tool.`);
  // Use buildArgsFromAction if available for dynamic argument mapping
  let args = parsed.tool_instructions;
  if (typeof tool.constructor.buildArgsFromAction === 'function') {
    args = tool.constructor.buildArgsFromAction({ arguments: parsed.tool_instructions });
  }
  return await tool.run(args);
}

module.exports = {
  isToolCall,
  parseToolCall,
  executeToolCall,
  tools,
  toolRegistry,
  getCompiledToolsContext,
  initTools,
};
