# PatchFileTool Registry

## ⚠️ CRITICAL MANDATORY REQUIREMENTS

**NEVER call PatchFileTool without providing actual find/replace content.**

- ❌ **INVALID**: Calling `PatchFileTool` with an empty or missing patch block
- ✅ **VALID**: Calling `PatchFileTool` WITH a complete ===SKIPPY_PATCH_START=== block containing at least one ===FIND===/===REPLACE=== pair

If you call `PatchFileTool` without including a valid patch block, the tool will apply **0 changes** and waste a conversation round trip.

**You MUST provide patch content in EVERY PatchFileTool call. There are no exceptions.**

---

## ⚠️ When to use PatchFileTool vs FileWriteTool

**PatchFileTool** — targeted find/replace edits on specific sections of an existing file.

Use **PatchFileTool** when:
- Changing a specific function, block, or section in a larger file
- Fixing a bug, updating logic, renaming a variable, adding or removing lines
- The change is localized: you know exactly what to find and what to replace

Use **FileWriteTool** instead when:
- The change touches the majority of the file's content
- Creating a new file from scratch

---

## Usage Instructions

PatchFileTool uses a **hybrid format** — the JSON action contains only the filepath, and the find/replace pairs are placed **after** the JSON in a patch block. This avoids JSON encoding errors entirely.

### Step 1 — JSON action (filepath only, NO "changes" field):

```
{
  "reasoning": "Why you need to patch this file",
  "actions": [
    {
      "type": "tool_call",
      "tool": "PatchFileTool",
      "arguments": { "filepath": "/path/to/file.txt" },
      "reasoning": "Apply find/replace changes"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

### Step 2 — Patch block (immediately after the JSON closing brace):

```
===SKIPPY_PATCH_START:/path/to/file.txt===
===FIND===
exact text to find (copy it exactly as it appears in the file)
===REPLACE===
replacement text
===SKIPPY_PATCH_END===
```

For **multiple patches on the same file**, add more ===FIND===/===REPLACE=== pairs inside the same block:

```
===SKIPPY_PATCH_START:/path/to/file.txt===
===FIND===
first block to find
===REPLACE===
first replacement
===FIND===
second block to find
===REPLACE===
second replacement
===SKIPPY_PATCH_END===
```

⚠️ **Never put changes inside the JSON arguments.** Always use the block format above.
⚠️ The ===FIND=== text must match the file exactly, including whitespace and indentation.

## Full Example

To update a greeting in /tmp/foo.js:

```
{"reasoning":"Updating greeting text","actions":[{"type":"tool_call","tool":"PatchFileTool","arguments":{"filepath":"/tmp/foo.js"},"reasoning":"Replace greeting"}],"final_answer":"","continue":true}
===SKIPPY_PATCH_START:/tmp/foo.js===
===FIND===
console.log('Hello');
===REPLACE===
console.log('Hi there!');
===SKIPPY_PATCH_END===
```

## Tool Results Structure

```json
{
  "tool": "PatchFileTool",
  "arguments": { "filepath": "/tmp/foo.js" },
  "result": {
    "filepath": "/tmp/foo.js",
    "result": "Applied N changes",
    "error": null,
    "exitCode": 0
  }
}
```

Always check `error: null` and the `result` count in your final_answer when confirming patch application.