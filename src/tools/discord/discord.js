const Tool = require('../tool_prototype');
const { sendDiscordMessage } = require('../../core/discord');

class DiscordTool extends Tool {
  async run(args) {
    // args: [targetType, target, message] or { targetType, target, message }
    const logger = global.logger || console;

    // Normalize: accept named-key object or positional array
    if (!Array.isArray(args) && args && typeof args === 'object') {
      args = [args.targetType, args.target, args.message];
    }

    const targetType = args[0];
    const target = args[1];
    const message = args[2];
    try {
      const result = await sendDiscordMessage({ targetType, target, message });
      logger.info(`DiscordTool: Sent message to ${targetType} ${target}`);
      return {
        targetType,
        target,
        message,
        result,
        error: null,
        exitCode: 0
      };
    } catch (err) {
      logger.error(`DiscordTool: Failed to send message to ${targetType} ${target}: ${err.message}`);
      return {
        targetType,
        target,
        message,
        result: null,
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

module.exports = DiscordTool;
