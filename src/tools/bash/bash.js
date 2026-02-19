const { spawn, exec } = require('child_process');
const Tool = require('../tool_prototype');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Process Manager - Singleton to track all background processes
class ProcessManager {
  constructor() {
    this.processes = new Map();
    this.processCounter = 0;
    this.storageDir = path.join(os.tmpdir(), 'skippy_processes');
    
    // Ensure storage directory exists
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  generateId() {
    return `proc_${++this.processCounter}_${Date.now()}`;
  }

  getStoragePath(procId) {
    return path.join(this.storageDir, `${procId}.json`);
  }

  // Start a background process
  spawn(command, options = {}) {
    const procId = this.generateId();
    const logger = global.logger || console;
    
    logger.info(`ProcessManager: Spawning background process ${procId}: ${command}`);

    // Parse command for spawn (first word is cmd, rest are args)
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    // Create output files
    const stdoutFile = path.join(this.storageDir, `${procId}_stdout.txt`);
    const stderrFile = path.join(this.storageDir, `${procId}_stderr.txt`);

    // Spawn the process
    const child = spawn(cmd, args, {
      shell: '/bin/bash',
      detached: false,
      stdio: ['ignore', 'fs', 'fs']
    });

    // Open file streams for stdout/stderr
    const stdoutStream = fs.createWriteStream(stdoutFile);
    const stderrStream = fs.createWriteStream(stderrFile);

    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);

    // Track process state
    const processInfo = {
      id: procId,
      command,
      pid: child.pid,
      status: 'running',
      startTime: Date.now(),
      stdoutFile,
      stderrFile,
      exitCode: null,
      exitSignal: null
    };

    this.processes.set(procId, { child, ...processInfo });

    // Handle process exit
    child.on('exit', (code, signal) => {
      processInfo.status = code === 0 ? 'completed' : 'failed';
      processInfo.exitCode = code;
      processInfo.exitSignal = signal;
      processInfo.endTime = Date.now();
      logger.info(`Process ${procId} exited with code ${code}, signal ${signal}`);
      
      // Close streams
      stdoutStream.end();
      stderrStream.end();
    });

    child.on('error', (err) => {
      processInfo.status = 'error';
      processInfo.error = err.message;
      logger.error(`Process ${procId} error: ${err.message}`);
      stdoutStream.end();
      stderrStream.end();
    });

    // Save process info to disk for persistence
    this.saveProcessInfo(procId, processInfo);

    return processInfo;
  }

  // Save process info to disk
  saveProcessInfo(procId, info) {
    const saveInfo = { ...info };
    delete saveInfo.child; // Don't serialize the child process
    fs.writeFileSync(this.getStoragePath(procId), JSON.stringify(saveInfo, null, 2));
  }

  // Load process info from disk
  loadProcessInfo(procId) {
    const filepath = this.getStoragePath(procId);
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
    return null;
  }

  // Get process status
  getStatus(procId) {
    if (this.processes.has(procId)) {
      const info = this.processes.get(procId);
      return {
        id: info.id,
        command: info.command,
        pid: info.pid,
        status: info.status,
        startTime: info.startTime,
        exitCode: info.exitCode,
        exitSignal: info.exitSignal,
        endTime: info.endTime || null
      };
    }
    // Try loading from disk
    return this.loadProcessInfo(procId);
  }

  // Get stdout content
  getStdout(procId) {
    const info = this.processes.get(procId) || this.loadProcessInfo(procId);
    if (info && info.stdoutFile && fs.existsSync(info.stdoutFile)) {
      return fs.readFileSync(info.stdoutFile, 'utf8');
    }
    return '';
  }

  // Get stderr content
  getStderr(procId) {
    const info = this.processes.get(procId) || this.loadProcessInfo(procId);
    if (info && info.stderrFile && fs.existsSync(info.stderrFile)) {
      return fs.readFileSync(info.stderrFile, 'utf8');
    }
    return '';
  }

