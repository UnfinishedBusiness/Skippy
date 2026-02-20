const fs = require('fs');
const util = require('util');
const { promptOllama } = require('./ollama-cloud');
const os = require('os');

const { executeToolCall, toolRegistry } = require('../tools/tools');
const { compressContext } = require('./context');
const { buildFileContextString, getContextImagePaths } = require('./context-manager');

// Import the enhanced Discord functions
const { sendStatusUpdate, sendDiscordReasoning } = require('./discord');

const SYSTEM_PROMPT = `RESPOND WITH JSON. For FileWriteTool and PatchFileTool, file content follows the JSON in special blocks — see FILE CONTENT PROTOCOL below.

STRICT RULE: Your response must start with a single valid JSON object. For FileWriteTool and PatchFileTool ONLY, content blocks follow AFTER the JSON closing brace.

Format: {"reasoning":"","actions":[],"final_answer":"","continue":false}

## MANDATORY TOOL CALL FORMAT
When calling tools, use EXACTLY this format:
{
  "type": "tool_call",
  "tool": "ToolName",
  "arguments": {...},
  "reasoning": "Why you need this"
}

## FILE CONTENT PROTOCOL (MANDATORY — read carefully)

**NEVER put file content or patch text inside the JSON.** JSON encoding of multi-line code causes errors.
Instead, omit "content" / "changes" from the JSON arguments and place the content in blocks AFTER the JSON.

### Writing a whole file (FileWriteTool):
Only put the filepath in arguments. Put the actual content after the JSON:

{"reasoning":"...","actions":[{"type":"tool_call","tool":"FileWriteTool","arguments":{"filepath":"/path/to/file.js"},"reasoning":"..."}],"final_answer":"","continue":true}
===SKIPPY_FILE_START:/path/to/file.js===
your file content here — verbatim, no escaping needed
===SKIPPY_FILE_END===

### Patching a file (PatchFileTool):
Only put the filepath in arguments. Put the find/replace pairs after the JSON:

{"reasoning":"...","actions":[{"type":"tool_call","tool":"PatchFileTool","arguments":{"filepath":"/path/to/file.js"},"reasoning":"..."}],"final_answer":"","continue":true}
===SKIPPY_PATCH_START:/path/to/file.js===
===FIND===
exact text to find (copy it exactly as it appears in the file)
===REPLACE===
replacement text
===SKIPPY_PATCH_END===

For multiple patches on one file, add more ===FIND===/===REPLACE=== pairs inside the same ===SKIPPY_PATCH_START/END=== block.

## TOOL USAGE RULES:

1. **ALWAYS USE TOOLS WHEN TASK REQUIRES THEM**
   - Don't ask for clarification - use available tools to complete the task
   - If you need to schedule something → use CronJobsTool
   - If you need to send messages → use DiscordTool
   - If you need to run commands → use BashTool or CronJobsTool with bash action

2. **FOR CRON JOB REQUESTS:**
   - User says "in 1 minute do X" → use CronJobsTool with delay: 60
   - Schedule the job, don't ask for clarification
   - Use bash actions for command execution
   - Use prompt actions for text processing

3. **FOR COMPLEX TASKS:**
   - Break into steps using multiple tool calls
   - Chain actions: schedule job → wait → process results → send message
   - NEVER ask the user for information you can infer or find

## RESPONSE FLOW:

1. **NEED TOOLS?**
   - actions=[tool_calls], continue=true, final_answer=""

2. **HAVE RESULTS OR CAN ANSWER**
   - actions=[], continue=false, final_answer="response"

3. **AFTER SUCCESSFUL TOOLS**
   - actions=[], continue=false, final_answer="completion message"

## VALIDATION (MANDATORY):
□ Response starts with valid JSON
□ FileWriteTool/PatchFileTool: NO content/changes in JSON arguments — use file blocks after the JSON
□ If tools needed: continue=true, final_answer=""
□ If done: continue=false with final_answer message
□ Tool calls have "type": "tool_call" wrapper
□ No questions or clarification requests

JSON:`;

// Time context function
function getCurrentTimeContext() {
    const now = new Date();
    return {
        current_time: now.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: now.getTime(),
        human_readable: now.toString()
    };
}

function getCwdContext() {
  const cwd = process.cwd();
  let dirList = [];
  try {
    dirList = fs.readdirSync(cwd, { withFileTypes: true })
      .map(dirent => dirent.isDirectory() ? dirent.name + '/' : dirent.name);
  } catch (e) {
    dirList = ['<error reading directory>'];
  }
  return `Current working directory: ${cwd}
Contents:
${dirList.join('\n')}`;
}

// Section labels shown in the context block for each memory category.
const CATEGORY_LABELS = {
  agent:       'Agent Behaviors',
  preferences: 'User Preferences',
  user_info:   'User Info',
};

// Queries MemoryTool for global memories in the configured context_categories and
// injects them into the system prompt grouped by category. Categories and their
// labels are configurable via Skippy.json memory.context_categories.
async function buildMemoryContext() {
  const logger = global.logger || console;
  try {
    const memTool = toolRegistry['MemoryTool'];
    if (!memTool) return '';

    const categories = global.SkippyConfig?.memory?.context_categories ?? ['agent', 'preferences', 'user_info'];
    const grouped = await memTool.getContextMemories(categories);
    if (!grouped || Object.keys(grouped).length === 0) return '';

    let totalCount = 0;
    let out = '\n## Memory Context\n';
    for (const category of categories) {
      const entries = grouped[category];
      if (!entries || entries.length === 0) continue;
      const label = CATEGORY_LABELS[category] || category;
      out += `\n### ${label}\n`;
      for (const m of entries) {
        out += `- ${m.key}: ${typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}\n`;
        totalCount++;
      }
    }

    logger.debug(`[buildMemoryContext] Injecting ${totalCount} memories across categories: ${categories.join(', ')}`);
    return out;
  } catch (err) {
    logger.warn(`[buildMemoryContext] Failed to load memory context: ${err.message}`);
    return '';
  }
}

// Injects skill names and descriptions visible to `username` (global + user-owned)
// into the system context so the LLM knows which skills exist without loading full data.
async function buildSkillContext(username) {
  const logger = global.logger || console;
  try {
    const memTool = toolRegistry['MemoryTool'];
    if (!memTool) return '';
    const skills = await memTool.getContextSkills(username);
    if (!skills || skills.length === 0) return '';
    let out = '\n## Available Skills\n';
    for (const s of skills) {
      const scope = s.owner === 'global' ? 'global' : `private:${s.owner}`;
      out += `- **${s.name}** [${scope}]: ${s.description || 'no description'}\n`;
      if (s.instructions) {
        out += `  > Instructions: ${s.instructions}\n`;
      }
    }
    logger.debug(`[buildSkillContext] Injecting ${skills.length} skills for user: ${username}`);
    return out;
  } catch (err) {
    logger.warn(`[buildSkillContext] Failed to load skill context: ${err.message}`);
    return '';
  }
}

