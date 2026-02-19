const Tool = require('../tool_prototype');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const { CRON_DB: DB_PATH } = require('../../core/paths');

class CronJobsTool extends Tool {
  constructor() {
    super();
    this._schedulerStarted = false;
    this.ready = this._init();
  }

  async _init() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await this.db.run('PRAGMA journal_mode=WAL');
    await this.db.run('PRAGMA busy_timeout=5000');
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        action      TEXT NOT NULL,
        schedule    TEXT,
        time        TEXT,
        interval_ms INTEGER,
        disabled    INTEGER NOT NULL DEFAULT 0,
        last_fired  TEXT,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  // --- Scheduler ---

  async init() {
    await this.ready;
    if (this._schedulerStarted) return;
    this._schedulerStarted = true;
    setInterval(() => this._tick(), 60_000);
  }

  async _tick() {
    const logger = global.logger || console;
    try {
      const jobs = await this.db.all('SELECT * FROM cron_jobs WHERE disabled = 0');
      const now = new Date();
      for (const row of jobs) {
        const job = this._rowToJob(row);
        if (this._shouldFire(job, now)) {
          logger.info(`[CronJobsTool] Firing job ${job.id} (${job.type})`);
          await this._fireJob(job);
          const fired = now.toISOString();
          if (job.type === 'one_time') {
            await this.db.run('DELETE FROM cron_jobs WHERE id = ?', [job.id]);
          } else {
            await this.db.run('UPDATE cron_jobs SET last_fired = ? WHERE id = ?', [fired, job.id]);
          }
        }
      }
    } catch (err) {
      logger.error(`[CronJobsTool] Scheduler tick error: ${err.message}`);
    }
  }

  _shouldFire(job, date) {
    if (job.type === 'one_time') {
      return new Date(job.time) <= date;
    }
    if (job.type === 'interval') {
      return !job.lastFired || (date - new Date(job.lastFired)) >= job.intervalMs;
    }
    if (job.type === 'schedule') {
      const s = job.schedule;
      const sameMinute = job.lastFired &&
        new Date(job.lastFired).getTime() >= new Date(date).setSeconds(0, 0);
      return s.days.includes(date.getDay()) &&
        date.getHours() === s.hour &&
        date.getMinutes() === s.minute &&
        !sameMinute;
    }
    return false;
  }

  async _fireJob(job) {
    if (job.action.type === 'prompt') {
      const { runPrompt } = require('../../core/prompt');
      await runPrompt({ prompt: job.action.prompt }, () => {});
    } else if (job.action.type === 'bash') {
      exec(job.action.command, (err, stdout, stderr) => {
        const logger = global.logger || console;
        if (err) logger.error(`[CronJobsTool] bash job ${job.id} error: ${err.message}`);
      });
    }
  }

  // --- Row <-> job object conversion ---

  _rowToJob(row) {
    return {
      id:         row.id,
      type:       row.type,
      action:     JSON.parse(row.action),
      schedule:   row.schedule ? JSON.parse(row.schedule) : undefined,
      time:       row.time || undefined,
      intervalMs: row.interval_ms || undefined,
      disabled:   !!row.disabled,
      lastFired:  row.last_fired || undefined,
      createdAt:  row.created_at,
    };
  }

  // --- run() dispatch ---

