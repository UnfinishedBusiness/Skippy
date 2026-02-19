# File Write Tool Registry

## Usage Instructions

Respond in structured JSON format for file_write actions:

```
{
  "reasoning": "Why you need to write this file",
  "actions": [
    {
      "type": "tool_call",
      "tool": "FileWriteTool",
      "arguments": { "filepath": "/path/to/file.txt", "content": "Hello World" },
      "reasoning": "Update file contents"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Use the "actions" array to specify file_write tool calls. Each action must include the tool name and arguments.
- Set "continue": true if you need to call more tools after receiving results.
- Provide your reasoning for each action and for your overall answer.

## Example

To write to a file:
```
{
  "reasoning": "User wants to write to /tmp/foo.txt",
  "actions": [
    {
      "type": "tool_call",
      "tool": "FileWriteTool",
      "arguments": { "filepath": "/tmp/foo.txt", "content": "Hello World" },
      "reasoning": "Update file contents"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

## Tool Results Structure

When the FileWriteTool runs, it returns toolResults with the following structure:

```
{
  "tool": "FileWriteTool",
  "arguments": { "filepath": "/tmp/foo.txt", "content": "Hello World" },
  "result": [
    {
      "filepath": "/tmp/foo.txt",
      "content": "Hello World",
      "error": null
    }
  ]
}
```

- `content`: The content written to the file
- `error`: Error object or null

Always reference the `content` value in your final_answer when confirming file writes to the user.

---

Always use this schema for FileWriteTool calls. Do not include conversational text outside the JSON object.