  // Get recent output (last N lines)
  getRecentOutput(procId, lines = 50, stream = 'stdout') {
    const content = stream === 'stdout' ? this.getStdout(procId) : this.getStderr(procId);
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  }

  // Kill a process
  kill(procId) {
    const proc = this.processes.get(procId);
    if (proc && proc.child) {
      try {
        process.kill(proc.child.pid, 'SIGTERM');
        proc.status = 'killed';
        proc.endTime = Date.now();
        this.saveProcessInfo(procId, proc);
        return { success: true, message: `Process ${procId} (PID: ${proc.child.pid}) sent SIGTERM` };
      } catch (err) {
        return { success: false, message: `Failed to kill process: ${err.message}` };
      }
    }
    return { success: false, message: `Process ${procId} not found` };
  }

  // Force kill a process
  forceKill(procId) {
    const proc = this.processes.get(procId);
    if (proc && proc.child) {
      try {
        process.kill(proc.child.pid, 'SIGKILL');
        proc.status = 'killed';
        proc.endTime = Date.now();
        this.saveProcessInfo(procId, proc);
        return { success: true, message: `Process ${procId} (PID: ${proc.child.pid}) sent SIGKILL` };
      } catch (err) {
        return { success: false, message: `Failed to force kill: ${err.message}` };
      }
    }
    return { success: false, message: `Process ${procId} not found` };
  }

  // List all processes
  list(filter = 'all') {
    const result = [];
    
    for (const [procId, info] of this.processes) {
      if (filter === 'all' || info.status === filter) {
        result.push({
          id: info.id,
          command: info.command,
          pid: info.pid,
          status: info.status,
          startTime: info.startTime,
          endTime: info.endTime || null
        });
      }
    }
    
    return result;
  }

  // Get running processes
  getRunning() {
    return this.list('running');
  }

  // Get completed/failed processes
  getCompleted() {
    const result = [];
    for (const [procId, info] of this.processes) {
      if (info.status === 'completed' || info.status === 'failed') {
        result.push({
          id: info.id,
          command: info.command,
          status: info.status,
          exitCode: info.exitCode,
          startTime: info.startTime,
          endTime: info.endTime
        });
      }
    }
    return result;
  }

  // Cleanup finished processes from memory (keep on disk)
  cleanup() {
    for (const [procId, info] of this.processes) {
      if (info.status !== 'running') {
        this.processes.delete(procId);
      }
    }
  }
}

// Singleton instance
const processManager = new ProcessManager();

class BashTool extends Tool {
  constructor() {
    super();
    this.processManager = processManager;
  }

