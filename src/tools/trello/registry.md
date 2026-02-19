# TrelloTool

Manage Trello boards, lists, cards, labels, and members. All calls use a single JSON object with an `op` field.

## Tool Call Format

```json
{
  "reasoning": "Why you need Trello",
  "actions": [
    {
      "type": "tool_call",
      "tool": "TrelloTool",
      "arguments": { "op": "getBoards" },
      "reasoning": "List boards to find target board"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

## Operations

### Boards

| op | Required | Optional | Returns |
|----|----------|----------|---------|
| `getBoards` | — | — | `{ boards: [{id, name, desc, url}] }` |
| `getBoard` | `boardId` | — | `{ board }` |

### Lists

| op | Required | Optional | Returns |
|----|----------|----------|---------|
| `getLists` | `boardId` | `filter` (open\|closed\|all) | `{ lists: [{id, name, pos}] }` |
| `getList` | `listId` | — | `{ list }` |
| `createList` | `boardId`, `name` | `pos` (top/bottom/number) | `{ list: {id, name, pos} }` |
| `archiveList` | `listId` | — | `{ success }` |

### Cards

| op | Required | Optional | Returns |
|----|----------|----------|---------|
| `getCards` | `boardId` or `listId` | `filter` (open\|closed\|all) | `{ cards: [{id, name, desc, idList, labels, due, url}] }` |
| `getCard` | `cardId` | — | `{ card }` |
| `createCard` | `listId`, `name` | `desc`, `due` (ISO8601), `pos`, `idLabels` (array) | `{ card }` |
| `updateCard` | `cardId`, `fields` | — | `{ card }` |
| `moveCard` | `cardId`, `listId` | `pos` | `{ success }` |
| `archiveCard` | `cardId` | — | `{ success }` |
| `deleteCard` | `cardId` | — | `{ success }` |

#### updateCard fields object

Pass any subset of these card fields:
```json
{ "op": "updateCard", "cardId": "...", "fields": { "name": "New title", "desc": "New desc", "due": "2026-03-01T09:00:00Z", "dueComplete": true, "pos": "top" } }
```

### Comments

| op | Required | Optional | Returns |
|----|----------|----------|---------|
| `addComment` | `cardId`, `text` | — | `{ commentId }` |
| `getComments` | `cardId` | — | `{ comments: [{id, text, date, memberCreator}] }` |

### Labels

| op | Required | Optional | Returns |
|----|----------|----------|---------|
| `getLabels` | `boardId` | — | `{ labels: [{id, name, color}] }` |
| `addLabel` | `cardId`, `labelId` | — | `{ success }` |
| `removeLabel` | `cardId`, `labelId` | — | `{ success }` |

### Members

| op | Required | Optional | Returns |
|----|----------|----------|---------|
| `getMembers` | `boardId` | — | `{ members: [{id, username, fullName}] }` |

## Examples

```json
{ "op": "getBoards" }
{ "op": "getLists", "boardId": "abc123" }
{ "op": "createCard", "listId": "xyz", "name": "Task title", "desc": "Details here", "due": "2026-03-01T09:00:00Z" }
{ "op": "updateCard", "cardId": "card123", "fields": { "desc": "Updated description" } }
{ "op": "moveCard", "cardId": "card123", "listId": "doneList" }
{ "op": "addComment", "cardId": "card123", "text": "Progress update..." }
{ "op": "getCards", "listId": "xyz", "filter": "open" }
```

## Using Trello as Data Storage

Cards work well as structured data records:
- **Card name** → record identifier or title
- **Card description** → JSON blob or structured text for record data
- **Lists** → categories or states (e.g. Backlog, In Progress, Done)
- **Labels** → tags or type indicators
- **Comments** → append-only log entries or history

Workflow for storing/updating a record:
1. `getLists` to find the right list ID
2. `getCards` to check if record already exists
3. `createCard` or `updateCard` as appropriate
