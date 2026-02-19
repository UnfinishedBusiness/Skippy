/**
 * IPC layer between the CLI and the daemon.
 * Uses a Unix domain socket with newline-delimited JSON messages.
 *
 * Protocol (all messages are JSON objects terminated by \n):
 *   CLI → Daemon:  { type: "prompt", prompt, output, channel, user }
 *   Daemon → CLI:  { type: "chunk",  content }   — streamed answer tokens
 *                  { type: "status", content }   — status lines (tool calls, etc.)
 *                  { type: "done",   content }   — final complete answer
 *                  { type: "error",  message }   — error
 */

const net = require('net');
const fs  = require('fs');

const { SOCKET_PATH } = require('./paths');

// ---- Server ----------------------------------------------------------------

/**
 * Starts the IPC server inside the daemon.
 * onRequest(req, conn) is called for each incoming request.
 * conn = { send(obj), end() }
 */
function startIpcServer(onRequest) {
  const logger = global.logger || console;

  // Remove a stale socket from a previous run
  try { fs.unlinkSync(SOCKET_PATH); } catch {}

  const server = net.createServer((socket) => {
    let buf = '';

    socket.on('data', (data) => {
      buf += data.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch {
          socket.write(JSON.stringify({ type: 'error', message: 'Invalid JSON' }) + '\n');
          socket.end();
          return;
        }
        const conn = {
          send: (obj) => {
            try { socket.write(JSON.stringify(obj) + '\n'); } catch {}
          },
          end: () => {
            try { socket.end(); } catch {}
          },
        };
        onRequest(req, conn);
      }
    });

    socket.on('error', (err) => {
      logger.warn(`[IPC] Socket error: ${err.message}`);
    });
  });

  server.on('error', (err) => {
    logger.error(`[IPC] Server error: ${err.message}`);
  });

  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600); // owner-only access
    logger.info(`[IPC] Listening on ${SOCKET_PATH}`);
  });

  return server;
}

// ---- Client ----------------------------------------------------------------

/**
 * Sends a request to the daemon and returns a Promise that resolves with the
 * final { type: "done", content } message.
 *
 * onChunk(content) is called for each streamed token (type: "chunk").
 * onStatus(content) is called for status lines (type: "status").
 */
function sendIpcRequest(request, { onChunk, onStatus } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);

    socket.setTimeout(300_000); // 5-minute hard timeout

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    let buf = '';

    socket.on('data', (data) => {
      buf += data.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'chunk'  && onChunk)  onChunk(msg.content);
        if (msg.type === 'status' && onStatus) onStatus(msg.content);
        if (msg.type === 'done')  { socket.destroy(); resolve(msg); }
        if (msg.type === 'error') { socket.destroy(); reject(new Error(msg.message)); }
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('IPC request timed out'));
    });

    socket.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new Error('Skippy is not running. Start it with: ./skippy start'));
      } else {
        reject(err);
      }
    });

    socket.on('close', () => {
      // If we closed without a done/error message, treat as abrupt disconnect
      reject(new Error('Daemon disconnected unexpectedly'));
    });
  });
}

module.exports = { startIpcServer, sendIpcRequest, SOCKET_PATH };
