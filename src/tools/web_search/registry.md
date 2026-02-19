# WebSearchTool Registry

## Usage Instructions

Use WebSearchTool to search the web and retrieve relevant results. Always respond in structured JSON format:

```
{
  "reasoning": "Why you need to search the web",
  "actions": [
    {
      "type": "tool_call",
      "tool": "WebSearchTool",
      "arguments": {
        "op": "search",
        "query": "your search query",
        "count": 5
      },
      "reasoning": "Search for information on this topic"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

- Only respond with valid JSON, no extra text or formatting.
- Set `"continue": true` if you need to process results or call more tools afterward.

---

## Supported Operations

### `search`

Search the web and return a list of results.

**Required:**
- `query` (string) — the search query

**Optional:**
- `count` (integer, 1–20, default 10) — number of results to return
- `offset` (integer, 0–9, default 0) — pagination offset
- `freshness` (string) — limit results by age: `"pd"` (past day), `"pw"` (past week), `"pm"` (past month), `"py"` (past year)
- `country` (string) — 2-letter country code to bias results (e.g. `"us"`, `"gb"`)
- `search_lang` (string) — language code (e.g. `"en"`, `"es"`)
- `safesearch` (string) — `"off"`, `"moderate"`, or `"strict"`
- `extra_snippets` (boolean) — include additional text snippets per result
- `engine` (string) — override the default search engine (`"searchapi"` or `"brave"`)

---

## Response Structure

```json
{
  "success": true,
  "engine": "brave",
  "query": "your query",
  "result_count": 5,
  "results": [
    {
      "title": "Page title",
      "url": "https://example.com/page",
      "description": "Short excerpt or meta description",
      "age": "2 days ago",
      "extra_snippets": []
    }
  ]
}
```

On failure:
```json
{ "success": false, "error": "Description of the error" }
```

---

## Examples

**Basic search:**
```json
{
  "type": "tool_call",
  "tool": "WebSearchTool",
  "arguments": {
    "op": "search",
    "query": "best way to prune oak trees",
    "count": 5
  }
}
```

**Recent news search:**
```json
{
  "type": "tool_call",
  "tool": "WebSearchTool",
  "arguments": {
    "op": "search",
    "query": "SpaceX Starship launch",
    "count": 5,
    "freshness": "pw"
  }
}
```

**Country-targeted search:**
```json
{
  "type": "tool_call",
  "tool": "WebSearchTool",
  "arguments": {
    "op": "search",
    "query": "local plumbing regulations",
    "count": 8,
    "country": "us"
  }
}
```

---

## Best Practices

- Use concise, specific queries — treat this like a web search bar.
- Use `freshness: "pd"` or `"pw"` when the user asks about current events or recent information.
- Prefer `count: 5` for most queries; increase to 10+ when more comprehensive coverage is needed.
- Always reference `results[].url` and `results[].description` in your final answer — do not present raw JSON to the user.
- If results are insufficient, refine the query and search again.

---

Always use this schema for WebSearchTool calls. Do not include conversational text outside the JSON object.