// Injects the list of known channel names so the LLM uses exact names, not guesses.
async function buildChannelContext() {
  const logger = global.logger || console;
  try {
    const memTool = toolRegistry['MemoryTool'];
    if (!memTool) return '';
    const result = await memTool.listChannels();
    if (!result.success || !result.channels || result.channels.length === 0) return '';
    return `\n## Known Channel Names\nUse these exact names for channel memory operations: ${result.channels.join(', ')}\n`;
  } catch (err) {
    logger.warn(`[buildChannelContext] Failed to load channel list: ${err.message}`);
    return '';
  }
}

/**
 * Normalizes a parsed JSON value into the expected response shape:
 *   { reasoning, actions, final_answer, continue }
 *
 * Handles two common model misbehaviours:
 *  1. Array of action objects: [{tool, arguments, reasoning}]
 *     → wraps into { actions: [...normalized], continue: true }
 *  2. Flat single action object: {tool, arguments, reasoning}
 *     → wraps into { actions: [action], continue: true }
 */
function normalizeResponse(parsed) {
  const logger = global.logger || console;
  if (!parsed || typeof parsed !== 'object') return parsed;

  // Already the expected shape — has at least one canonical key
  if ('actions' in parsed || 'final_answer' in parsed || 'continue' in parsed) {
    if (Array.isArray(parsed.actions)) {
      // Fields that belong on the action wrapper, not inside arguments
      const ACTION_META_KEYS = new Set(['type', 'tool', 'arguments', 'reasoning']);

      parsed.actions = parsed.actions.map(action => {
        let normalized = { ...action };

        // Fix type: missing or set to the tool name instead of 'tool_call'
        if (!normalized.type || normalized.type !== 'tool_call') {
          if (normalized.type && normalized.type !== 'tool_call') {
            logger.warn(`[normalizeResponse] Action type "${normalized.type}" is not "tool_call" — treating as tool name`);
            normalized.tool = normalized.tool || normalized.type;
          }
          normalized.type = 'tool_call';
        }

        // Fix flattened args: model put op/key/value etc. directly on the action
        // instead of nesting them under arguments. Collect non-meta keys into arguments.
        if (!normalized.arguments && normalized.tool) {
          const flatArgs = {};
          for (const k of Object.keys(normalized)) {
            if (!ACTION_META_KEYS.has(k)) flatArgs[k] = normalized[k];
          }
          if (Object.keys(flatArgs).length > 0) {
            logger.warn(`[normalizeResponse] Action "${normalized.tool}" has flattened args — promoting to arguments: ${Object.keys(flatArgs).join(', ')}`);
            normalized.arguments = flatArgs;
            for (const k of Object.keys(flatArgs)) delete normalized[k];
          }
        }

        return normalized;
      });

      // If there are pending tool calls but no final answer and continue=false,
      // the model forgot to set continue=true — fix it so the loop runs the tools.
      const hasPendingTools = parsed.actions.some(a => a.type === 'tool_call' && a.tool);
      if (hasPendingTools && !parsed.final_answer && !parsed.continue) {
        logger.warn('[normalizeResponse] Actions present but continue=false and no final_answer — setting continue=true');
        parsed.continue = true;
      }
    }
    return parsed;
  }

  // Array of action objects: [{tool, arguments, ...}]
  if (Array.isArray(parsed)) {
    logger.warn('[normalizeResponse] Got array of actions, wrapping into expected shape');
    return {
      reasoning: parsed[0]?.reasoning || '',
      actions: parsed.map(item => ({
        type: 'tool_call',
        tool: item.tool,
        arguments: item.arguments,
        reasoning: item.reasoning || ''
      })),
      final_answer: '',
      continue: true
    };
  }

  // Flat single action object: {tool, arguments, reasoning}
  if ('tool' in parsed && 'arguments' in parsed) {
    logger.warn('[normalizeResponse] Got flat action object, wrapping into expected shape');
    return {
      reasoning: parsed.reasoning || '',
      actions: [{
        type: 'tool_call',
        tool: parsed.tool,
        arguments: parsed.arguments,
        reasoning: parsed.reasoning || ''
      }],
      final_answer: '',
      continue: true
    };
  }

  return parsed;
}

