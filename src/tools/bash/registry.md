# Bash Tool Registry

## Usage Instructions

When you need to run bash commands, always respond in structured JSON format as follows:

```
{
  "reasoning": "Why you need to run this command",
  "actions": [
    {
      "type": "tool_call",
      "tool": "BashTool",
      "arguments": { "command": "<your bash command>" },
      "reasoning": "Why this command is needed"
    }
    // ...more actions if needed
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Use the "actions" array to specify bash tool calls. Each action must include the tool name and arguments.
- Set "continue": true if you need to call more tools after receiving results.
- Provide your reasoning for each action and for your overall answer.

## Tool Results Structure

When the BashTool runs, it returns toolResults with the following structure:

```
{
  "tool": "BashTool",
  "arguments": { "command": "ls -la /tmp" },
  "result": [
    {
      "command": "ls -la /tmp",
      "stdout": "file1\nfile2\nfile3",
      "stderr": "",
      "error": null,
      "exitCode": 0
    }
  ]
}
```

- `stdout`: The output of the bash command (directory listing, etc.)
- `stderr`: Any error output
- `error`: Error object or null
- `exitCode`: Exit code of the command

Always use the `stdout` value in your final_answer when presenting results to the user.

---

# Background Process Support

The BashTool supports running background processes that you can monitor, check output on, and terminate when needed. All background processes are tracked with a unique process ID.

## Start Background Processes

### Start a background command
```
bg:start <command>
// or
bg:run <command>
```

Starts any command in the background. Returns a process ID that can be used to check status, view output, or kill the process.

Example:
```
bg:start python long_task.py
```

### Start a curl download with progress
```
curl:progress <url> -o <file>
// or
download:start <url> -o <file>
```

Starts a curl download in the background with progress tracking. Use `bg:stdout <processId> --tail 10` to check download progress.

Example:
```
curl:progress https://example.com/largefile.zip -o /tmp/file.zip
```

## Check Process Status

### List all background processes
```
jobs
// or
processes
// or
bg:list
```

Lists all background processes (both running and completed).

### List running processes only
```
bg:running
```

Lists only currently running background processes.

### List completed processes only
```
bg:completed
```

Lists completed or failed background processes.

### Get process status
```
bg:status <processId>
```

Gets detailed status of a specific process including PID, exit code, start/end times.

## View Output

### Get full stdout
```
bg:stdout <processId>
```

Gets the complete stdout output of a background process.

### Get last N lines of stdout
```
bg:stdout <processId> --tail N
```

Gets the last N lines of stdout. Useful for checking progress of long-running tasks.

Example:
```
bg:stdout proc_1_1234567890 --tail 20
```

### Get full stderr
```
bg:stderr <processId>
```

Gets the complete stderr output of a background process.

### Get last N lines of stderr
```
bg:stderr <processId> --tail N
```

Gets the last N lines of stderr.

## Control Processes

### Kill a process (graceful)
```
bg:kill <processId>
```

Sends SIGTERM to gracefully terminate a running process.

### Force kill a process
```
bg:kill! <processId>
// or
bg:forcekill <processId>
```

Sends SIGKILL to forcefully terminate a running process.

---

## Process Output Storage

All background process output is captured to files in `/tmp/skippy_processes/` for persistence. This allows you to check on background downloads or long-running tasks anytime, even after a restart.

---

Always use this schema for BashTool calls. Do not include conversational text outside the JSON object.
