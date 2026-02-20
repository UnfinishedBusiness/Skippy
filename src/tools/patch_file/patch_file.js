const Tool = require('../tool_prototype');
const fs = require('fs');
const path = require('path');

class PatchFileTool extends Tool {
  // Build argument array from action object for dynamic tool invocation
  static buildArgsFromAction(action) {
    const args = action.arguments || {};

    // Handle case where arguments is already an array
    if (Array.isArray(args)) return args;

    // Handle case where arguments is an object with filepath and patch properties
    if (typeof args === 'object' && args !== null) {
      // Extract filepath and patch from the object
      const filepath = args.filepath || args.path || args.file || null;
      const changes = args.changes || args.patches || args.edits || null;

      // Return as array if both values exist
      if (filepath !== null && changes !== null) {
        return [filepath, changes];
      }

      // If we have a filepath but no patch, try to find patch content in other properties
      if (filepath !== null) {
        // Look for patch content in various possible properties
        const patchKeys = ['patch', 'content', 'diff', 'data'];
        for (const key of patchKeys) {
          if (args[key] !== undefined) {
            return [filepath, args[key]];
          }
        }
      }

      // If we have patch content but no filepath, look for filepath in other properties
      if (changes !== null) {
        const pathKeys = ['filepath', 'path', 'file', 'filename'];
        for (const key of pathKeys) {
          if (args[key] !== undefined) {
            return [args[key], changes];
          }
        }
      }

      // If we can't find both, return what we have
      return [filepath, changes].filter(arg => arg !== null);
    }

    // For all other cases, wrap in array
    return [args];
  }