// ULTRA-ROBUST JSON EXTRACTION - handles malformed JSON with embedded newlines
function extractFirstJson(text) {
  const logger = global.logger || console;
  
  if (!text || typeof text !== 'string') {
    logger.error('[extractFirstJson] Invalid input: not a string or empty');
    return null;
  }

  const originalText = text;
  let workingText = text;
  
  logger.debug(`[extractFirstJson] Input text length: ${text.length}`);
  logger.debug(`[extractFirstJson] Input preview: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);

  // Step 1: Clean up common formatting issues
  workingText = workingText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*$/gi, '')
    .replace(/^```\s*/gi, '')
    // Strip model-specific XML wrappers: <minimax:tool_call>, <tool_call>, etc.
    .replace(/<[a-zA-Z][a-zA-Z0-9_:.-]*>\s*/g, '')
    .replace(/\s*<\/[a-zA-Z][a-zA-Z0-9_:.-]*>/g, '')
    .replace(/^\s+|\s+$/g, '');

  logger.debug(`[extractFirstJson] After cleanup length: ${workingText.length}`);

  // Step 4: Try direct JSON.parse first
  try {
    const parsed = JSON.parse(workingText);
    logger.info('[extractFirstJson] ✅ Direct JSON.parse succeeded');
    
    // JSON structure validation - this was referencing a non-existent function
    // The parsing itself validated the JSON structure, so we can proceed
    logger.debug('[extractFirstJson] Direct JSON.parse succeeded, structure validated by parsing');
    return normalizeResponse(parsed);
  } catch (e) {
    logger.debug(`[extractFirstJson] Direct parse failed: ${e.message}`);
  }

  // Step 3: Find potential JSON start positions ({ or [)
  const potentialStarts = [];
  for (let i = 0; i < Math.min(workingText.length - 1, 5000); i++) {
    const ch = workingText[i];
    const next = workingText[i + 1];
    if ((ch === '{' && next === '"') || (ch === '[' && (next === '{' || next === '"'))) {
      potentialStarts.push(i);
    }
  }

  logger.debug(`[extractFirstJson] Found ${potentialStarts.length} potential JSON start positions`);

  // Step 4: Try each potential start with robust parsing
  for (let attempt = 0; attempt < potentialStarts.length; attempt++) {
    const startIndex = potentialStarts[attempt];
    const result = tryParseFromPositionRobust(workingText, startIndex);
    
    if (result.success) {
      logger.info(`[extractFirstJson] ✅ Successfully parsed JSON from position ${startIndex} (attempt ${attempt + 1})`);
      return normalizeResponse(result.data);
    } else {
      logger.debug(`[extractFirstJson] Attempt ${attempt + 1} failed: ${result.error}`);
    }
  }

  // Step 5: Emergency extraction - try to fix common JSON issues
  const emergencyResult = tryEmergencyJsonExtraction(workingText);
  if (emergencyResult.success) {
    logger.info('[extractFirstJson] ✅ Emergency extraction succeeded');
    return normalizeResponse(emergencyResult.data);
  }

  // Step 6: Last resort - look for any { and try to parse from there
  const fallbackStart = workingText.indexOf('{');
  if (fallbackStart !== -1 && fallbackStart < workingText.length - 10) {
    logger.warn('[extractFirstJson] Using fallback method - trying to parse from first {');
    const result = tryParseFromPositionRobust(workingText, fallbackStart);
    if (result.success) {
      logger.info('[extractFirstJson] ✅ Fallback method succeeded');
      return normalizeResponse(result.data);
    }
  }

  // Step 7: Escalating retry mechanism - try progressively stricter constraints
  function tryStricterParsing(text, attempt) {
    if (attempt === 1) return text; // Normal parsing
    if (attempt === 2) return text.replace(/^[^{]*/, ''); // Strip leading non-JSON
    if (attempt === 3) return text.split(/[{}]/).slice(0, 3).join(''); // Extract core JSON structure
    return text; // Fallback
  }

  for (let retryAttempt = 2; retryAttempt <= 3; retryAttempt++) {
    logger.debug(`[extractFirstJson] Retry attempt ${retryAttempt} with stricter parsing`);
    const retryText = tryStricterParsing(workingText, retryAttempt);
    const result = tryParseFromPositionRobust(retryText, 0);
    if (result.success) {
      logger.info(`[extractFirstJson] ✅ Retry attempt ${retryAttempt} succeeded`);
      return normalizeResponse(result.data);
    }
  }

  // Step 8: Log detailed diagnostic info
  logger.error('[extractFirstJson] ❌ All extraction methods failed');
  logger.error(`[extractFirstJson] Original text length: ${originalText.length}`);
  logger.error(`[extractFirstJson] Working text length: ${workingText.length}`);
  logger.error(`[extractFirstJson] Original preview: "${originalText.substring(0, 200)}${originalText.length > 200 ? '...' : ''}"`);
  logger.error(`[extractFirstJson] Working preview: "${workingText.substring(0, 200)}${workingText.length > 200 ? '...' : ''}"`);
  
  if (originalText.length < 2000) {
    logger.error(`[extractFirstJson] Full original text: "${originalText}"`);
  }
  
  if (workingText.length < 2000) {
    logger.error(`[extractFirstJson] Full working text: "${workingText}"`);
  }

  return null;
}

// Enhanced robust parser that can handle embedded newlines and common issues
function tryParseFromPositionRobust(text, startIndex) {
  const logger = global.logger || console;
  
  try {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let endIndex = -1;
    let lastValidIndex = startIndex;
    const bracketStack = []; // tracks expected closing chars for repair

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      // Handle escape sequences
      if (escaped) {
        escaped = false;
        lastValidIndex = i;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        lastValidIndex = i;
        continue;
      }

      // Handle string literals
      if (char === '"' && !escaped) {
        inString = !inString;
        lastValidIndex = i;
        continue;
      }

      // Count both braces and brackets outside of strings
      if (!inString) {
        if (char === '{') {
          depth++;
          bracketStack.push('}');
          lastValidIndex = i;
        } else if (char === '[') {
          depth++;
          bracketStack.push(']');
          lastValidIndex = i;
        } else if (char === '}' || char === ']') {
          depth--;
          bracketStack.pop();
          if (depth === 0) {
            endIndex = i + 1;
            break;
          }
          lastValidIndex = i;
        }
      } else {
        // We're in a string - track the last valid position
        lastValidIndex = i;
      }

      // Safety checks
      if (depth < 0) {
        return { success: false, error: 'Invalid JSON structure: unmatched closing brace' };
      }

      if (depth > 100) {
        return { success: false, error: 'JSON too deeply nested (>100 levels)' };
      }

      if ((i - startIndex) > 100000) {
        return { success: false, error: 'JSON parsing exceeded 100k character limit' };
      }
    }

    if (endIndex === -1) {
      // JSON is truncated — try to repair by closing open brackets
      if (depth > 0 && bracketStack.length > 0) {
        let truncated = text.slice(startIndex);
        // Strip any trailing incomplete string literal or dangling comma/colon/whitespace
        truncated = truncated
          .replace(/"[^"\\]*$/, '')       // remove trailing unclosed string
          .replace(/[:,\s]+$/, '');        // remove trailing punctuation
        const closing = bracketStack.slice().reverse().join('');
        try {
          const repaired = JSON.parse(truncated + closing);
          logger.warn(`[tryParseFromPositionRobust] Repaired truncated JSON (appended "${closing}")`);
          return { success: true, data: repaired };
        } catch (repairErr) {
          logger.debug(`[tryParseFromPositionRobust] Repair attempt failed: ${repairErr.message}`);
        }
      }
      // Last resort: find the last complete closing brace
      let lastBrace = text.lastIndexOf('}', text.length);
      if (lastBrace > startIndex && lastBrace < text.length) {
        endIndex = lastBrace + 1;
      } else {
        return { success: false, error: 'No matching closing brace found' };
      }
    }

    let jsonStr = text.slice(startIndex, endIndex);
    
    // Try to fix common JSON issues
    jsonStr = jsonStr
      .replace(/,\s*}/g, '}')  // Remove trailing commas
      .replace(/,\s*]/g, ']')  // Remove trailing array commas
      .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');  // Quote unquoted keys
      // Note: removed problematic escaping that could break valid content
    
    if (jsonStr.length > 50000) {
      return { success: false, error: 'JSON too large (>50k characters)' };
    }

    const parsed = JSON.parse(jsonStr);
    
    // Validate structure has expected fields
    if (parsed && typeof parsed === 'object') {
      const hasExpectedFields = 
        'reasoning' in parsed || 
        'actions' in parsed || 
        'final_answer' in parsed ||
        'continue' in parsed;
      
      if (!hasExpectedFields) {
        logger.warn(`[extractFirstJson] Parsed JSON but missing expected fields. Keys: ${Object.keys(parsed).join(', ')}`);
      }
    }

    return { success: true, data: parsed };
    
  } catch (e) {
    return { success: false, error: `JSON.parse failed: ${e.message}` };
  }
}

