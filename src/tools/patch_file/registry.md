# PatchFileTool Registry

## ⚠️ When to use PatchFileTool vs FileWriteTool

**PatchFileTool is for targeted find/replace edits** — changing specific sections of a file without touching the rest.

Use **PatchFileTool** when:
- Changing a specific function, block, or section — even if it's 50–100 lines — in a larger file
- Fixing a bug, updating logic, renaming a variable, adding or removing lines in a known location
- The change is localized: you know exactly what to find and what to replace it with

Use **FileWriteTool** instead when:
- The change touches the **majority** of the file's content (e.g. rewriting 400 of 500 lines)
- Creating a new file from scratch
- You need to reconstruct the whole file anyway and a find/replace won't cleanly express the change

**Note:** Both tools embed content inside JSON strings, so both require proper JSON escaping. Neither is safer than the other from an encoding standpoint. For large targeted changes, prefer splitting into **multiple smaller `changes` entries** rather than one giant find/replace block — smaller changes are easier to encode correctly and easier to debug if one fails.

---

## Usage Instructions

Respond in structured JSON format for PatchFileTool actions:

```
{
  "reasoning": "Why you need to patch this file",
  "actions": [
    {
      "type": "tool_call",
      "tool": "PatchFileTool",
      "arguments": {
        "filepath": "/path/to/file.txt",
        "changes": [
          { "find": "<exact old block>", "replace": "<exact new block>" },
          { "find": "<another old block>", "replace": "<another new block>" }
        ]
      },
      "reasoning": "Apply find/replace changes to the file"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Use the "actions" array to specify PatchFileTool calls. Each action must include the tool name and arguments.
- The "changes" array must contain objects with "find" and "replace" string properties.
- To remove lines, set "replace" to an empty string. To insert, set "find" to a context block and "replace" to the new block (or use an empty "find" for file prepend/append).
- Set "continue": true if you need to call more tools after receiving results.
- Provide your reasoning for each action and for your overall answer.

## Example

To update a file by replacing two code blocks:
```
{
  "reasoning": "User wants to update /tmp/foo.txt by replacing two code blocks.",
  "actions": [
    {
      "type": "tool_call",
      "tool": "PatchFileTool",
      "arguments": {
        "filepath": "/tmp/foo.txt",
        "changes": [
          { "find": "console.log('Hello');", "replace": "console.log('Hi');" },
          { "find": "let x = 1;", "replace": "let x = 42;" }
        ]
      },
      "reasoning": "Replace greeting and variable value."
    }
  ],
  "final_answer": "",
  "continue": true
}
```

## Tool Results Structure

When the PatchFileTool runs, it returns toolResults with the following structure:

```
{
  "tool": "PatchFileTool",
  "arguments": { "filepath": "/tmp/foo.txt", "changes": [ ... ] },
  "result": [
    {
      "filepath": "/tmp/foo.txt",
      "result": "Applied N changes",
      "error": null,
      "exitCode": 0
    }
  ]
}
```

- `result`: The output of the patch operation
- `error`: Error object or null
- `exitCode`: Exit code of the operation

Always reference the `result` value in your final_answer when confirming patch application to the user.

---

Always use this schema for PatchFileTool calls. Do not include conversational text outside the JSON object.
