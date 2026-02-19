# PdfTool Registry

## Usage Instructions

Respond in structured JSON format for PdfTool actions:

```
{
  "reasoning": "Why you need to use PdfTool",
  "actions": [
    {
      "type": "tool_call",
      "tool": "PdfTool",
      "arguments": { "action": "read", "filepath": "/path/to/file.pdf" },
      "reasoning": "Read the PDF to extract its text"
    }
  ],
  "final_answer": "",
  "continue": true
}
```

---

## Actions

### `read` — Extract text from a PDF
```json
{ "action": "read", "filepath": "/absolute/path/to/file.pdf" }
```
Returns: `{ text, num_pages, info, error, exitCode }`

---

### `write` — Create a new PDF

**Auto page-break mode** (recommended for long content — pages are created automatically):
```json
{
  "action": "write",
  "filepath": "/absolute/path/to/output.pdf",
  "content": "Full document text here.\n\nNew paragraph.\n\nThe tool handles word wrap and page breaks automatically.",
  "font_size": 12
}
```

**Explicit pages mode** (when you want control over page structure):
```json
{
  "action": "write",
  "filepath": "/absolute/path/to/output.pdf",
  "pages": [
    { "title": "Chapter 1", "text": "Content for the first page." },
    { "title": "Chapter 2", "text": "Content for the second page." }
  ],
  "font_size": 12
}
```
Returns: `{ filepath, num_pages, error, exitCode }`

**Notes:**
- `font_size` defaults to 12. `margin` defaults to 50 points.
- Word wrap and line breaks (`\n`) are handled automatically.
- Font is Helvetica (standard Latin characters only — no emoji or CJK).

---

### `add_page` — Append a page to an existing PDF
```json
{
  "action": "add_page",
  "filepath": "/absolute/path/to/existing.pdf",
  "title": "Optional Page Title",
  "text": "Content to add on the new page.",
  "font_size": 12
}
```
Returns: `{ filepath, num_pages, error, exitCode }`

---

### `merge` — Combine multiple PDFs into one
```json
{
  "action": "merge",
  "files": ["/path/to/a.pdf", "/path/to/b.pdf", "/path/to/c.pdf"],
  "output": "/path/to/merged.pdf"
}
```
Returns: `{ output, sources, num_pages, error, exitCode }`

---

## Tool Results Structure

```json
{
  "tool": "PdfTool",
  "arguments": { "action": "read", "filepath": "/tmp/report.pdf" },
  "result": {
    "filepath": "/tmp/report.pdf",
    "text": "Extracted text content...",
    "num_pages": 5,
    "info": {},
    "error": null,
    "exitCode": 0
  }
}
```

- `error`: Error message string or null
- `exitCode`: 0 = success, 1 = failure

Always reference the result in your `final_answer` when confirming the operation to the user.

---

Always use this schema for PdfTool calls. Do not include conversational text outside the JSON object.
