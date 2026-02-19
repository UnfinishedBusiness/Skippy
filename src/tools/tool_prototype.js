
class Tool {
  run(args) {
    throw new Error('Tool.run() must be implemented by subclass');
  }
  getContext() {
    return '';
  }
  async init() {
    // Default: do nothing
  }
}

module.exports = Tool;
