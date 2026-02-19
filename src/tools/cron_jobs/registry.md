# CronJobsTool Registry

## Description
Schedule, list, enable, disable, or remove cron jobs that run a prompt or bash command at a specified time or interval.

## CRITICAL: Argument Format

`arguments` is ALWAYS an array with exactly 2 elements:
1. The action string: `"add"`, `"list"`, `"remove"`, `"enable"`, or `"disable"`
2. The job specification: a **single JSON object** (for `add`) or a job ID string (for others)

**WRONG — do NOT spread object properties as separate array elements:**
```json
"arguments": ["add", "type", "interval", "intervalMs", 60000, "action", { "type": "bash" }]
```

**CORRECT — second element is a single object:**
```json
"arguments": ["add", { "type": "interval", "intervalMs": 60000, "action": { "type": "bash", "command": "echo hello" } }]
```

## Tool Call Format

```json
{
  "reasoning": "Why you need this tool",
  "actions": [
    {
      "type": "tool_call",
      "tool": "CronJobsTool",
      "arguments": [
        "add",
        {
          "type": "interval",
          "intervalMs": 60000,
          "action": { "type": "bash", "command": "date > /tmp/time.txt" }
        }
      ],
      "reasoning": "Why this specific call is needed"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

## Job Types

### one_time — runs once at a specific time or after a delay
```json
{
  "type": "one_time",
  "delay": 60,
  "action": { "type": "prompt", "prompt": "Send a Discord message saying hello" }
}
```
- Use `delay` (seconds) OR `time` (ISO8601 string), not both
- Example with time: `"time": "2026-02-17T15:00:00.000Z"`

### interval — repeats on a fixed interval
```json
{
  "type": "interval",
  "intervalMs": 60000,
  "action": { "type": "bash", "command": "date > /tmp/time.txt" }
}
```
- `intervalMs` is in **milliseconds** (60000 = 1 minute)

### schedule — runs at a specific time on specific days
```json
{
  "type": "schedule",
  "schedule": {
    "days": [1, 2, 3, 4, 5],
    "hour": 9,
    "minute": 0
  },
  "action": { "type": "prompt", "prompt": "Good morning reminder" }
}
```
- `days`: 0=Sunday, 1=Monday … 6=Saturday
- `hour`: 0–23 (24-hour format)
- `minute`: 0–59

## Action Types

| type | required field | description |
|------|---------------|-------------|
| `"bash"` | `command` | Runs a shell command |
| `"prompt"` | `prompt` | Runs a text prompt through the AI |

## Other Commands

```json
["list"]
["remove", "jobId123"]
["enable",  "jobId123"]
["disable", "jobId123"]
```

## Validation Rules
- ALL jobs must have an `action` field
- `bash` action requires `command`
- `prompt` action requires `prompt`
- `one_time` requires either `delay` (seconds) or `time` (ISO8601)
- `interval` requires `intervalMs` (milliseconds)
- `schedule` requires a `schedule` object with `days`, `hour`, `minute`
