const Tool = require('../tool_prototype');
const path = require('path');
const fs = require('fs');

class TrelloTool extends Tool {
  constructor() {
    super();
    this.trello = null;
  }

  async init() {
    const config = global.SkippyConfig;
    const { apiKey, apiToken } = config.tools?.trello || {};
    if (!apiKey || !apiToken) {
      throw new Error('TrelloTool: Missing apiKey or apiToken in Skippy.json tools.trello');
    }
    const Trello = require('trello');
    this.trello = new Trello(apiKey, apiToken);
  }

  getContext() {
    const registryPath = path.join(__dirname, 'registry.md');
    try {
      return fs.readFileSync(registryPath, 'utf8');
    } catch {
      return '';
    }
  }

  // Low-level wrapper — returns a Promise, no callback needed
  _req(method, apiPath, options = {}) {
    return this.trello.makeRequest(method, apiPath, options);
  }

  async run(args) {
    const logger = global.logger || console;
    let op, params = {};

    // Normalize: [{op,...}], ['op', {...}], {op,...}, or plain array
    if (Array.isArray(args)) {
      if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        op = args[0].op;
        params = { ...args[0] };
      } else if (typeof args[0] === 'string' && args.length === 2 && args[1] && typeof args[1] === 'object') {
        op = args[0];
        params = { ...args[1] };
      } else {
        op = args[0];
        params = {};
      }
    } else if (args && typeof args === 'object') {
      op = args.op;
      params = { ...args };
    } else {
      return { success: false, error: 'Invalid arguments' };
    }