// Emergency JSON extraction for severely malformed responses
function tryEmergencyJsonExtraction(text) {
  const logger = global.logger || console;
  
  try {
    // Try to extract the main JSON structure by looking for balanced braces
    const firstBrace = text.indexOf('{');
    if (firstBrace === -1) {
      return { success: false, error: 'No opening brace found' };
    }

    let braceCount = 0;
    let inString = false;
    let escaped = false;
    let endPos = -1;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') {
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            endPos = i;
            break;
          }
        }
      }
    }

    if (endPos === -1) {
      return { success: false, error: 'Could not find matching closing brace' };
    }

    // Extract the JSON-like content
    let jsonContent = text.substring(firstBrace, endPos + 1);
    
    // Try to fix common issues and parse
    jsonContent = jsonContent
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']');

    // If it's still malformed, try to extract the essential parts manually
    try {
      const parsed = JSON.parse(jsonContent);
      return { success: true, data: parsed };
    } catch (e) {
      logger.warn('[tryEmergencyJsonExtraction] Standard parse failed, trying manual extraction');
      return tryManualJsonExtraction(text);
    }

  } catch (e) {
    return { success: false, error: `Emergency extraction failed: ${e.message}` };
  }
}

// Manual extraction for severely broken JSON
function tryManualJsonExtraction(text) {
  const logger = global.logger || console;
  
  try {
    // Try to manually extract the key fields we need
    const result = {};
    
    // Extract reasoning
    const reasoningMatch = text.match(/"reasoning"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
    if (reasoningMatch) {
      result.reasoning = reasoningMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    
    // Extract final_answer
    const finalAnswerMatch = text.match(/"final_answer"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
    if (finalAnswerMatch) {
      result.final_answer = finalAnswerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
    }
    
    // Extract continue
    const continueMatch = text.match(/"continue"\s*:\s*(true|false)/);
    if (continueMatch) {
      result.continue = continueMatch[1] === 'true';
    }
    
    // Extract actions (simplified)
    const actionsMatch = text.match(/"actions"\s*:\s*\[([^\]]*)\]/);
    if (actionsMatch) {
      result.actions = [];
      // This is a simplified extraction - just get the basic structure
      const actionsText = actionsMatch[1];
      const actionMatches = actionsText.match(/\{[^}]*\}/g);
      if (actionMatches) {
        for (const actionText of actionMatches) {
          const action = {};
          const toolMatch = actionText.match(/"tool"\s*:\s*"([^"]*)"/);
          if (toolMatch) action.tool = toolMatch[1];
          const typeMatch = actionText.match(/"type"\s*:\s*"([^"]*)"/);
          if (typeMatch) action.type = typeMatch[1];
          result.actions.push(action);
        }
      }
    }
    
    if (Object.keys(result).length > 0) {
      logger.info('[tryManualJsonExtraction] Successfully extracted JSON manually');
      return { success: true, data: result };
    } else {
      return { success: false, error: 'Could not extract any valid fields' };
    }
    
  } catch (e) {
    return { success: false, error: `Manual extraction failed: ${e.message}` };
  }
}


/**
 * Extracts out-of-band file and patch content blocks from the raw LLM response.
 *
 * The LLM emits a JSON control object first, then optionally appends file blocks
 * so that file content never has to be JSON-encoded (which is the root cause of
 * the encoding errors we kept hitting).
 *
 * Supported block formats:
 *
 *   File write:
 *     ===SKIPPY_FILE_START:/path/to/file===
 *     ...content verbatim...
 *     ===SKIPPY_FILE_END===
 *
 *   Patch (one or more find/replace pairs per file):
 *     ===SKIPPY_PATCH_START:/path/to/file===
 *     ===FIND===
 *     ...exact text to find...
 *     ===REPLACE===
 *     ...replacement text...
 *     ===SKIPPY_PATCH_END===
 *
 * Returns { jsonText, fileBlocks, patchBlocks } where:
 *   jsonText    — the portion of the response before the first block delimiter
 *   fileBlocks  — array of { filepath, content }
 *   patchBlocks — array of { filepath, changes: [{ find, replace }] }
 */
function extractFileBlocks(rawBuffer) {
  const logger = global.logger || console;
  const fileBlocks = [];
  const patchBlocks = [];

  // Split the buffer at the first SKIPPY block delimiter so the JSON portion
  // is cleanly separated from the out-of-band content sections.
  const firstDelimIdx = rawBuffer.search(/===SKIPPY_(FILE|PATCH)_START:/);
  const jsonText = firstDelimIdx !== -1 ? rawBuffer.slice(0, firstDelimIdx) : rawBuffer;

  if (firstDelimIdx === -1) {
    return { jsonText, fileBlocks, patchBlocks };
  }

  const blockText = rawBuffer.slice(firstDelimIdx);

  // --- File write blocks ---
  const fileStartRe = /===SKIPPY_FILE_START:([^\n=]+?)===/g;
  let m;
  while ((m = fileStartRe.exec(blockText)) !== null) {
    const filepath = m[1].trim();
    const afterHeader = m.index + m[0].length;
    // Skip one leading newline that follows the header line
    const contentStart = blockText[afterHeader] === '\n' ? afterHeader + 1 : afterHeader;
    const endMarker = '===SKIPPY_FILE_END===';
    const endIdx = blockText.indexOf(endMarker, contentStart);
    if (endIdx === -1) {
      logger.warn(`[extractFileBlocks] No FILE_END found for ${filepath}`);
      continue;
    }
    // Strip the trailing newline that precedes the end marker
    let content = blockText.slice(contentStart, endIdx);
    if (content.endsWith('\n')) content = content.slice(0, -1);
    fileBlocks.push({ filepath, content });
    logger.debug(`[extractFileBlocks] Extracted file block: ${filepath} (${content.length} chars)`);
  }

  // --- Patch blocks ---
  const patchStartRe = /===SKIPPY_PATCH_START:([^\n=]+?)===/g;
  while ((m = patchStartRe.exec(blockText)) !== null) {
    const filepath = m[1].trim();
    const blockStart = m.index + m[0].length;
    const endMarker = '===SKIPPY_PATCH_END===';
    const blockEnd = blockText.indexOf(endMarker, blockStart);
    if (blockEnd === -1) {
      logger.warn(`[extractFileBlocks] No PATCH_END found for ${filepath}`);
      continue;
    }
    const blockContent = blockText.slice(blockStart, blockEnd);

    // Parse FIND/REPLACE pairs within the patch block
    const changes = [];
    const findMarker = '===FIND===';
    const replaceMarker = '===REPLACE===';
    const parts = blockContent.split(findMarker);
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const replaceIdx = part.indexOf(replaceMarker);
      if (replaceIdx === -1) continue;
      let find = part.slice(0, replaceIdx);
      let replace = part.slice(replaceIdx + replaceMarker.length);
      // Strip exactly one leading and one trailing newline that the format adds
      if (find.startsWith('\n')) find = find.slice(1);
      if (find.endsWith('\n')) find = find.slice(0, -1);
      if (replace.startsWith('\n')) replace = replace.slice(1);
      if (replace.endsWith('\n')) replace = replace.slice(0, -1);
      changes.push({ find, replace });
    }

    patchBlocks.push({ filepath, changes });
    logger.debug(`[extractFileBlocks] Extracted patch block: ${filepath} (${changes.length} change(s))`);
  }

  return { jsonText, fileBlocks, patchBlocks };
}

