# File Read Tool Registry

## Usage Instructions

Respond in structured JSON format for file_read actions:

```
{
  "reasoning": "Why you need to read this file",
  "actions": [
    {
      "type": "tool_call",
      "tool": "FileReadTool",
      "arguments": { "filepath": "/path/to/file.txt" },
      "reasoning": "File content required"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Use the "actions" array to specify file_read tool calls. Each action must include the tool name and arguments.
- Set "continue": true if you need to call more tools after receiving results.
- Provide your reasoning for each action and for your overall answer.

## Example

To read a file:
```
{
  "reasoning": "User wants to see contents of /tmp/foo.txt",
  "actions": [
    {
      "type": "tool_call",
      "tool": "FileReadTool",
      "arguments": { "filepath": "/tmp/foo.txt" },
      "reasoning": "File content required"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

## Tool Results Structure

When the FileReadTool runs, it returns toolResults with the following structure:

```
{
  "tool": "FileReadTool",
  "arguments": { "filepath": "/tmp/foo.txt" },
  "result": [
    {
      "filepath": "/tmp/foo.txt",
      "content": "Hello World\nThis is a file.",
      "error": null
    }
  ]
}
```

- `content`: The contents of the file
- `error`: Error object or null

Always use the `content` value in your final_answer when presenting file contents to the user.

---

Always use this schema for FileReadTool calls. Do not include conversational text outside the JSON object.
