# HttpRequestTool Registry

## Usage Instructions

Respond in structured JSON format for HttpRequestTool actions:

```
{
  "reasoning": "Why you need to make an HTTP request",
  "actions": [
    {
      "type": "tool_call",
      "tool": "HttpRequestTool",
      "arguments": {
        "method": "GET|POST",
        "url": "https://...",
        "body": "...", // optional, for POST
        "headers": { "Authorization": "Bearer ..." } // optional
      },
      "reasoning": "Fetch or post data to a web resource"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Use the "actions" array to specify HttpRequestTool calls. Each action must include the tool name and arguments.
- Set "continue": true if you need to call more tools after receiving results.
- Provide your reasoning for each action and for your overall answer.

## Body Serialization

Pass `body` as a **JSON object** — the tool serializes it automatically:

| body type | Content-Type header | Wire format |
|-----------|--------------------|-----------------------|
| object (no header / json header) | auto-set to `application/json` | `{"key":"value"}` |
| object | `application/x-www-form-urlencoded` | `key=value&key2=value2` |
| string | unchanged | sent as-is |

**Prefer the `body` field for POST/PUT parameters.** If you do put parameters in the URL query string for a POST/PUT/PATCH/DELETE request and provide no body, the tool will automatically move them to the body as form-encoded data.

## Examples

**GET request:**
```json
{
  "type": "tool_call",
  "tool": "HttpRequestTool",
  "arguments": {
    "method": "GET",
    "url": "https://example.com/api/status"
  }
}
```

**POST form-encoded data (e.g. local device/IoT APIs):**
```json
{
  "type": "tool_call",
  "tool": "HttpRequestTool",
  "arguments": {
    "method": "POST",
    "url": "http://10.75.0.42/set",
    "body": { "zone": 1, "temp": 70 },
    "headers": { "Content-Type": "application/x-www-form-urlencoded" }
  }
}
```

**POST JSON data with auth:**
```json
{
  "type": "tool_call",
  "tool": "HttpRequestTool",
  "arguments": {
    "method": "POST",
    "url": "https://api.example.com/data",
    "body": { "foo": "bar" },
    "headers": { "Authorization": "Bearer mytoken" }
  }
}
```

## Tool Results Structure

When the HttpRequestTool runs, it returns toolResults with the following structure:

```
{
  "tool": "HttpRequestTool",
  "arguments": {
    "method": "GET|POST",
    "url": "...",
    "body": "...",
    "headers": { ... }
  },
  "result": [
    {
      "method": "GET|POST",
      "url": "...",
      "body": "...",
      "headers": { ... },
      "statusCode": 200,
      "result": "response body",
      "error": null,
      "exitCode": 0
    }
  ]
}
```

- `result`: The response body (webpage or API response)
- `statusCode`: HTTP status code
- `error`: Error object or null
- `exitCode`: Exit code of the operation

Always reference the `result` value in your final_answer when presenting HTTP results to the user.

---

Always use this schema for HttpRequestTool calls. Do not include conversational text outside the JSON object.