  async run(commands, options = {}) {
    const logger = global.logger || console;

    // Normalize: accept array, string, or {command: string} / {commands: [...]}
    if (!Array.isArray(commands)) {
      if (typeof commands === 'string') {
        commands = [commands];
      } else if (commands && typeof commands.command === 'string') {
        commands = [commands.command];
      } else if (commands && Array.isArray(commands.commands)) {
        commands = commands.commands;
      } else {
        commands = [];
      }
    }

    const isBackground = options.background || false;

    logger.info(`BashTool.run: ${JSON.stringify(commands)}, background: ${isBackground}`);

    // Handle background execution
    if (isBackground && commands.length === 1) {
      return this.runBackground(commands[0]);
    }

    // Handle special commands for process management
    if (commands.length === 1) {
      const cmd = commands[0].trim();
      
      // List background processes
      if (cmd === 'jobs' || cmd === 'processes' || cmd === 'bg:list') {
        return this.listProcesses();
      }

      // Get running processes
      if (cmd === 'bg:running') {
        return [{ command: cmd, stdout: JSON.stringify(this.processManager.getRunning(), null, 2), stderr: '', error: null, exitCode: 0 }];
      }

      // Get completed processes
      if (cmd === 'bg:completed') {
        return [{ command: cmd, stdout: JSON.stringify(this.processManager.getCompleted(), null, 2), stderr: '', error: null, exitCode: 0 }];
      }

      // Parse status request: "bg:status <procId>"
      if (cmd.startsWith('bg:status ')) {
        const procId = cmd.split('bg:status ')[1].trim();
        return this.getProcessStatus(procId);
      }

      // Parse stdout request: "bg:stdout <procId>" or "bg:stdout <procId> --tail N"
      if (cmd.startsWith('bg:stdout ')) {
        return this.getProcessOutput(cmd, 'stdout');
      }

      // Parse stderr request: "bg:stderr <procId>" or "bg:stderr <procId> --tail N"
      if (cmd.startsWith('bg:stderr ')) {
        return this.getProcessOutput(cmd, 'stderr');
      }

      // Parse kill request: "bg:kill <procId>"
      if (cmd.startsWith('bg:kill ')) {
        const procId = cmd.split('bg:kill ')[1].trim();
        return this.killProcess(procId);
      }

      // Parse force kill request: "bg:kill! <procId>" or "bg:kill! <procId>"
      if (cmd.startsWith('bg:kill! ') || cmd.startsWith('bg:forcekill ')) {
        const procId = cmd.replace(/bg:(kill!|forcekill)\s+/, '').trim();
        return this.forceKillProcess(procId);
      }

      // Start background process: "bg:start <command>"
      if (cmd.startsWith('bg:start ') || cmd.startsWith('bg:run ')) {
        const command = cmd.replace(/bg:(start|run)\s+/, '').trim();
        return this.runBackground(command);
      }

      // Start curl download with progress: "curl:progress <url> -o <file>"
      if (cmd.startsWith('curl:progress ') || cmd.startsWith('download:start ')) {
        const command = cmd.replace(/curl:progress|download:start/, '').trim();
        // Add -# for progress bar, -L for follow redirects
        const enhancedCommand = command.replace(/^curl\s+/, 'curl -# -L ');
        return this.runBackground(enhancedCommand, true);
      }
    }

    // Default: synchronous execution
    return Promise.all(commands.map(cmd => {
      return new Promise((resolve) => {
        exec(cmd, { shell: '/bin/bash' }, (error, stdout, stderr) => {
          let result = {
            command: cmd,
            stdout: stdout ? stdout.trim() : '',
            stderr: stderr ? stderr.trim() : '',
            error: null,
            exitCode: 0
          };
          if (error) {
            logger.error(`Bash command failed: ${cmd} - ${error.message}`);
            result.error = error.message;
            result.exitCode = error.code || 1;
          }
          logger.debug(`Bash command result for '${cmd}': ${JSON.stringify(result)}`);
          resolve(result);
        });
      });
    }));
  }

  // Run a background process
  runBackground(command, monitorProgress = false) {
    const logger = global.logger || console;
    
    const procInfo = this.processManager.spawn(command);
    
    logger.info(`Started background process: ${procInfo.id}`);

    // If it's a curl download with progress, return initial status
    if (monitorProgress && command.includes('curl')) {
      return [{
        command: command,
        stdout: JSON.stringify({
          message: `Background download started`,
          processId: procInfo.id,
          pid: procInfo.pid,
          command: command,
          checkStatus: `Use 'bg:status ${procInfo.id}' to check status`,
          checkOutput: `Use 'bg:stdout ${procInfo.id}' to see output`,
          killProcess: `Use 'bg:kill ${procInfo.id}' to cancel`
        }, null, 2),
        stderr: '',
        error: null,
        exitCode: 0
      }];
    }

    return [{
      command: command,
      stdout: JSON.stringify({
        message: 'Background process started',
        processId: procInfo.id,
        pid: procInfo.pid,
        command: command,
        status: procInfo.status,
        checkStatus: `Use 'bg:status ${procInfo.id}' to check status`,
        checkOutput: `Use 'bg:stdout ${procInfo.id}' or 'bg:stderr ${procInfo.id}' to see output`,
        checkTail: `Use 'bg:stdout ${procInfo.id} --tail 20' for last 20 lines`,
        killProcess: `Use 'bg:kill ${procInfo.id}' to cancel`,
        listAll: `Use 'jobs' or 'processes' to list all background processes`
      }, null, 2),
      stderr: '',
      error: null,
      exitCode: 0
    }];
  }

