# FileDownloadTool Registry

Use the FileDownloadTool to download files from URLs in the background. Downloads run asynchronously — you get an ID immediately and can poll progress while the download runs. A Discord DM is automatically sent to the requesting user when the download completes or fails.

## Operations

### `download` — Start a background download
Required: `url`
Optional:
- `dest` — destination directory (default: `workspace/downloads/`)
- `filename` — override the filename (default: detected from URL or Content-Disposition header)
- `notifyUser` — Discord username to DM when complete (e.g. `"travis.gillin"`)

Returns: `{ success, id, message }`

**Always pass `notifyUser` when a real user triggered the download.** This is how they get notified when it finishes — you will not be in an active loop while the download runs.

### `status` — Check progress of a download
Optional: `id` — omit to get all downloads

Returns current state including: `status`, `percent`, `bytesDownloadedHuman`, `totalBytesHuman`, `speedHuman`, `elapsedHuman`, `etaHuman`, `error`

Status values: `pending` → `downloading` → `completed` | `failed` | `cancelled`

### `list` — List all known downloads
No parameters. Returns all active and completed downloads.

### `cancel` — Cancel an active download
Required: `id`

## Examples

**Start a download and notify the user when done:**
```json
{
  "tool": "FileDownloadTool",
  "op": "download",
  "url": "https://example.com/largefile.zip",
  "dest": "/home/skippy/Downloads",
  "notifyUser": "travis.gillin"
}
```

**Check progress (when user asks "how's the download going?"):**
```json
{
  "tool": "FileDownloadTool",
  "op": "status",
  "id": "dl_1234567890_ab3f"
}
```

**List all downloads:**
```json
{
  "tool": "FileDownloadTool",
  "op": "list"
}
```

**Cancel a download:**
```json
{
  "tool": "FileDownloadTool",
  "op": "cancel",
  "id": "dl_1234567890_ab3f"
}
```

## Completion DM format

When a download completes, the notifyUser receives a DM like:

**Success:**
```
📥 Download complete: `largefile.zip`
Size: 1.24 GB
Saved to: `/home/skippy/Downloads/largefile.zip`
Duration: 2m 34s
Avg speed: 8.51 MB/s
```

**Failure:**
```
❌ Download failed: `largefile.zip`
Error: Connection reset
Received: 412.3 MB / 1.24 GB
Duration: 1m 12s
URL: https://example.com/largefile.zip
```

## Behavior notes
- Downloads survive the prompt loop ending — they continue in the background
- Redirects are followed automatically (up to 10)
- If a file with the same name already exists, a counter is appended: `file(1).zip`
- Progress speed is calculated from a rolling window of recent chunk timings for accuracy
- Cancellations do not send a DM