  /**
   * Attempts a whitespace-normalized line-by-line match as a fallback when
   * exact string matching fails.
   *
   * Each line in both the find text and the file content is normalized
   * (tabs → spaces, runs of spaces collapsed to one, leading/trailing trimmed)
   * before comparison.  If a matching run of lines is found, the corresponding
   * original lines in the file are replaced with the replacement text.
   *
   * This handles the common LLM failure mode of generating the right content
   * with subtly wrong indentation.  It does NOT match across different line
   * counts, so hallucinated line-merges are correctly rejected.
   *
   * Returns the new file content string on success, or null on failure.
   */
  _tryNormalizedPatch(content, findText, replaceText) {
    const normLine = s => s.replace(/\t/g, '  ').replace(/[ \t]+/g, ' ').trim();

    const findLines    = findText.split('\n');
    const contentLines = content.split('\n');
    const normFind    = findLines.map(normLine);
    const normContent = contentLines.map(normLine);

    const fLen = findLines.length;

    for (let start = 0; start <= contentLines.length - fLen; start++) {
      let match = true;
      for (let i = 0; i < fLen; i++) {
        if (normContent[start + i] !== normFind[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        const before = contentLines.slice(0, start).join('\n');
        const after  = contentLines.slice(start + fLen).join('\n');
        return (before ? before + '\n' : '') + replaceText + (after ? '\n' + after : '');
      }
    }

    return null;
  }

  /**
   * When a patch fails, searches the file for the first non-blank normalized
   * line of `findText` as an anchor, then returns a window of actual file lines
   * around that anchor.
   *
   * The returned excerpt is included in the error message so the model can see
   * the exact text it should be targeting and re-attempt with accurate content.
   * Returns null if the anchor line itself can't be found anywhere in the file.
   */
  _findClosestContext(content, findText) {
    const normLine = s => s.replace(/\t/g, '  ').replace(/[ \t]+/g, ' ').trim();
    const contentLines = content.split('\n');
    const normContent  = contentLines.map(normLine);

    const findLines = findText.split('\n');
    const anchor    = findLines.map(normLine).find(l => l !== '');
    if (!anchor) return null;

    const matchIdx = normContent.findIndex(l => l === anchor);
    if (matchIdx === -1) return null;

    // Return a window: 2 lines before the anchor + enough lines to cover the find text
    const windowSize = Math.max(findLines.length + 4, 10);
    const start = Math.max(0, matchIdx - 2);
    const end   = Math.min(contentLines.length, start + windowSize);
    return contentLines.slice(start, end).join('\n');
  }

  async run(args) {
    const logger = global.logger || console;

    // Enhanced argument validation
    if (!args || args.length < 2) {
      logger.error('PatchFileTool: Insufficient arguments provided');
      return {
        filepath: args?.[0] || 'unknown',
        result: '',
        error: `PatchFileTool requires 2 arguments: [filepath, changesArray]. Received: ${JSON.stringify(args)}`,
        exitCode: 1
      };
    }

    let filePath = args[0];
    let changes = args[1];

    // Validate file path
    if (!filePath) {
      logger.error('PatchFileTool: No file path provided');
      return {
        filepath: 'unknown',
        result: '',
        error: 'File path is required',
        exitCode: 1
      };
    }

    // Convert to absolute path
    filePath = path.resolve(filePath);

    // Validate changes
    if (!Array.isArray(changes)) {
      logger.error('PatchFileTool: Changes must be an array');
      return {
        filepath: filePath,
        result: '',
        error: 'Changes must be an array of {find,replace} objects',
        exitCode: 1
      };
    }

    // Verify target file exists
    if (!fs.existsSync(filePath)) {
      logger.error(`PatchFileTool: Target file does not exist: ${filePath}`);
      return {
        filepath: filePath,
        result: '',
        error: `Target file does not exist: ${filePath}`,
        exitCode: 1
      };
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let applied = 0;
    const failed = [];

    for (const change of changes) {
      if (!change || typeof change !== 'object' || typeof change.find !== 'string' || typeof change.replace !== 'string') {
        logger.warn('PatchFileTool: Invalid change object, skipping:', change);
        continue;
      }

      // 1. Try exact match
      const idx = content.indexOf(change.find);
      if (idx !== -1) {
        content = content.replace(change.find, change.replace);
        applied++;
        continue;
      }

      // 2. Fallback: whitespace-normalized line match
      const normalized = this._tryNormalizedPatch(content, change.find, change.replace);
      if (normalized !== null) {
        logger.info(`PatchFileTool: Applied change via whitespace-normalized match (exact match failed) in ${filePath}`);
        content = normalized;
        applied++;
        continue;
      }

      // 3. Both strategies failed — record the find text and the actual file
      //    context at that location so the model can self-correct on retry.
      const ctx = this._findClosestContext(content, change.find);
      logger.warn(`PatchFileTool: Find block not found (exact or normalized) in ${filePath}:\n${change.find}`);
      failed.push({ find: change.find, context: ctx });
    }

    if (applied > 0) {
      fs.writeFileSync(filePath, content, 'utf8');
    }

    logger.info(`PatchFileTool: Applied ${applied}/${changes.length} changes to ${filePath}`);

    if (failed.length > 0) {
      const summary = failed.map((f, i) => {
        let msg = `Change ${i + 1}: find text not found in file.\nYour ===FIND=== block was:\n${f.find}`;
        if (f.context) {
          msg += `\n\nActual file content at that location (copy this EXACTLY into your ===FIND=== block):\n${f.context}`;
        } else {
          msg += `\n\n(The first line of your find text could not be located in the file at all — read the file first.)`;
        }
        return msg;
      }).join('\n\n---\n\n');
      return {
        filepath: filePath,
        result: `Applied ${applied}/${changes.length} changes — ${failed.length} find block(s) not found`,
        error: `${failed.length} change(s) could not be applied. The ===FIND=== text did not match the file (tried exact and whitespace-normalized). Use the actual file content shown below for your next ===FIND=== block.\n\n${summary}`,
        exitCode: 1
      };
    }

    return {
      filepath: filePath,
      result: `Applied ${applied} changes`,
      error: null,
      exitCode: 0
    };
  }

  getContext() {
    const fs = require('fs');
    const path = require('path');
    const registryPath = path.join(__dirname, 'registry.md');
    if (fs.existsSync(registryPath)) {
      return fs.readFileSync(registryPath, 'utf8');
    } else {
      return '';
    }
  }
}

module.exports = PatchFileTool;
