// src/tools/memory/memory.js

const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const Tool = require('../tool_prototype');
const logger = global.logger || console;

class MemoryTool extends Tool {
  getContext() {
    const registryPath = path.join(__dirname, 'registry.md');
    try {
      return fs.readFileSync(registryPath, 'utf8');
    } catch {
      return '';
    }
  }

  constructor(dbPath = require('../../core/paths').MEMORY_DB) {
    super();
    this.dbPath = dbPath;
    this.db = null;
    // _init() throws on failure so this.ready rejects; every method's
    // await this.ready will then throw and be caught by its own try/catch.
    this.ready = this._init();
  }

  // --- Deep merge helper (non-destructive, handles nested objects) ---
  _deepMerge(target, source) {
    const out = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] === null) {
        delete out[key];  // null means "remove this key"
      } else if (
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        target[key] !== null &&
        !Array.isArray(target[key])
      ) {
        out[key] = this._deepMerge(target[key], source[key]);
      } else {
        out[key] = source[key];
      }
    }
    return out;
  }

  /**
   * Main tool entrypoint. Accepts either an array or object.
   * Example array: ['setGlobal', key, value, category, tags]
   * Example object: { op: 'setGlobal', key, value, category, tags }
   */
  async run(args) {
    let op, params = {};
    if (Array.isArray(args)) {
      // Model sometimes wraps the params object in an array:
      //   [{op, key, value, ...}]  →  treat as plain object
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        op = args[0].op;
        params = { ...args[0] };
      }
      // Model sometimes sends op string + params object:
      //   ['setGlobal', {key, value, category}]  →  merge into params
      else if (typeof args[0] === 'string' && args.length === 2 && args[1] && typeof args[1] === 'object') {
        op = args[0];
        params = { ...args[1] };
      }
      // Original positional format: ['setGlobal', key, value, category, tags]
      else {
      op = args[0];
      switch (op) {
        case 'setGlobal':
          [, params.key, params.value, params.category, params.tags] = args; break;
        case 'getGlobal':
          [, params.key] = args; break;
        case 'deleteGlobal':
          [, params.key] = args; break;
        case 'listGlobal':
          [, params.category] = args; break;
        case 'searchGlobal':
          [, params.query] = args; break;
        case 'setChannel':
          [, params.channelName, params.key, params.value, params.category, params.tags] = args; break;
        case 'getChannel':
          [, params.channelName, params.key] = args; break;
        case 'deleteChannel':
          [, params.channelName, params.key] = args; break;
        case 'getChannelByCategory':
          [, params.channelName, params.category] = args; break;
        case 'listChannelKeys':
          [, params.channelName] = args; break;
        case 'purgeChannel':
          [, params.channelName] = args; break;
        case 'createSkill':
          [, params.name, params.description, params.initialStructure, params.owner, params.instructions] = args; break;
        case 'updateSkill':
          [, params.name, params.newData, params.trainingIncrement] = args; break;
        case 'getSkill':
          [, params.name] = args; break;
        case 'listSkills':
          break;
        case 'listSkillsForUser':
          [, params.username] = args; break;
        case 'deleteSkill':
          [, params.name] = args; break;
        case 'search':
          [, params.query] = args; break;
        default:
          return { success: false, error: `Unknown operation: ${op}` };
      }
      }
    } else if (args && typeof args === 'object') {
      op = args.op;
      params = { ...args };
    } else {
      return { success: false, error: 'Invalid arguments' };
    }

    // Validate required params per operation before dispatching
    const required = {
      setGlobal:           ['key', 'value'],
      getGlobal:           ['key'],
      deleteGlobal:        ['key'],
      searchGlobal:        ['query'],
      setChannel:          ['channelName', 'key', 'value'],
      getChannel:          ['channelName', 'key'],
      deleteChannel:       ['channelName', 'key'],
      getChannelByCategory:['channelName', 'category'],
      listChannelKeys:     ['channelName'],
      createSkill:         ['name', 'description'],
      listSkillsForUser:   ['username'],
      updateSkill:         ['name', 'newData'],
      getSkill:            ['name'],
      deleteSkill:         ['name'],
      search:              ['query'],
    };
    if (required[op]) {
      for (const field of required[op]) {
        if (params[field] === undefined || params[field] === null) {
          return { success: false, error: `Missing required parameter: ${field}` };
        }
      }
    }

    try {
      switch (op) {
        case 'setGlobal':            return await this.setGlobal(params.key, params.value, params.category, params.tags);
        case 'getGlobal':            return await this.getGlobal(params.key);
        case 'deleteGlobal':         return await this.deleteGlobal(params.key);
        case 'listGlobal':           return await this.listGlobal(params.category);
        case 'searchGlobal':         return await this.searchGlobal(params.query);
        case 'setChannel':           return await this.setChannel(params.channelName, params.key, params.value, params.category, params.tags);
        case 'getChannel':           return await this.getChannel(params.channelName, params.key);
        case 'deleteChannel':        return await this.deleteChannel(params.channelName, params.key);
        case 'getChannelByCategory': return await this.getChannelByCategory(params.channelName, params.category);
        case 'listChannelKeys':      return await this.listChannelKeys(params.channelName);
        case 'purgeChannel':         return await this.purgeChannel(params.channelName);
        case 'listChannels':         return await this.listChannels();
        case 'createSkill':          return await this.createSkill(params.name, params.description, params.initialStructure, params.owner, params.instructions);
        case 'updateSkill':          return await this.updateSkill(params.name, params.newData, params.trainingIncrement);
        case 'getSkill':             return await this.getSkill(params.name);
        case 'listSkills':           return await this.listSkills();
        case 'listSkillsForUser':    return await this.listSkillsForUser(params.username);
        case 'deleteSkill':          return await this.deleteSkill(params.name);
        case 'search':               return await this.search(params.query);
        default:
          return { success: false, error: `Unknown operation: ${op}` };
      }
    } catch (error) {
      logger.error(`MemoryTool.run error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // Throws on failure — so this.ready rejects and every awaiting method gets
  // a clean, descriptive error via its try/catch rather than crashing on null db.
  async _init() {
    this.db = await open({
      filename: this.dbPath,
      driver: sqlite3.Database,
    });
    await this.db.run('PRAGMA journal_mode=WAL');
    await this.db.run('PRAGMA busy_timeout=5000');
    await this.db.run(`CREATE TABLE IF NOT EXISTS global_memories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT UNIQUE NOT NULL,
      value      TEXT,
      category   TEXT DEFAULT 'general',
      tags       TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_global_key      ON global_memories(key)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_global_category ON global_memories(category)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_global_tags     ON global_memories(tags)`);
    await this.db.run(`CREATE TABLE IF NOT EXISTS skills (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT UNIQUE NOT NULL,
      description       TEXT,
      skill_data        TEXT,
      training_progress TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_skill_name ON skills(name)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_skill_desc ON skills(description)`);
    // Migration: add owner column to existing DBs (no-op if already present)
    try {
      await this.db.run(`ALTER TABLE skills ADD COLUMN owner TEXT NOT NULL DEFAULT 'global'`);
    } catch (_) { /* column already exists */ }
    // Migration: add instructions column to existing DBs (no-op if already present)
    try {
      await this.db.run(`ALTER TABLE skills ADD COLUMN instructions TEXT`);
    } catch (_) { /* column already exists */ }
  }

  // --- Utility ---
  _sanitizeChannelName(name) {
    // Strip anything that's not alphanumeric or underscore.
    // Hyphens (common in Discord channel names like "mega-furnace") are stripped,
    // not replaced with underscore, to avoid collisions with channels that use underscores.
    return name.replace(/[^a-zA-Z0-9_]/g, '');
  }

  _jsonStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      logger.warn(`MemoryTool: JSON.stringify failed: ${e.message}`);
      throw new Error(`Value cannot be serialized to JSON: ${e.message}`);
    }
  }

  _jsonParse(str) {
    if (str === null || str === undefined) return null;
    try {
      return JSON.parse(str);
    } catch {
      // Return raw string so data is never silently dropped
      logger.warn(`MemoryTool: JSON.parse failed, returning raw value`);
      return str;
    }
  }

  // Sanitize tags: strip commas from individual tags to prevent split corruption
  _sanitizeTags(tags) {
    if (!tags && tags !== 0) return '';
    const arr = Array.isArray(tags) ? tags : String(tags).split(',');
    return arr
      .map(t => String(t).trim().replace(/,/g, ''))
      .filter(Boolean)
      .join(',');
  }

  // Build a tokenized WHERE clause for full-text-style search.
  // Returns null if the query is empty (callers should reject empty queries).
  _buildSearchWhere(query, columns) {
    const tokens = String(query)
      .toLowerCase()
      .replace(/_/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    if (tokens.length === 0) return null;

    const wheres = [];
    const params = [];
    for (const token of tokens) {
      const colClauses = columns.map(col => `LOWER(REPLACE(${col}, '_', ' ')) LIKE ?`);
      wheres.push(`(${colClauses.join(' OR ')})`);
      for (let i = 0; i < columns.length; i++) params.push(`%${token}%`);
    }
    return { where: wheres.join(' OR '), params };
  }

  // Shared row formatter
  _formatRow(row, extra = {}) {
    return {
      key:        row.key,
      value:      this._jsonParse(row.value),
      category:   row.category || 'general',
      tags:       row.tags ? row.tags.split(',').filter(Boolean) : [],
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...extra,
    };
  }

  async ensureChannelTable(channelName) {
    const table = `channel_memories_${this._sanitizeChannelName(channelName)}`;
    await this.db.run(`CREATE TABLE IF NOT EXISTS ${table} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT UNIQUE NOT NULL,
      value      TEXT,
      category   TEXT DEFAULT 'general',
      tags       TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_key      ON ${table}(key)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_category ON ${table}(category)`);
    await this.db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_tags     ON ${table}(tags)`);
    return table;
  }

  // --- Global Memory ---
  async setGlobal(key, value, category = 'general', tags = []) {
    await this.ready;
    try {
      const tagsStr   = this._sanitizeTags(tags);
      const valueStr  = this._jsonStringify(value);
      const now       = new Date().toISOString();
      await this.db.run(
        `INSERT INTO global_memories (key, value, category, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value, category=excluded.category,
           tags=excluded.tags, updated_at=excluded.updated_at`,
        [key, valueStr, category, tagsStr, now, now]
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getGlobal(key) {
    await this.ready;
    try {
      const row = await this.db.get('SELECT * FROM global_memories WHERE key = ?', [key]);
      if (!row) return { success: false, error: 'Not found' };
      return { success: true, ...this._formatRow(row) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Direct-access method for prompt.js to inject memories into the system context.
  // Queries global_memories for all records whose category is in the given array,
  // returning results grouped by category: { category: [{ key, value }, ...] }
  async getContextMemories(categories) {
    await this.ready;
    if (!categories || categories.length === 0) return {};
    const placeholders = categories.map(() => '?').join(', ');
    const rows = await this.db.all(
      `SELECT key, value, category FROM global_memories WHERE category IN (${placeholders}) ORDER BY category, key`,
      categories
    );
    const grouped = {};
    for (const r of rows) {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push({ key: r.key, value: this._jsonParse(r.value) });
    }
    return grouped;
  }

  async deleteGlobal(key) {
    await this.ready;
    try {
      const result = await this.db.run('DELETE FROM global_memories WHERE key = ?', [key]);
      if (result.changes === 0) return { success: false, error: 'Key not found' };
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listGlobal(category = null) {
    await this.ready;
    try {
      const rows = category
        ? await this.db.all('SELECT * FROM global_memories WHERE category = ? ORDER BY key', [category])
        : await this.db.all('SELECT * FROM global_memories ORDER BY key');
      return { success: true, results: rows.map(r => this._formatRow(r)) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async searchGlobal(query) {
    await this.ready;
    try {
      const built = this._buildSearchWhere(query, ['key', 'value', 'category', 'tags']);
      if (!built) return { success: false, error: 'Query must not be empty' };
      const rows = await this.db.all(
        `SELECT * FROM global_memories WHERE ${built.where} ORDER BY key`,
        built.params
      );
      return { success: true, results: rows.map(r => this._formatRow(r)) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // --- Channel Memory ---
  async setChannel(channelName, key, value, category = 'general', tags = []) {
    await this.ready;
    try {
      const table    = await this.ensureChannelTable(channelName);
      const tagsStr  = this._sanitizeTags(tags);
      const valueStr = this._jsonStringify(value);
      const now      = new Date().toISOString();
      await this.db.run(
        `INSERT INTO ${table} (key, value, category, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value, category=excluded.category,
           tags=excluded.tags, updated_at=excluded.updated_at`,
        [key, valueStr, category, tagsStr, now, now]
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getChannel(channelName, key) {
    await this.ready;
    try {
      const table = await this.ensureChannelTable(channelName);
      const row   = await this.db.get(`SELECT * FROM ${table} WHERE key = ?`, [key]);
      if (!row) return { success: false, error: 'Not found' };
      return { success: true, ...this._formatRow(row) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteChannel(channelName, key) {
    await this.ready;
    try {
      const table  = await this.ensureChannelTable(channelName);
      const result = await this.db.run(`DELETE FROM ${table} WHERE key = ?`, [key]);
      if (result.changes === 0) return { success: false, error: 'Key not found' };
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getChannelByCategory(channelName, category) {
    await this.ready;
    try {
      const table = await this.ensureChannelTable(channelName);
      const rows  = await this.db.all(`SELECT * FROM ${table} WHERE category = ? ORDER BY key`, [category]);
      return { success: true, results: rows.map(r => this._formatRow(r)) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async listChannelKeys(channelName) {
    await this.ready;
    try {
      const table = await this.ensureChannelTable(channelName);
      const rows  = await this.db.all(`SELECT key FROM ${table} ORDER BY key`);
      return { success: true, keys: rows.map(r => r.key) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async purgeChannel(channelName) {
    await this.ready;
    try {
      const table = `channel_memories_${this._sanitizeChannelName(channelName)}`;
      const exists = await this.db.get(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]
      );
      if (!exists) return { success: false, error: `No memory table found for channel: ${channelName}` };
      await this.db.run(`DROP TABLE IF EXISTS ${table}`);
      return { success: true, message: `All memories for channel "${channelName}" deleted.` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // --- Skills ---
  // Upserts on name conflict: updates description but preserves existing skill_data
  // and training_progress so repeated createSkill calls are safe.
  async createSkill(name, description, initialStructure = {}, owner = 'global', instructions = null) {
    await this.ready;
    try {
      const now = new Date().toISOString();
      await this.db.run(
        `INSERT INTO skills (name, description, skill_data, training_progress, owner, instructions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description=excluded.description, updated_at=excluded.updated_at`,
        [name, description, this._jsonStringify(initialStructure), this._jsonStringify({ count: 0 }), owner, instructions || null, now, now]
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Deep-merges newData into existing skill_data. If newData.instructions is present
  // it is stored in the instructions column (injected into every prompt) instead of skill_data.
  async updateSkill(name, newData, trainingIncrement = false) {
    await this.ready;
    try {
      const skill = await this.db.get('SELECT * FROM skills WHERE name = ?', [name]);
      if (!skill) return { success: false, error: 'Skill not found' };
      // Pull instructions out before merging the rest into skill_data.
      // Also auto-unwrap if the LLM mistakenly wraps content in a skill_data key
      // (e.g. newData = { skill_data: { ... } } instead of { ... } directly).
      const { instructions: newInstructions, skill_data: wrappedData, ...directData } = newData;
      const hasSkillDataKey = 'skill_data' in newData;
      let skillData;
      if (hasSkillDataKey && wrappedData === null && Object.keys(directData).length === 0) {
        // { skill_data: null } means "clear skill_data entirely"
        skillData = {};
      } else if (hasSkillDataKey && wrappedData && typeof wrappedData === 'object' && Object.keys(directData).length === 0) {
        // { skill_data: { ... } } — LLM wrapped in skill_data key, unwrap and merge
        skillData = this._deepMerge(this._jsonParse(skill.skill_data) || {}, wrappedData);
      } else {
        // Direct merge: { field: value, ... } — merges directly into skill_data. null values delete keys.
        skillData = this._deepMerge(this._jsonParse(skill.skill_data) || {}, directData);
      }
      const training  = this._jsonParse(skill.training_progress) || { count: 0 };
      if (trainingIncrement) training.count = (training.count || 0) + 1;
      const instructions = newInstructions !== undefined ? (newInstructions || null) : skill.instructions;
      const now = new Date().toISOString();
      await this.db.run(
        `UPDATE skills SET skill_data = ?, instructions = ?, training_progress = ?, updated_at = ? WHERE name = ?`,
        [this._jsonStringify(skillData), instructions, this._jsonStringify(training), now, name]
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getSkill(name) {
    await this.ready;
    try {
      const row = await this.db.get('SELECT * FROM skills WHERE name = ?', [name]);
      if (!row) return { success: false, error: 'Not found' };
      return {
        success:           true,
        name:              row.name,
        description:       row.description,
        instructions:      row.instructions || null,
        owner:             row.owner || 'global',
        skill_data:        this._jsonParse(row.skill_data),
        training_progress: this._jsonParse(row.training_progress),
        created_at:        row.created_at,
        updated_at:        row.updated_at,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Returns summary list (no skill_data) to keep response size manageable;
  // use getSkill() to retrieve full data for a specific skill.
  async listSkills() {
    await this.ready;
    try {
      const rows = await this.db.all(
        'SELECT name, description, instructions, owner, training_progress, created_at, updated_at FROM skills ORDER BY name'
      );
      return {
        success: true,
        skills: rows.map(row => ({
          name:              row.name,
          description:       row.description,
          instructions:      row.instructions || null,
          owner:             row.owner || 'global',
          training_progress: this._jsonParse(row.training_progress),
          created_at:        row.created_at,
          updated_at:        row.updated_at,
        })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteSkill(name) {
    await this.ready;
    try {
      const result = await this.db.run('DELETE FROM skills WHERE name = ?', [name]);
      if (result.changes === 0) return { success: false, error: 'Skill not found' };
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Returns skills visible to a given user: owner='global' OR owner=username.
  async listSkillsForUser(username) {
    await this.ready;
    try {
      const rows = await this.db.all(
        `SELECT name, description, instructions, owner, training_progress, created_at, updated_at
         FROM skills WHERE owner = 'global' OR owner = ? ORDER BY name`,
        [username]
      );
      return {
        success: true,
        skills: rows.map(row => ({
          name:              row.name,
          description:       row.description,
          instructions:      row.instructions || null,
          owner:             row.owner || 'global',
          training_progress: this._jsonParse(row.training_progress),
          created_at:        row.created_at,
          updated_at:        row.updated_at,
        })),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Direct-access method for prompt.js — returns name, description, instructions, owner
  // for skills visible to username (global + user-owned), without full skill_data.
  async getContextSkills(username) {
    await this.ready;
    const rows = await this.db.all(
      `SELECT name, description, instructions, owner FROM skills WHERE owner = 'global' OR owner = ? ORDER BY name`,
      [username]
    );
    return rows;
  }

  async listChannels() {
    await this.ready;
    try {
      const tables = await this.db.all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'channel_memories_%' ORDER BY name`
      );
      const channels = tables.map(t => t.name.replace(/^channel_memories_/, ''));
      return { success: true, channels };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // --- Search (all scopes) ---
  async search(query) {
    await this.ready;
    try {
      const built = this._buildSearchWhere(query, ['key', 'value', 'category', 'tags']);
      if (!built) return { success: false, error: 'Query must not be empty' };

      // Global memories
      const globalRows = await this.db.all(
        `SELECT 'global' as scope, key, value, category, tags, created_at, updated_at
         FROM global_memories WHERE ${built.where}`,
        built.params
      );

      // Skills (uses different column names)
      const skillBuilt = this._buildSearchWhere(query, ['name', 'description', 'skill_data']);
      const skillRows = await this.db.all(
        `SELECT 'skill' as scope, name as key, skill_data as value,
                description as category, '' as tags, created_at, updated_at
         FROM skills WHERE ${skillBuilt.where}`,
        skillBuilt.params
      );

      // All channel tables
      const tables = await this.db.all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'channel_memories_%'`
      );
      let channelResults = [];
      for (const t of tables) {
        const rows = await this.db.all(
          `SELECT ? as scope, key, value, category, tags, created_at, updated_at
           FROM ${t.name} WHERE ${built.where}`,
          [t.name, ...built.params]
        );
        channelResults = channelResults.concat(rows);
      }

      const allResults = [...globalRows, ...skillRows, ...channelResults].map(row => ({
        scope: row.scope,
        ...this._formatRow(row),
      }));
      return { success: true, results: allResults };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = MemoryTool;