    try {
      switch (op) {
        case 'getBoards':      return await this._getBoards(params);
        case 'getBoard':       return await this._getBoard(params);
        case 'getLists':       return await this._getLists(params);
        case 'getList':        return await this._getList(params);
        case 'createList':     return await this._createList(params);
        case 'archiveList':    return await this._archiveList(params);
        case 'getCards':       return await this._getCards(params);
        case 'getCard':        return await this._getCard(params);
        case 'createCard':     return await this._createCard(params);
        case 'updateCard':     return await this._updateCard(params);
        case 'moveCard':       return await this._moveCard(params);
        case 'archiveCard':    return await this._archiveCard(params);
        case 'deleteCard':     return await this._deleteCard(params);
        case 'addComment':     return await this._addComment(params);
        case 'getComments':    return await this._getComments(params);
        case 'getLabels':      return await this._getLabels(params);
        case 'addLabel':       return await this._addLabel(params);
        case 'removeLabel':    return await this._removeLabel(params);
        case 'getMembers':     return await this._getMembers(params);
        default:
          return { success: false, error: `Unknown operation: ${op}` };
      }
    } catch (err) {
      logger.error(`TrelloTool.run error (${op}): ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ─── Boards ──────────────────────────────────────────────────────────────

  async _getBoards() {
    const boards = await this._req('GET', '/1/members/me/boards', {
      filter: 'open',
      fields: 'id,name,desc,closed,url,shortUrl',
    });
    return { success: true, boards };
  }

  async _getBoard({ boardId }) {
    if (!boardId) return { success: false, error: 'Missing required parameter: boardId' };
    const board = await this._req('GET', `/1/boards/${boardId}`, {
      fields: 'id,name,desc,closed,url,shortUrl,dateLastActivity',
    });
    return { success: true, board };
  }

  // ─── Lists ────────────────────────────────────────────────────────────────

  async _getLists({ boardId, filter }) {
    if (!boardId) return { success: false, error: 'Missing required parameter: boardId' };
    const lists = await this._req('GET', `/1/boards/${boardId}/lists`, {
      filter: filter || 'open',
      fields: 'id,name,closed,pos,idBoard',
    });
    return { success: true, lists };
  }

  async _getList({ listId }) {
    if (!listId) return { success: false, error: 'Missing required parameter: listId' };
    const list = await this._req('GET', `/1/lists/${listId}`, {
      fields: 'id,name,closed,pos,idBoard',
    });
    return { success: true, list };
  }

  async _createList({ boardId, name, pos }) {
    if (!boardId) return { success: false, error: 'Missing required parameter: boardId' };
    if (!name) return { success: false, error: 'Missing required parameter: name' };
    const opts = { name, idBoard: boardId };
    if (pos !== undefined) opts.pos = pos;
    const list = await this._req('POST', '/1/lists', opts);
    return { success: true, list: { id: list.id, name: list.name, pos: list.pos } };
  }

  async _archiveList({ listId }) {
    if (!listId) return { success: false, error: 'Missing required parameter: listId' };
    await this._req('PUT', `/1/lists/${listId}/closed`, { value: true });
    return { success: true };
  }

  // ─── Cards ────────────────────────────────────────────────────────────────

  async _getCards({ boardId, listId, filter }) {
    if (listId) {
      const cards = await this._req('GET', `/1/lists/${listId}/cards`, {
        filter: filter || 'open',
        fields: 'id,name,desc,closed,due,dueComplete,idList,idBoard,labels,url,shortUrl,pos',
      });
      return { success: true, cards };
    }
    if (boardId) {
      const cards = await this._req('GET', `/1/boards/${boardId}/cards`, {
        filter: filter || 'open',
        fields: 'id,name,desc,closed,due,dueComplete,idList,idBoard,labels,url,shortUrl,pos',
      });
      return { success: true, cards };
    }
    return { success: false, error: 'Missing required parameter: boardId or listId' };
  }

  async _getCard({ cardId }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    const card = await this._req('GET', `/1/cards/${cardId}`, {
      fields: 'id,name,desc,closed,due,dueComplete,idList,idBoard,labels,url,shortUrl,pos',
    });
    return { success: true, card };
  }

  async _createCard({ listId, name, desc, due, pos, idLabels }) {
    if (!listId) return { success: false, error: 'Missing required parameter: listId' };
    if (!name) return { success: false, error: 'Missing required parameter: name' };
    const opts = { idList: listId, name };
    if (desc !== undefined) opts.desc = desc;
    if (due !== undefined) opts.due = due;
    if (pos !== undefined) opts.pos = pos;
    if (idLabels) opts.idLabels = Array.isArray(idLabels) ? idLabels.join(',') : idLabels;
    const card = await this._req('POST', '/1/cards', opts);
    return { success: true, card: this._fmtCard(card) };
  }

  async _updateCard({ cardId, fields }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    if (!fields || typeof fields !== 'object') {
      return { success: false, error: 'Missing required parameter: fields (object of fields to update)' };
    }
    // Trello REST API accepts multiple fields in one PUT
    const card = await this._req('PUT', `/1/cards/${cardId}`, fields);
    return { success: true, card: this._fmtCard(card) };
  }

  async _moveCard({ cardId, listId, pos }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    if (!listId) return { success: false, error: 'Missing required parameter: listId' };
    const opts = { idList: listId };
    if (pos !== undefined) opts.pos = pos;
    await this._req('PUT', `/1/cards/${cardId}`, opts);
    return { success: true };
  }

  async _archiveCard({ cardId }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    await this._req('PUT', `/1/cards/${cardId}`, { closed: true });
    return { success: true };
  }

  async _deleteCard({ cardId }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    await this._req('DELETE', `/1/cards/${cardId}`, {});
    return { success: true };
  }

  // ─── Comments ─────────────────────────────────────────────────────────────

  async _addComment({ cardId, text }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    if (!text) return { success: false, error: 'Missing required parameter: text' };
    const result = await this._req('POST', `/1/cards/${cardId}/actions/comments`, { text });
    return { success: true, commentId: result.id };
  }

  async _getComments({ cardId }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    const actions = await this._req('GET', `/1/cards/${cardId}/actions`, {
      filter: 'commentCard',
    });
    const comments = (actions || []).map(a => ({
      id: a.id,
      text: a.data?.text,
      date: a.date,
      memberCreator: a.memberCreator?.username,
    }));
    return { success: true, comments };
  }

  // ─── Labels ───────────────────────────────────────────────────────────────

  async _getLabels({ boardId }) {
    if (!boardId) return { success: false, error: 'Missing required parameter: boardId' };
    const labels = await this._req('GET', `/1/boards/${boardId}/labels`, {
      fields: 'id,name,color',
    });
    return { success: true, labels };
  }

  async _addLabel({ cardId, labelId }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    if (!labelId) return { success: false, error: 'Missing required parameter: labelId' };
    await this._req('POST', `/1/cards/${cardId}/idLabels`, { value: labelId });
    return { success: true };
  }

  async _removeLabel({ cardId, labelId }) {
    if (!cardId) return { success: false, error: 'Missing required parameter: cardId' };
    if (!labelId) return { success: false, error: 'Missing required parameter: labelId' };
    await this._req('DELETE', `/1/cards/${cardId}/idLabels/${labelId}`, {});
    return { success: true };
  }

  // ─── Members ──────────────────────────────────────────────────────────────

  async _getMembers({ boardId }) {
    if (!boardId) return { success: false, error: 'Missing required parameter: boardId' };
    const members = await this._req('GET', `/1/boards/${boardId}/members`, {
      fields: 'id,username,fullName',
    });
    return { success: true, members };
  }

  // ─── Helper ───────────────────────────────────────────────────────────────

  _fmtCard(c) {
    return {
      id: c.id,
      name: c.name,
      desc: c.desc,
      closed: c.closed,
      due: c.due,
      dueComplete: c.dueComplete,
      idList: c.idList,
      idBoard: c.idBoard,
      labels: (c.labels || []).map(l => ({ id: l.id, name: l.name, color: l.color })),
      url: c.url,
      shortUrl: c.shortUrl,
      pos: c.pos,
    };
  }
}

module.exports = TrelloTool;
