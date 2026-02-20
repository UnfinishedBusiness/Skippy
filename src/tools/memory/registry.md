# MemoryTool Registry

## Usage Instructions

Use the MemoryTool to store, retrieve, search, and manage persistent memories and skills. Always respond in structured JSON format as follows:

```
{
  "reasoning": "Why you need to use memory (e.g., store a fact, recall a skill, search for information)",
  "actions": [
    {
      "type": "tool_call",
      "tool": "MemoryTool",
      "arguments": {
        "op": "<operation>",
        // ...operation-specific arguments
      },
      "reasoning": "Why this memory operation is needed"
    }
    // ...more actions if needed
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Use the "actions" array to specify MemoryTool calls. Each action must include the tool name and arguments.
- Set "continue": true if you need to call more tools after receiving results.
- Provide your reasoning for each action and for your overall answer.

---

## Supported Operations

### Auto-Injected Categories (always in context)

The following categories are automatically injected into **every system prompt** under a "Memory Context" section. You never need to call a tool to retrieve them — they are always available. Use them proactively to inform your responses.

| Category | Purpose | Example keys |
|---|---|---|
| `agent` | Your own persistent behaviors and style | `agent_tone`, `agent_time_format`, `agent_units` |
| `preferences` | User preferences that always apply | `user_units_preference`, `user_language`, `user_date_format` |
| `user_info` | Persistent facts about the user | `user_name`, `user_address`, `user_timezone` |

**When to write to these categories:**
- User asks you to change how you behave → `category: "agent"`, e.g. key `agent_verbosity`, value `"keep responses short and direct"`
- User states a preference that should always apply → `category: "preferences"`, e.g. key `user_units_preference`, value `"US standard (imperial)"`
- User shares a personal fact → `category: "user_info"`, e.g. key `user_name`, value `"Alex"`

To remove an injected memory, use `deleteGlobal` with the exact key.

### Retrieve-On-Demand Categories (tool call required)

All other categories (`general`, `vehicle_build`, and any domain-specific categories) are **not** injected automatically. Use `search`, `searchGlobal`, or `getGlobal` to retrieve them when the topic is relevant.

---

### Global Memory
Global memories are shared across all channels and persist indefinitely.

- **`setGlobal`** — Store or update a global memory (upserts on key conflict).
  - Required: `key`, `value`
  - Optional: `category` (default: `"general"`), `tags` (array of strings)
- **`getGlobal`** — Retrieve a global memory by exact key.
  - Required: `key`
- **`deleteGlobal`** — Delete a global memory by key. Returns an error if the key does not exist.
  - Required: `key`
- **`listGlobal`** — List all global memories, optionally filtered by category.
  - Optional: `category`
- **`searchGlobal`** — Search global memories using keywords. Tokenizes the query, so multi-word queries match records containing any of the words. Query must not be empty.
  - Required: `query`

### Channel Memory
Channel memories are scoped to a specific Discord channel. Use these for anything that is specific to the topic or context of the current channel. The current channel name is always available to you in the system context as `Current channel: <name>` — use it as the `channelName` parameter.

**Use `setChannel` (not `setGlobal`) when the information is channel-specific** — e.g., vehicle build details in `#overland_van`, project notes in `#shop_build`, game state in `#gaming`. Use `setGlobal` only for facts that apply across all channels (user name, preferences, etc.).

⚠️ **`channelName` MUST be copied verbatim from the `Current channel:` line in your context.** Do NOT reformat, add underscores, or guess the name. If context says `Current channel: megafurnace`, use `"channelName": "megafurnace"` exactly — not `"mega_furnace"`, not `"mega-furnace"`.

- **`setChannel`** — Store or update a channel-scoped memory (upserts on key conflict).
  - Required: `channelName`, `key`, `value`
  - Optional: `category` (default: `"general"`), `tags` (array of strings)
- **`getChannel`** — Retrieve a channel-scoped memory by exact key.
  - Required: `channelName`, `key`
- **`deleteChannel`** — Delete a channel-scoped memory by key. Returns an error if the key does not exist.
  - Required: `channelName`, `key`
- **`getChannelByCategory`** — Get all memories in a given category for a channel.
  - Required: `channelName`, `category`
- **`listChannelKeys`** — List all memory keys for a channel.
  - Required: `channelName`
- **`listChannels`** — List all channel names that have stored memories. Use this to verify the exact channel name before calling `setChannel` or `getChannel` if you are unsure.
  - Arguments: none
- **`purgeChannel`** — Delete ALL memories for a channel at once (e.g. when a channel no longer exists). Irreversible.
  - Required: `channelName`

### Skills
Skills store learned behaviors and structured knowledge. The LLM determines their internal structure.

> **Auto-injected:** Every prompt automatically includes an `## Available Skills` block listing each skill's name, description, and **instructions** for all skills visible to the current user (owner = `"global"` or owner = current Discord username). You never need to call a tool to see which skills exist — use `getSkill` only when you need the full `skill_data`.

Skills have an **owner** field that controls visibility:
- `"global"` (default) — visible to all users
- A Discord username (e.g. `"travis.gillin"`) — visible only to that user and injected only into their prompts

