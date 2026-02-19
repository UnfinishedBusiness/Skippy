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

    for (const change of changes) {
      if (!change || typeof change !== 'object' || typeof change.find !== 'string' || typeof change.replace !== 'string') {
        logger.warn('PatchFileTool: Invalid change object, skipping:', change);
        continue;
      }

      const idx = content.indexOf(change.find);
      if (idx === -1) {
        logger.warn('PatchFileTool: Find block not found, skipping:', change.find);
        continue;
      }

      content = content.replace(change.find, change.replace);
      applied++;
    }

    fs.writeFileSync(filePath, content, 'utf8');
    logger.info(`PatchFileTool: Applied ${applied} changes to ${filePath}`);
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