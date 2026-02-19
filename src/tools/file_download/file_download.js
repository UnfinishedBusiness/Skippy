const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const Tool = require('../tool_prototype');

const DEFAULT_DOWNLOAD_DIR = path.join(__dirname, '../../../workspace/downloads');
const MAX_REDIRECTS = 10;
// Rolling window size for speed calculation (samples)
const SPEED_WINDOW = 8;

function formatBytes(bytes) {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function filenameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const base = path.basename(u.pathname);
    return base || 'download';
  } catch {
    return 'download';
  }
}

function filenameFromHeader(header) {
  if (!header) return null;
  const match = header.match(/filename\*?=(?:UTF-8'')?["']?([^;"'\r\n]+)["']?/i);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

class FileDownloadTool extends Tool {
  constructor() {
    super();
    this.downloads = new Map(); // id -> state
  }

  getContext() {
    const registryPath = path.join(__dirname, 'registry.md');
    try { return fs.readFileSync(registryPath, 'utf8'); } catch { return ''; }
  }

  async run(args) {
    const logger = global.logger || console;
    let op, params = {};

    if (Array.isArray(args)) {
      [op, ...params] = args;
      params = params[0] || {};
    } else if (args && typeof args === 'object') {
      ({ op, ...params } = args);
    } else {
      return { success: false, error: 'Invalid arguments' };
    }

    const required = {
      download: ['url'],
      status:   [],
      cancel:   ['id'],
    };
    if (required[op]) {
      for (const f of required[op]) {
        if (params[f] == null) return { success: false, error: `Missing required parameter: ${f}` };
      }
    }

    switch (op) {
      case 'download': return this._startDownload(params);
      case 'status':   return this._getStatus(params.id);
      case 'list':     return this._listDownloads();
      case 'cancel':   return this._cancelDownload(params.id);
      default:         return { success: false, error: `Unknown operation: ${op}` };
    }
  }

  // --- Operations ---

  _startDownload({ url, dest, filename, notifyUser }) {
    const logger = global.logger || console;

    // Validate URL
    try { new URL(url); } catch {
      return { success: false, error: `Invalid URL: ${url}` };
    }

    const downloadDir = dest
      ? (path.extname(dest) ? path.dirname(dest) : dest)
      : DEFAULT_DOWNLOAD_DIR;

    fs.mkdirSync(downloadDir, { recursive: true });

    const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const state = {
      id,
      url,
      filename: filename || null,  // resolved when headers arrive
      destPath: null,              // resolved when headers arrive
      downloadDir,
      notifyUser: notifyUser || null,
      status: 'pending',
      bytesDownloaded: 0,
      totalBytes: null,
      startTime: Date.now(),
      completedTime: null,
      error: null,
      _speedSamples: [],           // [{ t, bytes }]
      _req: null,
      _fileStream: null,
    };

    this.downloads.set(id, state);
    logger.info(`[FileDownloadTool] Starting download ${id}: ${url}`);

    // Fire and forget — runs in the background
    this._doDownload(state).catch(err => {
      logger.error(`[FileDownloadTool] Unhandled error in download ${id}: ${err.message}`);
    });

    return {
      success: true,
      id,
      message: `Download started. Use op="status" with id="${id}" to check progress.`,
    };
  }

  _getStatus(id) {
    if (!id) {
      // Return all downloads
      const all = [...this.downloads.values()].map(d => this._publicState(d));
      return { success: true, downloads: all };
    }
    const dl = this.downloads.get(id);
    if (!dl) return { success: false, error: `No download found with id: ${id}` };
    return { success: true, ...this._publicState(dl) };
  }

  _listDownloads() {
    const list = [...this.downloads.values()].map(d => this._publicState(d));
    return { success: true, count: list.length, downloads: list };
  }

  _cancelDownload(id) {
    const dl = this.downloads.get(id);
    if (!dl) return { success: false, error: `No download found with id: ${id}` };
    if (['completed', 'failed', 'cancelled'].includes(dl.status)) {
      return { success: false, error: `Download already ${dl.status}` };
    }
    if (dl._req) dl._req.destroy();
    if (dl._fileStream) dl._fileStream.destroy();
    dl.status = 'cancelled';
    dl.completedTime = Date.now();
    return { success: true, message: `Download ${id} cancelled (${formatBytes(dl.bytesDownloaded)} received)` };
  }

  // --- Core download logic ---

  async _doDownload(state, url = state.url, redirectCount = 0) {
    const logger = global.logger || console;

    return new Promise((resolve) => {
      let urlObj;
      try { urlObj = new URL(url); } catch (err) {
        state.status = 'failed';
        state.error = `Invalid URL: ${url}`;
        state.completedTime = Date.now();
        this._sendCompletionDM(state);
        return resolve();
      }

      const lib = urlObj.protocol === 'https:' ? https : http;
      state.status = 'downloading';

      const req = lib.get(url, (res) => {
        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= MAX_REDIRECTS) {
            state.status = 'failed';
            state.error = `Too many redirects (>${MAX_REDIRECTS})`;
            state.completedTime = Date.now();
            this._sendCompletionDM(state);
            return resolve();
          }
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${urlObj.protocol}//${urlObj.host}${res.headers.location}`;
          logger.debug(`[FileDownloadTool] ${state.id} redirect ${redirectCount + 1}: ${nextUrl}`);
          res.resume();
          return this._doDownload(state, nextUrl, redirectCount + 1).then(resolve);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          state.status = 'failed';
          state.error = `HTTP ${res.statusCode} ${res.statusMessage}`;
          state.completedTime = Date.now();
          this._sendCompletionDM(state);
          res.resume();
          return resolve();
        }

        // Resolve filename
        if (!state.filename) {
          state.filename = filenameFromHeader(res.headers['content-disposition'])
            || filenameFromUrl(url);
        }
        // Ensure unique path
        let destPath = path.join(state.downloadDir, state.filename);
        let counter = 1;
        while (fs.existsSync(destPath)) {
          const ext = path.extname(state.filename);
          const base = path.basename(state.filename, ext);
          destPath = path.join(state.downloadDir, `${base}(${counter++})${ext}`);
        }
        state.destPath = destPath;
        state.totalBytes = res.headers['content-length']
          ? parseInt(res.headers['content-length'], 10)
          : null;

        logger.info(`[FileDownloadTool] ${state.id} → ${state.destPath} (${formatBytes(state.totalBytes)})`);

        const fileStream = fs.createWriteStream(destPath);
        state._fileStream = fileStream;

        fileStream.on('error', (err) => {
          state.status = 'failed';
          state.error = `File write error: ${err.message}`;
          state.completedTime = Date.now();
          req.destroy();
          logger.error(`[FileDownloadTool] ${state.id} write error: ${err.message}`);
          this._sendCompletionDM(state);
          resolve();
        });

        res.on('data', (chunk) => {
          if (state.status === 'cancelled') return;
          state.bytesDownloaded += chunk.length;
          // Rolling speed window
          const now = Date.now();
          state._speedSamples.push({ t: now, bytes: state.bytesDownloaded });
          if (state._speedSamples.length > SPEED_WINDOW) state._speedSamples.shift();
        });

        res.on('end', () => {
          fileStream.end(() => {
            if (state.status === 'cancelled') return resolve();
            state.status = 'completed';
            state.completedTime = Date.now();
            const elapsed = state.completedTime - state.startTime;
            const avgSpeed = elapsed > 0 ? Math.round(state.bytesDownloaded / (elapsed / 1000)) : 0;
            logger.info(`[FileDownloadTool] ${state.id} complete — ${formatBytes(state.bytesDownloaded)} in ${formatDuration(elapsed)} (${formatBytes(avgSpeed)}/s)`);
            this._sendCompletionDM(state);
            resolve();
          });
        });

        res.on('error', (err) => {
          state.status = 'failed';
          state.error = err.message;
          state.completedTime = Date.now();
          logger.error(`[FileDownloadTool] ${state.id} stream error: ${err.message}`);
          this._sendCompletionDM(state);
          resolve();
        });

        res.pipe(fileStream);
      });

      req.on('error', (err) => {
        if (state.status === 'cancelled') return resolve();
        state.status = 'failed';
        state.error = err.message;
        state.completedTime = Date.now();
        logger.error(`[FileDownloadTool] ${state.id} request error: ${err.message}`);
        this._sendCompletionDM(state);
        resolve();
      });

      state._req = req;
    });
  }

  // --- Helpers ---

  _currentSpeed(state) {
    const samples = state._speedSamples;
    if (samples.length < 2) return null;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = last.t - first.t;
    if (elapsed === 0) return null;
    return Math.round((last.bytes - first.bytes) / (elapsed / 1000));
  }

  _publicState(dl) {
    const elapsed = dl.completedTime
      ? dl.completedTime - dl.startTime
      : Date.now() - dl.startTime;
    const speed = dl.status === 'downloading' ? this._currentSpeed(dl) : null;
    const percent = dl.totalBytes
      ? Math.min(100, Math.round((dl.bytesDownloaded / dl.totalBytes) * 100))
      : null;
    const eta = speed && dl.totalBytes && dl.bytesDownloaded < dl.totalBytes
      ? Math.round((dl.totalBytes - dl.bytesDownloaded) / speed)
      : null;

    return {
      id:                   dl.id,
      url:                  dl.url,
      filename:             dl.filename,
      destPath:             dl.destPath,
      status:               dl.status,
      bytesDownloaded:      dl.bytesDownloaded,
      totalBytes:           dl.totalBytes,
      percent:              percent,
      speedBytesPerSec:     speed,
      elapsedMs:            elapsed,
      etaSecs:              eta,
      error:                dl.error || null,
      // Human-readable
      bytesDownloadedHuman: formatBytes(dl.bytesDownloaded),
      totalBytesHuman:      formatBytes(dl.totalBytes),
      speedHuman:           speed != null ? `${formatBytes(speed)}/s` : null,
      elapsedHuman:         formatDuration(elapsed),
      etaHuman:             eta != null ? formatDuration(eta * 1000) : null,
    };
  }

  async _sendCompletionDM(state) {
    if (!state.notifyUser) return;
    const logger = global.logger || console;
    try {
      // Lazy require to avoid circular dependency at module load
      const { sendDiscordMessage } = require('../../core/discord');
      const elapsed = state.completedTime
        ? state.completedTime - state.startTime
        : Date.now() - state.startTime;
      const avgSpeed = elapsed > 0
        ? Math.round(state.bytesDownloaded / (elapsed / 1000))
        : 0;

      let message;
      if (state.status === 'completed') {
        message = [
          `📥 **Download complete:** \`${state.filename}\``,
          `**Size:** ${formatBytes(state.bytesDownloaded)}`,
          `**Saved to:** \`${state.destPath}\``,
          `**Duration:** ${formatDuration(elapsed)}`,
          `**Avg speed:** ${formatBytes(avgSpeed)}/s`,
        ].join('\n');
      } else if (state.status === 'failed') {
        message = [
          `❌ **Download failed:** \`${state.filename || state.url}\``,
          `**Error:** ${state.error}`,
          `**Received:** ${formatBytes(state.bytesDownloaded)}${state.totalBytes ? ` / ${formatBytes(state.totalBytes)}` : ''}`,
          `**Duration:** ${formatDuration(elapsed)}`,
          `**URL:** ${state.url}`,
        ].join('\n');
      } else {
        return; // Don't DM for cancellations
      }

      await sendDiscordMessage({ targetType: 'user', target: state.notifyUser, message });
      logger.info(`[FileDownloadTool] Sent completion DM to ${state.notifyUser} for download ${state.id}`);
    } catch (err) {
      logger.warn(`[FileDownloadTool] Failed to send completion DM: ${err.message}`);
    }
  }
}

module.exports = FileDownloadTool;