#### Skill field guide — use the right field

| Field | Injected every prompt? | Purpose |
|---|---|---|
| `description` | ✅ Yes | One-line summary of what the skill does |
| `instructions` | ✅ Yes | Behavioral rules the agent MUST follow every time (e.g. "use board ID XYZ, never call getBoards") |
| `skill_data` | ❌ No (fetch with `getSkill`) | Structured data the skill stores and reads (e.g. saved IDs, step lists, pricing tables) |

**Rule:** If the user tells you to change how you behave for a skill — store it in `instructions`, not `skill_data`. `skill_data` is for data, not rules. Instructions are always visible; `skill_data` is only visible when you explicitly call `getSkill`.

- **`createSkill`** — Create a new skill. Safe to call repeatedly — if the skill already exists, only the description is updated and existing data is preserved.
  - Required: `name`, `description`
  - Optional: `initialStructure` (object, default: `{}`), `owner` (string, default: `"global"`), `instructions` (string)
- **`updateSkill`** — Update a skill. Deep-merges `newData` directly into `skill_data`. Nested objects are merged, not replaced. Returns an error if the skill does not exist.
  - Required: `name`, `newData` (object)
  - Optional: `trainingIncrement` (boolean, default: `false`) — increments the training counter when `true`
  - **`newData.instructions`** — special key: stored in the `instructions` column (injected every prompt), NOT in `skill_data`
  - ⚠️ **Do NOT wrap content in a `skill_data` key.** `newData` IS the content that goes into `skill_data`. Send `{ "rates": {...} }`, NOT `{ "skill_data": { "rates": {...} } }`. Wrapping in `skill_data` creates a nested key instead of updating the real fields.
  - To remove a specific field from `skill_data`, set it to `null`: `{ "old_field": null }`. Null values delete the key.
  - To **clear all of `skill_data`** at once (e.g. when migrating everything to `instructions`), send exactly `{ "skill_data": null }`. You may combine with `instructions`: `{ "instructions": "...", "skill_data": null }`.
- **`getSkill`** — Retrieve the full data for a skill including `skill_data`, `training_progress`, and `owner`.
  - Required: `name`
- **`listSkills`** — List **all** skills regardless of owner, with names, descriptions, owner, and training progress. Does **not** include `skill_data`.
  - Arguments: none
- **`listSkillsForUser`** — List only skills visible to a specific user (owner = `"global"` OR owner = username).
  - Required: `username`
- **`deleteSkill`** — Delete a skill by name. Returns an error if the skill does not exist.
  - Required: `name`

### Cross-Scope Search

- **`search`** — Search across all global memories, skills, and all channel memories at once. Tokenizes the query (multi-word queries match records containing any of the words, underscores treated as spaces). Query must not be empty.
  - Required: `query`
  - Returns: array of results each with a `scope` field (`"global"`, `"skill"`, or the channel table name)

---

## Example Actions

**Store a global memory:**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "setGlobal",
    "key": "user_theme_preference",
    "value": "dark",
    "category": "preferences",
    "tags": ["user", "theme"]
  },
  "reasoning": "Remember the user's theme preference globally."
}
```

**List all global memories to see what's stored:**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "listGlobal"
  },
  "reasoning": "Browse all stored global memories before deciding what to save."
}
```

**Delete a memory (always search first to get the exact key):**

You must never guess a key when deleting. Keys are exact strings — always `search` or `listGlobal` first to find the real key, then delete using that exact value.

Step 1 — find the key:
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "search",
    "query": "favorite drink"
  },
  "reasoning": "Find the exact key name before deleting."
}
```
Step 2 — delete using the key returned by the search:
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "deleteGlobal",
    "key": "favorite_drink"
  },
  "reasoning": "Delete using the exact key returned by the search result."
}
```

**Create a global skill (visible to all users):**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "createSkill",
    "name": "tree_removal",
    "description": "How to handle tree removal job requests",
    "initialStructure": { "steps": [], "pricing": {} },
    "owner": "global"
  },
  "reasoning": "Create a shared skill accessible to all users."
}
```

**Create a private skill visible only to one user:**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "createSkill",
    "name": "my_workout_plan",
    "description": "Personalized workout tracking for travis.gillin",
    "owner": "travis.gillin"
  },
  "reasoning": "Store a private skill only this user can see."
}
```

**List skills visible to a specific user:**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "listSkillsForUser",
    "username": "travis.gillin"
  },
  "reasoning": "See all global and travis.gillin-owned skills."
}
```

**Update a skill with deep merge (preserves existing nested data):**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "updateSkill",
    "name": "tree_removal",
    "newData": { "pricing": { "large_tree": 800 } },
    "trainingIncrement": true
  },
  "reasoning": "Add pricing info. Deep merge keeps other pricing fields intact."
}
```