  async run(args) {
    await this.ready;
    const logger = global.logger || console;

    // Normalize: accept { job: [...] }, [...], or { op, ... }
    let action, jobData;
    if (args && typeof args === 'object' && !Array.isArray(args) && args.job) {
      [action, jobData] = args.job;
    } else if (Array.isArray(args)) {
      [action, jobData] = args;
    } else if (args && typeof args === 'object' && args.op) {
      action = args.op;
      jobData = args;
    } else {
      return { success: false, error: 'Invalid arguments' };
    }

    // Detect flat key-value array (LLM mistake): ["add", "type", "interval", ...]
    if (action === 'add' && Array.isArray(args) && args.length > 2 && typeof jobData !== 'object') {
      logger.warn('[CronJobsTool] Flat key-value array detected — reconstructing job object');
      const reconstructed = {};
      for (let i = 1; i + 1 < args.length; i += 2) {
        if (typeof args[i] === 'string') reconstructed[args[i]] = args[i + 1];
      }
      jobData = reconstructed;
    }

    switch (action) {
      case 'list':    return this._list();
      case 'add':     return this._add(jobData);
      case 'remove':  return this._remove(typeof jobData === 'string' ? jobData : jobData?.id);
      case 'enable':  return this._setDisabled(typeof jobData === 'string' ? jobData : jobData?.id, false);
      case 'disable': return this._setDisabled(typeof jobData === 'string' ? jobData : jobData?.id, true);
      default:        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  // --- Operations ---

  async _list() {
    const rows = await this.db.all('SELECT * FROM cron_jobs ORDER BY created_at');
    return { success: true, jobs: rows.map(r => this._rowToJob(r)) };
  }

  async _add(job) {
    if (!job || typeof job !== 'object') {
      return { success: false, error: 'Job must be an object' };
    }

    // Normalize: delay (seconds) -> time for one_time
    if (job.type === 'one_time' && job.delay && !job.time) {
      job.time = new Date(Date.now() + (Number(job.delay) * 1000)).toISOString();
      delete job.delay;
    }

    // Normalize: message -> action.prompt
    if (job.message && !job.action) {
      job.action = { type: 'prompt', prompt: job.message };
      delete job.message;
    }
    if (job.action?.message && !job.action?.prompt) {
      job.action.prompt = job.action.message;
      delete job.action.message;
    }

    // Validate
    if (!job.action) return { success: false, error: 'Job must include an action field' };
    if (!['prompt', 'bash'].includes(job.action.type)) {
      return { success: false, error: 'action.type must be "prompt" or "bash"' };
    }
    if (job.action.type === 'prompt' && !job.action.prompt) {
      return { success: false, error: 'prompt action requires a prompt field' };
    }
    if (job.action.type === 'bash' && !job.action.command) {
      return { success: false, error: 'bash action requires a command field' };
    }
    if (!['one_time', 'interval', 'schedule'].includes(job.type)) {
      return { success: false, error: 'type must be one_time, interval, or schedule' };
    }
    if (job.type === 'one_time' && !job.time) {
      return { success: false, error: 'one_time job requires a time (ISO8601) or delay (seconds) field' };
    }
    if (job.type === 'interval' && !job.intervalMs) {
      return { success: false, error: 'interval job requires an intervalMs field' };
    }
    if (job.type === 'schedule' && !job.schedule) {
      return { success: false, error: 'schedule job requires a schedule field' };
    }

    const id = job.id || (Math.random().toString(36).slice(2) + Date.now());
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO cron_jobs (id, type, action, schedule, time, interval_ms, disabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         type=excluded.type, action=excluded.action, schedule=excluded.schedule,
         time=excluded.time, interval_ms=excluded.interval_ms`,
      [
        id,
        job.type,
        JSON.stringify(job.action),
        job.schedule ? JSON.stringify(job.schedule) : null,
        job.time || null,
        job.intervalMs || null,
        now,
      ]
    );

    return { success: true, added: { ...job, id } };
  }

  async _remove(id) {
    if (!id) return { success: false, error: 'Missing job id' };
    const result = await this.db.run('DELETE FROM cron_jobs WHERE id = ?', [id]);
    if (result.changes === 0) return { success: false, error: `Job not found: ${id}` };
    return { success: true, removed: id };
  }

  async _setDisabled(id, disabled) {
    if (!id) return { success: false, error: 'Missing job id' };
    const result = await this.db.run(
      'UPDATE cron_jobs SET disabled = ? WHERE id = ?',
      [disabled ? 1 : 0, id]
    );
    if (result.changes === 0) return { success: false, error: `Job not found: ${id}` };
    return { success: true, id, disabled };
  }

  getContext() {
    const registryPath = path.join(__dirname, 'registry.md');
    try { return fs.readFileSync(registryPath, 'utf8'); } catch { return ''; }
  }
}

module.exports = CronJobsTool;
