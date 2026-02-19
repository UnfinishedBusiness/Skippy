const Tool = require('../tool_prototype');
const fs = require('fs');
const path = require('path');

class FileWriteTool extends Tool {
  async run(args) {
    // args: [filepath, content] or { filepath, content }
    const logger = global.logger || console;

    // Normalize: accept { filepath, content } object or positional array
    if (!Array.isArray(args) && args && typeof args === 'object') {
      args = [args.filepath || args.path || args.file, args.content || args.data || ''];
    }

    const filePath = args[0];
    const content = args[1] || '';
    try {
      const absPath = path.resolve(filePath);
      fs.writeFileSync(absPath, content, 'utf8');
      logger.info(`FileWriteTool: Wrote to file ${absPath}`);
      return {
        filepath: absPath,
        content,
        error: null,
        exitCode: 0
      };
    } catch (err) {
      logger.error(`FileWriteTool: Failed to write file ${filePath}: ${err.message}`);
      return {
        filepath: filePath,
        content,
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

module.exports = FileWriteTool;
