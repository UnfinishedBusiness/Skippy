# File Write Tool Registry

## Usage Instructions

FileWriteTool uses a **hybrid format** — the JSON action contains only the filepath, and the actual file content is placed **after** the JSON in a special block. This avoids JSON encoding errors entirely.

### Step 1 — JSON action (filepath only, NO "content" field):

```
{
  "reasoning": "Why you need to write this file",
  "actions": [
    {
      "type": "tool_call",
      "tool": "FileWriteTool",
      "arguments": { "filepath": "/path/to/file.txt" },
      "reasoning": "Write file contents"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

### Step 2 — File content block (immediately after the JSON closing brace):

```
===SKIPPY_FILE_START:/path/to/file.txt===
Your file content here, exactly as-is.
No JSON escaping needed. Newlines, quotes, backslashes all work literally.
===SKIPPY_FILE_END===
```

⚠️ **Never put file content inside the JSON arguments.** Always use the block format above.

## Full Example

To write a Python script to /tmp/hello.py:

```
{"reasoning":"Writing requested script","actions":[{"type":"tool_call","tool":"FileWriteTool","arguments":{"filepath":"/tmp/hello.py"},"reasoning":"Write the file"}],"final_answer":"","continue":true}
===SKIPPY_FILE_START:/tmp/hello.py===
def hello(name):
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(hello("world"))
===SKIPPY_FILE_END===
```

## Tool Results Structure

```json
{
  "tool": "FileWriteTool",
  "arguments": { "filepath": "/tmp/hello.py" },
  "result": {
    "filepath": "/tmp/hello.py",
    "content": "...",
    "error": null,
    "exitCode": 0
  }
}
```

Always confirm the write succeeded by checking `error: null` in your final_answer.
