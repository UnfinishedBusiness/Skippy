const Tool = require('../tool_prototype');
const fs = require('fs');
const path = require('path');

class FileReadTool extends Tool {
  async run(args) {
    // args: [filepath] or { filepath }
    const logger = global.logger || console;

    // Normalize: accept { filepath } object or positional array
    if (!Array.isArray(args) && args && typeof args === 'object') {
      args = [args.filepath || args.path || args.file];
    }

    const filePath = args[0];
    try {
      const absPath = path.resolve(filePath);
      const content = fs.readFileSync(absPath, 'utf8');
      logger.info(`FileReadTool: Read file ${absPath}`);
      return {
        filepath: absPath,
        content,
        error: null,
        exitCode: 0
      };
    } catch (err) {
      logger.error(`FileReadTool: Failed to read file ${filePath}: ${err.message}`);
      return {
        filepath: filePath,
        content: '',
        error: err.message,
        exitCode: 1
      };
    }
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

module.exports = FileReadTool;
