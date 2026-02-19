# DiscordTool Registry

## Usage Instructions

Respond in structured JSON format for DiscordTool actions:

```
{
  "reasoning": "Why you need to send a Discord message",
  "actions": [
    {
      "type": "tool_call",
      "tool": "DiscordTool",
      "arguments": {
        "targetType": "user|channel",
        "target": "userId|username|channelId|channelName",
        "message": "Your message text"
      },
      "reasoning": "Send a message to a Discord user or channel"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Use the "actions" array to specify DiscordTool calls. Each action must include the tool name and arguments.
- Set "continue": true if you need to call more tools after receiving results.
- Provide your reasoning for each action and for your overall answer.

## Example

To send a DM to a user:
```
{
  "reasoning": "User wants to notify Travis Gillin directly",
  "actions": [
    {
      "type": "tool_call",
      "tool": "DiscordTool",
      "arguments": {
        "targetType": "user",
        "target": "travis.gillin",
        "message": "Hello Travis, your file was deleted."
      },
      "reasoning": "Send DM to Travis Gillin"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

To send a message to a channel:
```
{
  "reasoning": "User wants to notify #general",
  "actions": [
    {
      "type": "tool_call",
      "tool": "DiscordTool",
      "arguments": {
        "targetType": "channel",
        "target": "general",
        "message": "Hello, world!"
      },
      "reasoning": "Send message to #general"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

## Tool Results Structure

When the DiscordTool runs, it returns toolResults with the following structure:

```
{
  "tool": "DiscordTool",
  "arguments": {
    "targetType": "user|channel",
    "target": "userId|username|channelId|channelName",
    "message": "..."
  },
  "result": [
    {
      "targetType": "user|channel",
      "target": "userId|username|channelId|channelName",
      "message": "...",
      "result": "Success or error message",
      "error": null,
      "exitCode": 0
    }
  ]
}
```

- `result`: Success or error message
- `error`: Error object or null
- `exitCode`: Exit code of the operation

Always reference the `result` value in your final_answer when confirming Discord messages to the user.

---

Always use this schema for DiscordTool calls. Do not include conversational text outside the JSON object.