**Get a skill's full data:**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "getSkill",
    "name": "tree_removal"
  },
  "reasoning": "Recall the full tree removal skill data before responding."
}
```

**Search everything for a topic:**
```json
{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "search",
    "query": "tree removal jobs"
  },
  "reasoning": "Find all memories and skills related to tree removal across all scopes."
}
```

---

## Tool Result Structure

Every operation returns:
```json
{ "success": true, ... }
```
or on failure:
```json
{ "success": false, "error": "Description of what went wrong" }
```

Always check `success` before using the result. Common error cases:
- `"Not found"` / `"Key not found"` / `"Skill not found"` — the item does not exist; do not assume it was deleted
- `"Query must not be empty"` — provide a non-empty search term
- `"Missing required parameter: <field>"` — a required argument was omitted

---

## Automatic Memory Storage Guidelines

These guidelines govern when and how to automatically store memories without explicit user permission. Automatic storage should be used for project-specific knowledge that improves efficiency and reduces redundant tool usage.

### When to Automatically Store Memories

**Automatic storage is appropriate for:**
- **Repeated corrections** - When the same correction is made multiple times (e.g., file path corrections)
- **Project-specific details** - Information specific to the current project context (e.g., project file paths, configuration values)
- **Local conventions** - Patterns and preferences specific to the channel context

**Require explicit permission for:**
- Personal preferences that apply globally
- Sensitive information (passwords, API keys)
- Broad behavioral changes

### Automatic Storage Patterns

**Key Naming Conventions:**
- `project_file_paths` - Store corrected file paths (e.g., `src/core/prompt.js` instead of `src/prompt.js`)
- `project_config_values` - Store project-specific configuration defaults
- `local_conventions` - Store channel-specific workflow patterns

**Storage Scope:**
- Always use **channel memory** for project-specific knowledge
- Use `category: "project"` for automatic storage entries
- Apply `tags: ["auto_stored", "project_knowledge"]` for easy filtering

### Examples of Automatic Storage

**File Path Correction:**

{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "setChannel",
    "channelName": "skippy",
    "key": "project_file_paths",
    "value": {
      "prompt.js": "src/core/prompt.js",
      "registry.md": "src/tools/memory/registry.md"
    },
    "category": "project",
    "tags": ["auto_stored", "file_paths"]
  },
  "reasoning": "Automatically storing corrected file paths after repeated corrections"
}
```

**Project Configuration:**

{
  "type": "tool_call",
  "tool": "MemoryTool",
  "arguments": {
    "op": "setChannel",
    "channelName": "megafurnace",
    "key": "project_config_values",
    "value": {
      "default_temperature": 1850,
      "sensor_calibration_offset": 2.3
    },
    "category": "project",
    "tags": ["auto_stored", "configuration"]
  },
 "reasoning": "Storing project-specific configuration values for consistent future use"
}
```

## Best Practices

- **Never guess a key.** Keys are exact strings. Before calling `deleteGlobal`, `deleteChannel`, `getGlobal`, or `getChannel`, always run `search` or `listGlobal` first to get the real key from the result, then use that exact value. Guessing will fail with "Key not found".
- **Channel vs global — store in the right scope.** If you're talking in `#overland_van` about van build specs, store that with `setChannel(channelName: "overland_van", ...)`. Reserve `setGlobal` for facts that are truly universal (user name, units preference, etc.). The current channel name is always in your context as `Current channel: <name>`.
- **`purgeChannel` is irreversible.** Only call it when a channel is confirmed gone and all its memories should be deleted.
- **Search before storing.** Run `search` or `listGlobal` first to avoid creating duplicate or redundant memories.
- **Use descriptive keys.** Prefer `user_favorite_drink` over `drink` — keys are searchable and underscore-separated words are matched as individual tokens.
- **Use categories and tags.** They make `listGlobal`, `getChannelByCategory`, and searches more precise.
- **Use `listSkills` to orient yourself, then `getSkill` for details.** `listSkills` is lightweight; only call `getSkill` when you need the full `skill_data`.
- **`updateSkill` deep-merges.** You only need to send the fields you want to change — existing nested data is preserved. To delete a field from a skill, set it to `null` explicitly.
- **`createSkill` is idempotent.** Calling it again on an existing skill updates the description and leaves all data intact. Use it freely when you're unsure if a skill exists yet.
- **Set `owner` intentionally.** Default is `"global"` (all users). Pass the Discord username as `owner` when the skill is personal to one user. The current user's username is available in context.
- **Skills are auto-listed in every prompt.** The `## Available Skills` context block already tells you what skills exist, their scope, and their instructions — no need to call `listSkills` at the start of every conversation. Call `getSkill` only when you need `skill_data`.
- **`instructions` vs `skill_data` — critical distinction:**
  - Use `instructions` for behavioral rules that should always apply (IDs to use, steps to skip, user preferences for how the skill runs). These are injected into every prompt automatically.
  - Use `skill_data` only for variable data the skill stores and retrieves (cached results, counters, lookup tables). This is NOT injected — you must call `getSkill` to read it.
  - When a user says "remember to do X" or "don't do Y" for a skill → always use `instructions`.
- **Tags must not contain commas.** Commas are stripped automatically. Use separate tags instead of comma-separated strings within a single tag.
