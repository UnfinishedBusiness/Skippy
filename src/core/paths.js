'use strict';

const path = require('path');
const os   = require('os');

const SKIPPY_DIR   = path.join(os.homedir(), '.Skippy');
const CONFIG_FILE  = path.join(SKIPPY_DIR, 'Skippy.json');
const MEMORY_DIR   = path.join(SKIPPY_DIR, 'memory');
const MEMORY_DB    = path.join(MEMORY_DIR, 'memory.db');
const CRON_DB      = path.join(MEMORY_DIR, 'cron.db');
const CONTEXT_FILE = path.join(SKIPPY_DIR, 'context.json');
const SOCKET_PATH  = path.join(SKIPPY_DIR, 'skippy.sock');
const LOG_FILE     = path.join(SKIPPY_DIR, 'Skippy.log');
const PID_FILE     = path.join(SKIPPY_DIR, 'daemon.pid');

module.exports = {
  SKIPPY_DIR,
  CONFIG_FILE,
  MEMORY_DIR,
  MEMORY_DB,
  CRON_DB,
  CONTEXT_FILE,
  SOCKET_PATH,
  LOG_FILE,
  PID_FILE,
};