  // List all processes
  listProcesses() {
    const running = this.processManager.getRunning();
    const completed = this.processManager.getCompleted();

    return [{
      command: 'jobs',
      stdout: JSON.stringify({
        running: running,
        completed: completed,
        totalRunning: running.length,
        totalCompleted: completed.length,
        usage: {
          startBackground: 'bg:start <command> or bg:run <command>',
          startDownload: 'curl:progress <curl args> or download:start <curl args>',
          checkStatus: 'bg:status <processId>',
          checkStdout: 'bg:stdout <processId> or bg:stdout <processId> --tail N',
          checkStderr: 'bg:stderr <processId> or bg:stderr <processId> --tail N',
          killProcess: 'bg:kill <processId>',
          forceKill: 'bg:kill! <processId> or bg:forcekill <processId>',
          listRunning: 'bg:running',
          listCompleted: 'bg:completed'
        }
      }, null, 2),
      stderr: '',
      error: null,
      exitCode: 0
    }];
  }

  // Get process status
  getProcessStatus(procId) {
    const status = this.processManager.getStatus(procId);
    
    if (!status) {
      return [{
        command: `bg:status ${procId}`,
        stdout: '',
        stderr: `Process ${procId} not found`,
        error: `Process ${procId} not found`,
        exitCode: 1
      }];
    }

    return [{
      command: `bg:status ${procId}`,
      stdout: JSON.stringify(status, null, 2),
      stderr: '',
      error: null,
      exitCode: 0
    }];
  }

  // Get process output (stdout or stderr)
  getProcessOutput(cmd, stream) {
    // Parse command: "bg:stdout <procId> --tail N"
    const parts = cmd.replace(`bg:${stream}`, '').trim().split('--tail');
    const procId = parts[0].trim();
    const tailLines = parts[1] ? parseInt(parts[1].trim(), 10) : 0;

    let content;
    if (tailLines > 0) {
      content = this.processManager.getRecentOutput(procId, tailLines, stream);
    } else {
      content = stream === 'stdout' 
        ? this.processManager.getStdout(procId) 
        : this.processManager.getStderr(procId);
    }

    const status = this.processManager.getStatus(procId);
    
    return [{
      command: cmd,
      stdout: content,
      stderr: '',
      error: null,
      exitCode: 0,
      _meta: status ? { processStatus: status.status, processId: procId } : null
    }];
  }

  // Kill a process
  killProcess(procId) {
    const result = this.processManager.kill(procId);
    
    return [{
      command: `bg:kill ${procId}`,
      stdout: JSON.stringify(result, null, 2),
      stderr: result.success ? '' : result.message,
      error: result.success ? null : result.message,
      exitCode: result.success ? 0 : 1
    }];
  }

  // Force kill a process
  forceKillProcess(procId) {
    const result = this.processManager.forceKill(procId);
    
    return [{
      command: `bg:kill! ${procId}`,
      stdout: JSON.stringify(result, null, 2),
      stderr: result.success ? '' : result.message,
      error: result.success ? null : result.message,
      exitCode: result.success ? 0 : 1
    }];
  }

  getContext() {
    const logger = global.logger || console;
    const registryPath = path.join(__dirname, 'registry.md');
    if (fs.existsSync(registryPath)) {
      //logger.debug(`Loaded bash registry from ${registryPath}`);
      return fs.readFileSync(registryPath, 'utf8');
    } else {
      logger.warn(`Bash registry file not found: ${registryPath}`);
      return '';
    }
  }
}

// Export both the tool and the process manager
module.exports = BashTool;
module.exports.ProcessManager = ProcessManager;