async function emptyPromptResponseMessage(context, options = {}) {
  const logger = global.logger || console;
  if (!context || typeof context !== 'string') {
    logger.warn('[emptyPromptResponseMessage] Invalid context provided');
    return '';
  }
  
  let summary = compressContext(context);
  let callbackFired = false;
  
  logger.debug('[emptyPromptResponseMessage] Context length: ' + context.length);
  logger.debug('[emptyPromptResponseMessage] Compressed context length: ' + summary.length);

  // Use promptOllama for LLM summarization
  if (typeof promptOllama === 'function') {
    // Safety net: if done callback never fires (e.g. streaming stalls), force callback after 3 minutes.
    // Must be registered BEFORE the await so it's live during the stream.
    const fallbackTimer = setTimeout(() => {
      if (!callbackFired && typeof options.callback === 'function') {
        logger.warn('[emptyPromptResponseMessage] Fallback timeout: Forcing callback.');
        callbackFired = true;
        options.callback("No Response could be generated at this time.");
      }
    }, 3 * 60 * 1000);

    try {
      const summarizationPrompt = (options.prompt || 'Generate a polite fallback message for the user when no answer can be synthesized. Respond with only a short, friendly message. Do not use JSON or any formatting. Only output plain text.') + '\n' + summary;
      let summarized = '';

      logger.debug('[emptyPromptResponseMessage] Calling promptOllama for fallback message');
      await promptOllama({ prompt: summarizationPrompt }, (part, done) => {
        if (!done && part && part.trim()) {
          summarized += part;
        }
        if (done && typeof options.callback === 'function') {
          let result = summarized.trim() || summary;

          // Strip markdown code block quotes if present
          let clean = result.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

          // If result looks like JSON, extract final_answer if present
          let extracted = clean;
          try {
            const parsed = JSON.parse(clean);
            if (parsed && typeof parsed.final_answer === 'string' && parsed.final_answer.trim()) {
              extracted = parsed.final_answer.trim();
            }
          } catch (e) {
            logger.debug('[emptyPromptResponseMessage] Fallback result not JSON, using as-is');
          }

          logger.debug('[emptyPromptResponseMessage] Callback fired with: ' + extracted.substring(0, 100));
          callbackFired = true;
          clearTimeout(fallbackTimer);
          options.callback(extracted);
        }
      });

      summary = summarized.trim() || summary;
      logger.debug('[emptyPromptResponseMessage] Final summary: ' + summary.substring(0, 100));
    } catch (err) {
      clearTimeout(fallbackTimer);
      logger.error('[emptyPromptResponseMessage] Error generating empty prompt response: ' + err.message);
      if (typeof options.callback === 'function' && !callbackFired) {
        callbackFired = true;
        options.callback("No Response could be generated at this time.");
      }
    }
  }
  
  return summary;
}

// Per-channel abort flags — keyed by channelId so /stop only affects one chain
const abortedChannels = new Set();

function requestAbort(channelId) {
  abortedChannels.add(channelId);
}

function isAbortRequested(channelId) {
  return abortedChannels.has(channelId);
}

function clearAbort(channelId) {
  abortedChannels.delete(channelId);
}

// Pending continuations — saved when a prompt hits the loop limit.
// Keyed by channelId: { toolResults, resumePrompt, originalPrompt, loopCount }
const pendingContinuations = new Map();

function isAffirmativeResponse(text) {
  // Discord wraps the user's message in a conversation block like:
  //   "Recent conversation:\nuser: continue\n...\nCurrent request: continue"
  // Extract just the current request if present; otherwise use the raw text.
  const currentRequestMatch = text.match(/Current request:\s*(.+?)(?:\n|$)/i);
  const raw = currentRequestMatch ? currentRequestMatch[1].trim() : text.trim();

  const s = raw.toLowerCase().replace(/[!.,?]+$/, '');
  const affirmatives = [
    'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay',
    'continue', 'go ahead', 'proceed', 'go on', 'keep going',
    'yes please', 'please continue', 'do it', 'go for it',
    'absolutely', 'definitely', 'of course', 'certainly'
  ];
  return affirmatives.some(a => s === a || s.startsWith(a + ' '));
}

// Download a URL and return the raw bytes as a base64 string (no data-URL prefix).
function downloadImageAsBase64(url) {
  const lib = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    lib.get(url, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Builds the prompt and sends it to Ollama
async function runPrompt({ prompt, model, stream = true, discordMessage, imageUrls, extraContext }, callback) {
    const statusMessages = [];
    try {
  const logger = global.logger || console;
  
  logger.info('========== STARTING PROMPT ==========');
  logger.info(`[runPrompt] Input prompt length: ${prompt ? prompt.length : 0}`);
  logger.info(`[runPrompt] Input preview: "${prompt ? prompt.substring(0, 100) : 'null'}${prompt && prompt.length > 100 ? '...' : ''}"`);
  logger.info(`[runPrompt] Model: ${model || 'default'}`);
  logger.info(`[runPrompt] Stream: ${stream}`);
  logger.info(`[runPrompt] Has Discord message: ${!!discordMessage}`);
  
  if (!prompt || typeof prompt !== 'string') {
    logger.error('[runPrompt] Invalid prompt provided');
    if (callback) callback({ error: 'Invalid prompt provided' }, true);
    return;
  }

  logger.info(`Prompting Ollama with: ${prompt}`);
  
  const currentUser = discordMessage?.author?.username
    ?? global.SkippyConfig?.discord?.default_user
    ?? 'global';
  const channelId   = discordMessage?.channel?.id   ?? 'cli';
  const channelName = discordMessage?.channel?.name ?? null;

  const systemPromptLength = SYSTEM_PROMPT.length;
  const toolContextLength = global.CondensedToolContext ? global.CondensedToolContext.length : 0;
  const memoryContext  = await buildMemoryContext();
  const skillContext   = await buildSkillContext(currentUser);
  const channelContext = await buildChannelContext();

  logger.debug(`[runPrompt] ctx components — sys:${systemPromptLength}  tools:${toolContextLength}  mem:${memoryContext.length}  skills:${skillContext.length} (user:${currentUser})`);

  let context = SYSTEM_PROMPT + '\n';
  const timeContext = getCurrentTimeContext();
  //logger.debug(`[runPrompt] Time context: ${util.inspect(timeContext, { colors: true, depth: null })}`);
  context += `Current time UTC: ${timeContext.current_time} (Timezone: ${timeContext.timezone}) Human-readable: ${timeContext.human_readable}\n`;
  context += `Current user: ${currentUser}\n`;
  if (channelName) context += `Current channel: ${channelName}\n`;
  context += (global.CondensedToolContext ? '\n' + global.CondensedToolContext : '');
  context += channelContext;
  context += memoryContext;
  context += skillContext;
  context += '\n' + getCwdContext();
  context += buildFileContextString();
  
  let buffer = "";
  let lastResponse = null;
  let continueLoop = true;
  let toolResults = [];
  let userPrompt = extraContext && extraContext.trim()
    ? `<context>\n${extraContext.trim()}\n</context>\n\n${prompt}`
    : prompt;
  
  // Clear any stale abort for this channel at the start of a new prompt
  clearAbort(channelId);

  // Check whether the user is responding to a loop-limit continuation prompt.
  // If yes and affirmative: restore the accumulated context and resume the work.
  // If yes and not affirmative: discard the saved context and run fresh.
  const pendingContinuation = pendingContinuations.get(channelId);
  if (pendingContinuation) {
    if (isAffirmativeResponse(prompt)) {
      logger.info(`[runPrompt] Resuming continuation for channel ${channelId} (${pendingContinuation.toolResults.length} prior result(s))`);
      toolResults = pendingContinuation.toolResults;
      userPrompt  = pendingContinuation.resumePrompt;
    } else {
      logger.info(`[runPrompt] Discarding pending continuation for channel ${channelId} — starting fresh`);
    }
    pendingContinuations.delete(channelId);
  }

  // Load loop limit from already-loaded global config
  let loopLimit = 10;
  if (global.SkippyConfig?.prompt?.loop_limit != null) {
    loopLimit = global.SkippyConfig.prompt.loop_limit;
    logger.info(`[runPrompt] Loaded loopLimit from config: ${loopLimit}`);
  }
  
  let loopCount = 0;
  logger.debug(`[runPrompt] Using loopLimit: ${loopLimit}`);

  // Collect all intermediate status/reasoning messages so they can be deleted after the final answer
  const trackStatus = async (...args) => {
    const sent = await sendStatusUpdate(...args);
    if (sent) statusMessages.push(sent);
  };
  const trackReasoning = async (...args) => {
    const sent = await sendDiscordReasoning(...args);
    if (sent) statusMessages.push(sent);
  };

  // Send initial status if we have a Discord message
  if (discordMessage) {
    await trackStatus(discordMessage, 'thinking', 'Analyzing your request...');
  }
  
  // Download any attached images once before the loop (base64, no data-URL prefix).
  // Merge per-message attachments with persistent context images.
  const persistentImagePaths = getContextImagePaths();
  const allImageSources = [...(imageUrls || []), ...persistentImagePaths];
  let images = [];
  if (allImageSources.length > 0) {
    logger.info(`[runPrompt] Loading ${allImageSources.length} image(s) for vision (${imageUrls?.length ?? 0} attached, ${persistentImagePaths.length} from context)`);
    try {
      images = await Promise.all(allImageSources.map(src => {
        if (src.startsWith('http://') || src.startsWith('https://')) {
          return downloadImageAsBase64(src);
        }
        // Local file path
        return Promise.resolve(require('fs').readFileSync(src).toString('base64'));
      }));
      logger.info(`[runPrompt] Loaded ${images.length} image(s) successfully`);
    } catch (imgErr) {
      logger.error(`[runPrompt] Failed to load image(s): ${imgErr.message}`);
    }
  }

  while (continueLoop && loopCount < loopLimit) {
    loopCount++;
    logger.debug(`========== LOOP ITERATION ${loopCount} ==========`);
    logger.debug(`[runPrompt] Loop iteration ${loopCount}/${loopLimit}, continueLoop: ${continueLoop}`);
    
    // Check for abort request
    if (isAbortRequested(channelId)) {
      logger.info('[runPrompt] Abort requested, stopping execution');
      if (discordMessage) {
        await trackStatus(discordMessage, 'stopped', 'Execution stopped by user request');
      }
      if (callback) {
        callback({
          aborted: true,
          tool_results: toolResults,
          last_response: lastResponse,
          loop_count: loopCount,
          status_messages: statusMessages
        }, true);
      }
      return;
    }

    // Send status update for each loop iteration
    if (discordMessage && loopCount > 1) {
      await trackStatus(discordMessage, 'processing', `Step ${loopCount}: Processing tools and generating response...`);
    }
    
    buffer = "";
    {
      // Priority: explicit config cap → auto-detected from model at startup → safe default
      const configCap   = global.SkippyConfig?.ollama?.context_window;
      const detectedCap = global.SkippyModelContextWindow;
      const ctxWindow   = configCap ?? detectedCap ?? 1_000_000;
      const ctxSource   = configCap ? 'cfg' : detectedCap ? 'model' : 'default';
      const totalChars  = context.length + userPrompt.length;
      const usedTok  = Math.round(totalChars / 4);
      const availTok = ctxWindow - usedTok;
      const pct      = ((usedTok / ctxWindow) * 100).toFixed(1);
      const fmt      = n => n.toLocaleString();
      logger.info(`[context:loop${loopCount}] ~${fmt(usedTok)} / ${fmt(ctxWindow)} tokens [${ctxSource}]  (${pct}% full, ${fmt(availTok)} remaining)  | ctx:${fmt(Math.round(context.length/4))} tok  user:${fmt(Math.round(userPrompt.length/4))} tok`);
    }

    await promptOllama({ prompt: userPrompt, context, model, stream, images: loopCount === 1 ? images : undefined }, (part, done) => {
      if (!done && part && part.trim()) {
        buffer += part;
      }
    });

    // Check abort immediately after LLM finishes — catches the case where
    // the LLM returns continue:false with no tools, so neither the loop-top
    // check nor the per-tool check would ever run.
    if (isAbortRequested(channelId)) {
      logger.info('[runPrompt] Abort requested (post-LLM), stopping execution');
      if (discordMessage) {
        await trackStatus(discordMessage, 'stopped', 'Execution stopped by user request');
      }
      if (callback) {
        callback({ aborted: true, tool_results: toolResults, last_response: lastResponse, loop_count: loopCount, status_messages: statusMessages }, true);
      }
      return;
    }

    // Parse and clean JSON response with extensive logging
    logger.debug(`[runPrompt] Raw buffer length: ${buffer.length}`);
    logger.debug(`[runPrompt] Buffer preview: "${buffer.substring(0, 300)}${buffer.length > 300 ? '...' : ''}"`);
    
    let cleanBuffer = buffer.trim();
    if (cleanBuffer.startsWith('```json')) {
      logger.debug('[runPrompt] Detected ```json code block, removing markers');
      cleanBuffer = cleanBuffer.replace(/^```json\s*/, '');
    }
    if (cleanBuffer.startsWith('```')) {
      logger.debug('[runPrompt] Detected ``` code block, removing markers');
      cleanBuffer = cleanBuffer.replace(/^```\s*/, '');
    }
    if (cleanBuffer.endsWith('```')) {
      logger.debug('[runPrompt] Detected closing ```, removing markers');
      cleanBuffer = cleanBuffer.replace(/```\s*$/, '');
    }

    logger.debug(`[runPrompt] Clean buffer length: ${cleanBuffer.length}`);
    logger.debug(`[runPrompt] Clean buffer preview: "${cleanBuffer.substring(0, 300)}${cleanBuffer.length > 300 ? '...' : ''}"`);

    // Extract out-of-band file/patch blocks BEFORE JSON parsing so that file
    // content never has to travel through a JSON-encoded string.
    const { jsonText, fileBlocks, patchBlocks } = extractFileBlocks(cleanBuffer);
    const hasOutOfBandBlocks = fileBlocks.length > 0 || patchBlocks.length > 0;
    if (hasOutOfBandBlocks) {
      logger.info(`[runPrompt] Out-of-band blocks: ${fileBlocks.length} file write(s), ${patchBlocks.length} patch(es)`);
    }
    const jsonToParse = hasOutOfBandBlocks ? jsonText.trim() : cleanBuffer;

    let parsedJson = extractFirstJson(jsonToParse);
    
    if (!parsedJson) {
      logger.error('❌ [runPrompt] Failed to parse Ollama response as JSON');
      logger.error(`[runPrompt] Raw buffer full content: "${buffer}"`);
      
      if (discordMessage) {
        await trackStatus(discordMessage, 'error', 'Failed to parse AI response');
      }
      
      if (callback) {
        callback({
          error: 'Invalid JSON response from AI',
          raw: buffer,
          debug_info: {
            buffer_length: buffer.length,
            clean_buffer_length: cleanBuffer.length,
            loop_count: loopCount
          },
          status_messages: statusMessages
        }, true);
      }
      return;
    }

    // Validate the response has at least one canonical field.
    // If the extractor found a JSON fragment inside a non-JSON response (e.g. a
    // partial argument object), none of these fields will be present and we must
    // retry rather than silently treating it as a completed response.
    const hasCanonicalFields = 'actions' in parsedJson || 'final_answer' in parsedJson || 'continue' in parsedJson;
    if (!hasCanonicalFields) {
      logger.warn(`[runPrompt] Parsed JSON lacks canonical fields (got: ${Object.keys(parsedJson).join(', ')}) — LLM likely responded in wrong format, retrying with corrective prompt`);
      toolResults.push({
        tool: '_system',
        error: 'Your previous response was not valid JSON in the required format. You MUST respond with a single JSON object containing: reasoning, actions, final_answer, continue. No free text before or after the JSON.'
      });
      userPrompt = JSON.stringify({ original_prompt: prompt, tool_results: toolResults, last_response: null });
      continue;
    }

    logger.info('✅ [runPrompt] Successfully parsed JSON response');
    logger.debug('[runPrompt] Parsed JSON keys: ' + Object.keys(parsedJson).join(', '));

    // Send reasoning for tool calls BEFORE executing them
    if (parsedJson.actions && parsedJson.actions.length > 0 && discordMessage) {
      if (parsedJson.actions.length === 1) {
        // Single action - send one reasoning message with tool info
        const action = parsedJson.actions[0];
        if (action.reasoning) {
          await trackReasoning(discordMessage, action.reasoning, { tool: action.tool, arguments: action.arguments });
        }
      } else {
        // Multiple actions - send reasoning for each with progress and tool info
        for (let i = 0; i < parsedJson.actions.length; i++) {
          const action = parsedJson.actions[i];
          if (action.reasoning) {
            await trackReasoning(discordMessage, `${action.reasoning} (Step ${i + 1} of ${parsedJson.actions.length})`, { tool: action.tool, arguments: action.arguments });
          }
        }
      }
    }

    logger.debug('Prompt JSON response:\n' + util.inspect(parsedJson, { colors: true, depth: null }));
    lastResponse = parsedJson;

    // Check if we have tool calls
    const hasToolCalls = parsedJson.actions && parsedJson.actions.some(action => action.type === 'tool_call');
    const hasFinalAnswer = parsedJson.final_answer && parsedJson.final_answer.trim();
    
    // Continue loop if AI wants to continue OR if tools were called and no final answer yet
    continueLoop = parsedJson.continue === true || (hasToolCalls && !hasFinalAnswer);
    
    logger.debug(`[runPrompt] Loop decision - continueLoop: ${continueLoop}, hasToolCalls: ${hasToolCalls}, hasFinalAnswer: ${hasFinalAnswer}, continue_field: ${parsedJson.continue}`);

    // Handle tool calls
    if (parsedJson.actions && Array.isArray(parsedJson.actions)) {
      logger.debug(`[runPrompt] Processing ${parsedJson.actions.length} action(s)`);
      
      for (let i = 0; i < parsedJson.actions.length; i++) {
        // Check for abort request before each tool execution
        if (isAbortRequested(channelId)) {
          logger.info('[runPrompt] Abort requested during tool execution, stopping');
          if (discordMessage) {
            await trackStatus(discordMessage, 'stopped', 'Execution stopped by user request');
          }
          if (callback) {
            callback({
              aborted: true,
              tool_results: toolResults,
              last_response: lastResponse,
              loop_count: loopCount,
              status_messages: statusMessages
            }, true);
          }
          return;
        }

        const action = parsedJson.actions[i];
        logger.debug(`[runPrompt] Processing action ${i + 1}/${parsedJson.actions.length}: ${action.type}`);

        if (action.type === 'tool_call' && action.tool) {
          logger.debug(`[runPrompt] Executing tool_call: ${action.tool} with arguments:\n` + util.inspect(action.arguments, { colors: true, depth: null }));

          // Send status update for tool execution with tool info
          if (discordMessage) {
            const toolInfo = { tool: action.tool, arguments: action.arguments };
            if (parsedJson.actions.length > 1) {
              await trackStatus(discordMessage, 'processing', `Executing ${action.tool} (${i + 1}/${parsedJson.actions.length})...`, toolInfo);
            } else {
              await trackStatus(discordMessage, 'processing', `Executing ${action.tool}...`, toolInfo);
            }
          }

          // Inject out-of-band content from SKIPPY blocks into action arguments
          // so the tool receives file content without it ever being JSON-encoded.
          if (action.tool === 'FileWriteTool' && fileBlocks.length > 0) {
            const fp = action.arguments?.filepath || action.arguments?.path || action.arguments?.file || '';
            const block = fileBlocks.find(b => b.filepath === fp) || fileBlocks[0];
            if (block) {
              if (!action.arguments) action.arguments = {};
              action.arguments.content = block.content;
              logger.info(`[runPrompt] Injected out-of-band file content into FileWriteTool for ${block.filepath} (${block.content.length} chars)`);
            }
          }

          if (action.tool === 'PatchFileTool' && patchBlocks.length > 0) {
            const fp = action.arguments?.filepath || action.arguments?.path || action.arguments?.file || '';
            const block = patchBlocks.find(b => b.filepath === fp) || patchBlocks[0];
            if (block) {
              if (!action.arguments) action.arguments = {};
              action.arguments.changes = block.changes;
              logger.info(`[runPrompt] Injected out-of-band patch changes into PatchFileTool for ${block.filepath} (${block.changes.length} change(s))`);
            }
          }

          // Use buildArgsFromAction if available for robust argument mapping
          let toolInstructions = action.arguments;
          const toolInstance = toolRegistry[action.tool];
          if (toolInstance && typeof toolInstance.constructor.buildArgsFromAction === 'function') {
            toolInstructions = toolInstance.constructor.buildArgsFromAction({ arguments: action.arguments });
          }

          let toolResult;
          try {
            toolResult = await executeToolCall({
              tool_name: action.tool,
              tool_instructions: toolInstructions
            });
          } catch (err) {
            logger.error(`[runPrompt] Tool execution failed for ${action.tool}: ${err.message}`);
            toolResult = { error: err.message, exitCode: 1 };
          }

          logger.debug('[runPrompt] Tool result:\n' + util.inspect(toolResult, { colors: true, depth: null }));
          toolResults.push({ tool: action.tool, arguments: action.arguments, result: toolResult });
        }
      }
    }

    // If any tool in this iteration returned an error, force another loop so
    // the model can react to the failure — even if it prematurely set continue:false.
    const iterationToolCount = parsedJson.actions
      ? parsedJson.actions.filter(a => a.type === 'tool_call').length
      : 0;
    if (iterationToolCount > 0 && !continueLoop) {
      const iterationResults = toolResults.slice(toolResults.length - iterationToolCount);
      const anyFailed = iterationResults.some(r => r.result?.success === false || r.result?.error);
      if (anyFailed) {
        logger.warn(`[runPrompt] ${iterationResults.filter(r => r.result?.success === false || r.result?.error).length} tool(s) returned errors — forcing continuation so the model can react`);
        continueLoop = true;
      }
    }

    // Prepare next prompt if continuing
    if (continueLoop && loopCount < loopLimit) {
      const nextPromptObj = {
        original_prompt: prompt,
        tool_results: toolResults,
        last_response: lastResponse
      };
      userPrompt = JSON.stringify(nextPromptObj);
      logger.debug(`[runPrompt] Prepared next prompt for iteration ${loopCount + 1}`);
    }
    
    // Check if we've reached the loop limit
    if (loopCount >= loopLimit && continueLoop) {
      logger.info(`[runPrompt] Reached loop limit (${loopLimit}), saving continuation and asking user`);

      // Build the prompt that would start the next iteration so all accumulated
      // tool results are preserved exactly when the user says yes.
      const resumePrompt = JSON.stringify({
        original_prompt: prompt,
        tool_results: toolResults,
        last_response: lastResponse
      });

      pendingContinuations.set(channelId, {
        toolResults,
        resumePrompt,
        originalPrompt: prompt,
        loopCount
      });

      const continueQuestion = `I've hit my step limit (${loopLimit} steps) and there's still work to do. Would you like me to continue?`;

      // Do NOT call discordMessage.channel.send() here — the callback handler
      // already sends final_answer to Discord, so doing both causes a double-send.
      if (callback) {
        callback({
          max_iterations_reached: true,
          continuation_pending: true,
          tool_results: toolResults,
          last_response: { ...(lastResponse || {}), final_answer: continueQuestion },
          loop_count: loopCount,
          status_messages: statusMessages
        }, true);
      }
      return;
    }
  }

  // Send completion status
  if (discordMessage) {
    await trackStatus(discordMessage, 'complete', `All steps completed successfully! (${loopCount} iteration${loopCount !== 1 ? 's' : ''})`);
  }

  // Final callback with structured JSON and extensive logging
  logger.debug('========== FINALIZING PROMPT ==========');
  logger.debug('[runPrompt] Final callback data:');
  logger.debug(`  - toolResults count: ${toolResults.length}`);
  logger.debug(`  - lastResponse keys: ${lastResponse ? Object.keys(lastResponse).join(', ') : 'null'}`);
  logger.debug(`  - loopCount: ${loopCount}`);
  logger.debug(`  - loopLimit: ${loopLimit}`);
  
  if (lastResponse && !lastResponse.final_answer?.trim()) {
    logger.warn('[runPrompt] Empty final_answer after tool calls. Agent did not synthesize a response.');
    await emptyPromptResponseMessage(context, {
      prompt: 'Generate a polite fallback message for the user when no answer can be synthesized. Respond with a short, friendly message.',
      callback: (msg) => {
        logger.debug('[runPrompt] emptyPromptResponseMessage callback fired. msg: ' + msg.substring(0, 100));
        lastResponse.final_answer = msg;
        if (callback) callback({ tool_results: toolResults, last_response: lastResponse, loop_count: loopCount, status_messages: statusMessages }, true);
      }
    });
    return;
  }
  
  logger.info('========== PROMPT COMPLETED SUCCESSFULLY ==========');
  
  if (callback) {
    callback({
      tool_results: toolResults,
      last_response: lastResponse,
      loop_count: loopCount,
      status_messages: statusMessages,
      success: true
    }, true);
  }
  return;
    } catch (err) {
      const logger = global.logger || console;
      // Normalize error — some libraries (e.g. ollama on abort) throw non-standard objects
      const errMessage = err?.message || (typeof err === 'string' ? err : JSON.stringify(err)) || 'Unknown error';
      const errCode    = err?.code || err?.status_code || err?.type || undefined;
      const sslError   = errCode && (errCode.toLowerCase().includes('ssl') || errCode.toLowerCase().includes('tls'));
      if (sslError && discordMessage) {
        await trackStatus(discordMessage, 'error', `SSL/TLS error: ${errMessage}`);
      }
      logger.error(`[runPrompt] Uncaught exception: ${errMessage}${errCode ? ` (code: ${errCode})` : ''}`);
      if (callback) callback({ error: errMessage, code: errCode, status_messages: statusMessages }, true);
      return;
    }
}

module.exports = { runPrompt, requestAbort, isAbortRequested, clearAbort };
