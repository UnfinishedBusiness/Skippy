# Skippy

Skippy is a Discord-native AI daemon powered by [Ollama](https://ollama.com). It runs as a background process on your server, connects to your Discord guild, and gives you a persistent AI assistant you can talk to from any channel or DM — with a tool loop, long-term memory, cron scheduling, and file/PDF/web/Trello integration built in.

## Background

Skippy was born out of frustration with [OpenClaw](https://github.com/RecentRichRail/OpenClaw). OpenClaw does some things well, but it fails badly at others — the configuration is a sprawling mess, the documentation is largely outdated, and support for Ollama cloud APIs was simply missing. After spending many hours trying to bolt an ollama-cloud integration onto OpenClaw and getting nowhere, it became clear that patching it further wasn't worth the effort.

So Skippy was built from scratch with a different philosophy: one clean config file, Discord as the main interface, a straightforward tool loop, and first-class support for cloud-hosted Ollama models from day one. Everything that was painful about OpenClaw was a design decision when building Skippy.

The tool system is deliberately simple and robust. Each tool is a self-contained class with a `run()` method and an optional `registry.md` that describes its capabilities to the model. Adding a new tool is a single focused task — in practice, an AI coding assistant like Claude Code can write a fully working new Skippy tool in a single prompt.

---

> **⚠️ Security Warning — Run Skippy on a dedicated machine**
>
> Skippy has full, unrestricted access to the system it runs on. The Bash tool can execute any shell command, read and write any file, install packages, modify system configuration, and interact with any networked service the host can reach. **A poorly-worded prompt, a hallucinating model, or a compromised Discord account is all it takes to cause serious damage.**
>
> **The recommended setup is a dedicated machine** — a Raspberry Pi, Latte Panda, or similar single-board computer that hosts nothing critical. That way the blast radius of any mistake is limited to a machine you can re-flash.
>
> **Root access via passwordless sudo:** Skippy runs as a normal user, but you can give it full root capabilities by configuring passwordless sudo for that user. This is how the Bash tool can perform privileged operations (package installs, service management, hardware control, etc.) without a password prompt. To enable it:
> ```bash
> # Run as root — replace 'skippy' with your actual username
> echo 'skippy ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/skippy
> chmod 440 /etc/sudoers.d/skippy
> ```
> Only do this on a machine you are comfortable giving Skippy complete control over. Do not run Skippy with passwordless sudo on a shared server, a machine with sensitive data, or anything connected to production infrastructure.

---

## Features

- **Discord-first** — talk to Skippy from any channel; it maintains per-channel message history
- **Agentic tool loop** — the model can call tools (bash, file read/write, web search, HTTP, Trello, PDF, weather, Discord messages) and iterate until it has an answer
- **Persistent memory** — global, per-channel, and skill-based memory stored in SQLite
- **Cron scheduling** — schedule bash commands or AI prompts to run on a timer or cron-like schedule
- **Persistent context** — attach files and images that get injected into every prompt
- **Ollama backend** — works with any local or cloud Ollama-compatible model
- **CLI** — start/stop/restart the daemon, tail logs, and send prompts from the terminal

---

## Prerequisites

- **Node.js** 18+
- **An Ollama server** — local (`localhost:11434`) or cloud (e.g., [ollama.com](https://ollama.com))
- **A Discord bot** with the following permissions and intents (see [Discord Bot Setup](#discord-bot-setup))

---

## Installation

```bash
git clone https://github.com/yourname/skippy.git
cd skippy
npm install
chmod +x skippy
```

### Create the config directory

Skippy stores all user data in `~/.Skippy/`. It will refuse to start if this directory doesn't exist.

```bash
mkdir -p ~/.Skippy/memory
cp Skippy.example.json ~/.Skippy/Skippy.json
```

Then edit `~/.Skippy/Skippy.json` with your credentials (see [Configuration](#configuration)).

---

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Under **Bot**, enable the following **Privileged Gateway Intents**:
   - `Message Content Intent`
   - `Server Members Intent`
3. Under **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands`, then grant these bot permissions:
   - `Read Messages / View Channels`
   - `Send Messages`
   - `Manage Messages` (for `/clear`)
   - `Read Message History`
   - `Add Reactions`
4. Copy the generated URL and use it to invite the bot to your server.
5. Copy the bot token and your guild (server) ID into `~/.Skippy/Skippy.json`.

---

## Configuration

`~/.Skippy/Skippy.json` is the single config file. Use `Skippy.example.json` in the repo as a starting point.

```jsonc
{
  "log_level": "info",          // "debug" | "info" | "warn" | "error"

  "discord": {
    "token": "<Bot Token>",
    "guildId": "<Guild ID>",
    "messageHistoryLimit": 20,  // How many messages of history to send per prompt
    "default_user": "username"  // Discord username for DM fallbacks
  },

  "ollama": {
    "host": "https://api.ollama.com",  // Your Ollama endpoint
    "apiKey": "<API Key>",             // Bearer token (required by ollama-js)
    "model": "llama3.1:70b",           // Default model to use
    "timeout": 120000,                 // Request timeout (ms)
    "stream_inactivity_timeout": 30000,// Abort if no chunk received for this long (ms)
    "max_retries": 3,                  // Retries on transient errors (429, 503, etc.)
    "context_window": 128000           // Optional: override auto-detected context window
  },

  "prompt": {
    "loop_limit": 10    // Max tool-call iterations per prompt
  },

  "memory": {
    "context_categories": ["agent", "preferences", "user_info"]
    // Memories in these categories are injected into every prompt as context
  },

  "tools": {
    "trello": {
      "apiKey": "<Trello API Key>",
      "apiToken": "<Trello API Token>"
    },
    "web_search": {
      "default_engine": "brave",  // "brave" or "searchapi"
      "engines": {
        "brave": { "apiKey": "<Brave Search API Key>" },
        "searchapi": { "apiKey": "<SearchAPI.io Key>" }
      }
    }
  }
}
```

---

## Running Skippy

Skippy is controlled via the `./skippy` CLI wrapper.

```bash
./skippy start              # Start as a background daemon
./skippy start --debug      # Run in the foreground with live colored output
./skippy stop               # Stop the running daemon
./skippy restart            # Restart the daemon
./skippy log                # Print the daemon log
./skippy log --follow       # Follow the log live (like tail -f)
```

### Sending prompts from the terminal

```bash
./skippy prompt "What's the weather in NYC?"

# With extra context
./skippy prompt --context "See attached report" "Summarize this"

# Pipe context from stdin
cat report.txt | ./skippy prompt "Summarize this"

# Use a specific model for this prompt only
./skippy prompt --model llama3.3:70b "Explain quantum entanglement"

# Send the result to Discord
./skippy prompt --output discord "Write a daily standup summary"
./skippy prompt --output discord --user travis "Here's your summary"
./skippy prompt --output discord --channel general "Good morning everyone"

# Send a raw message to Discord (no LLM)
./skippy discord "Server maintenance in 5 minutes"
./skippy discord --channel announcements "Deployment complete"
```

---

## First-Run Onboarding

Once Skippy is running and connected to Discord, the first thing to do is introduce yourself and tell him how you want him to behave. Skippy stores this in his memory under the `agent`, `user_info`, and `preferences` categories, which are automatically injected into every future prompt — so you only need to do this once.

Open a DM or a dedicated channel and send something like the following. You don't need to use these exact words — just talk to him naturally and he'll save what matters.

**Tell him who he is and how to behave:**

> Your name is Skippy. You're a personal AI assistant running on my home server. Be direct and concise — I don't need pleasantries or filler. When I ask you to do something, do it. If you're not sure, make a reasonable attempt and tell me what you did. Save this to your agent memory.

**Tell him about the primary user:**

> The main person you'll be talking to is Travis. He lives in Seattle, Washington (Pacific Time). He's a software developer and works with Node.js, Linux, and home automation. Save this to user_info memory.

**Set preferences:**

> A few preferences to remember: I prefer metric for weather but Fahrenheit for thermostats. When writing code, use Node.js unless I specify otherwise. Keep responses short unless I ask for detail. Save these to preferences memory.

**Tell him about his environment:**

> You're running on a Latte Panda in my home office. You have full sudo access. The home network is 192.168.1.0/24. Save this to agent memory.

After each message, Skippy will confirm what he saved. From that point on, every prompt he receives will include that context automatically — he'll know who he's talking to, where he is, and how to behave without being reminded.

You can add to or update his memory at any time the same way — just tell him in plain language and ask him to save it.

---

## Discord Commands

Slash commands are registered to your guild automatically on startup.

| Command | Description |
|---------|-------------|
| `/stop` | Abort the currently running prompt in this channel |
| `/clear` | Delete message history in this channel (last 14 days) |
| `/model list` | Show all available Ollama models with size, quantization, and context length |
| `/model set <name>` | Switch the active model (validated against available models, persisted to config) |
| `/loop_limit get` | Show the current max tool-call iterations |
| `/loop_limit set <n>` | Change the loop limit (1–200, persisted to config) |
| `/context add file <path>` | Add a local file to persistent context (injected into every prompt) |
| `/context add image <url>` | Add an image URL or local path to persistent context |
| `/context remove <index>` | Remove a context item by its number from `/context list` |
| `/context list` | Show all persistent context items |
| `/context status` | Show estimated token usage per context item vs. your model's context window |
| `/context clear` | Remove all persistent context items |

---

## How Skippy Listens

### DMs

Send Skippy a direct message and it always responds — no mention needed. DMs are ideal for personal prompts, sensitive tasks, or one-on-one interactions.

### Channels — single user vs. multiple users

Skippy looks at how many humans can see the channel before deciding whether to respond:

- **One human in the channel** — Skippy responds to every message, no callout needed. This is the recommended setup for dedicated task channels like `#shop-thermostat` or `#home-automation`. Skippy treats it like a DM.
- **Multiple humans in the channel** — Skippy only responds when directly mentioned (`@Skippy`). This prevents it from jumping into every conversation in a shared channel.

### Channel name as topic context

Every time a message is processed, Skippy injects the channel name into its system context:

```
Current channel: shop-thermostat
```

Skippy uses this as implicit topic framing — it knows it's in the shop thermostat channel without you spelling it out every time. This also scopes channel memory: memories written in `#shop-thermostat` are only retrieved from that channel, keeping concerns cleanly separated.

A good pattern is to create dedicated single-user channels for each domain (`#home-lab`, `#finances`, `#shop-thermostat`) so Skippy always has topic context and you never need to mention it.

### Conversation history from Discord

Skippy derives its entire conversation history directly from Discord. On every message it fetches the last `messageHistoryLimit` messages (default: 20) from the channel using Discord's API, formats them as `username: message`, and prepends that history to the prompt. There is no separate internal history store — Discord *is* the history.

This means:
- Conversation context naturally persists across daemon restarts
- You can scroll up in Discord to see exactly what context Skippy is working with
- `/clear` wipes that history, giving Skippy a fresh slate in that channel
- Skippy's own status/processing messages (🤔 Analyzing..., ⚙️ Processing...) are automatically filtered out so they don't pollute the context

---

## Tools

The AI has access to the following tools. It decides when to use them based on the prompt.

### Bash
Execute shell commands. Supports background processes with `bg:start`, `bg:list`, `bg:status`, `bg:stdout`, `bg:stderr`, and `bg:kill`.

### File Read / Write / Patch
- **FileReadTool** — Read any file by absolute path
- **FileWriteTool** — Create or overwrite a file (creates parent directories as needed)
- **PatchFileTool** — Targeted find/replace edits; pass an array of `{find, replace}` pairs to make multiple surgical changes in one call

### PDF
Read, create, and modify PDF files:
- `read` — Extract all text
- `write` — Create a new PDF from a text string (auto page-break) or an array of pages with optional titles
- `add_page` — Append a page to an existing PDF
- `merge` — Combine multiple PDFs into one

### File Download
Asynchronous file downloads with progress tracking. Sends a Discord DM notification on completion.

### HTTP Request
Make GET and POST requests with custom headers and JSON or form-encoded bodies.

### Web Search
Search the web via Brave Search or SearchAPI.io. Supports `freshness` filters (`pd`/`pw`/`pm`/`py`), country and language targeting, and safe search.

### Weather
Get current conditions and multi-day forecasts for any location. Uses wttr.in with open-meteo as a fallback. Supports `imperial` and `metric` units.

### Discord
Send DMs or channel messages directly from within a prompt response.

### Trello
Full Trello management: boards, lists, cards (create/update/move/archive/delete), comments, labels, and members.

### Memory
Persistent key/value storage in SQLite. See the [Memory](#memory) section below.

### Cron Jobs
Schedule recurring tasks. See the [Cron Jobs](#cron-jobs) section below.

---

## Memory

Skippy has a three-tiered memory system backed by SQLite (`~/.Skippy/memory/memory.db`).

### Scopes

| Scope | Description |
|-------|-------------|
| **Global** | Accessible from every channel and prompt |
| **Channel** | Scoped to a single Discord channel by name |
| **Skills** | Named behavioral units with structured data and instructions |

### Auto-injected context

Memories whose `category` matches one of the values in `memory.context_categories` (default: `agent`, `preferences`, `user_info`) are automatically included in the system context on every prompt. Use these to teach Skippy persistent behaviors and facts about users.

### Operations

```
Global:   setGlobal, getGlobal, deleteGlobal, listGlobal, searchGlobal
Channel:  setChannel, getChannel, deleteChannel, getChannelByCategory,
          listChannelKeys, listChannels, purgeChannel
Skills:   createSkill, updateSkill, getSkill, listSkills, listSkillsForUser,
          deleteSkill
Search:   search  (cross-scope, full-text token match on key/value/tags/category)
```

### Training Skills in natural language

Skills are Skippy's way of learning how to do something domain-specific. You train them through conversation — just tell Skippy what it needs to know and it handles the `createSkill`/`updateSkill` calls itself.

**Example: IoT thermostat control**

Suppose you have two thermostats on your network that you want Skippy to control or monitor

> **#shop-thermostat**
>
> *You:* Create a skill called `shop_thermostat` for controlling my shop HVAC. The API is at `http://192.168.1.50:8080/api`. To read the current state, GET `/status` — it returns `{"temp": 72, "setpoint": 70, "mode": "heat"}`. To change the setpoint, POST `/temperature` with `{"temp": <value>}`. Normal operating range is 65–78°F. Below 60°F or above 85°F is an emergency — DM me immediately. The shop is occupied Monday–Friday 8am–6pm.
>
> *Skippy:* Got it. I've created the `shop_thermostat` skill with the API details, normal range, emergency thresholds, and schedule. I'll use this any time you ask me about the shop temperature.

From that point on, in any channel where the skill is visible, you can just ask:

> *You:* What's the shop at right now?

> *You:* It's getting cold tonight — pre-heat the shop to 70 before 7am tomorrow.

> *You:* If the shop drops below 55°F overnight, text me and bring it up to 65.

Skippy retrieves the skill, reads the API details, and executes via the HTTP or Bash tool — no re-explaining the endpoint or credentials each time.

You can keep training the skill over time by just telling Skippy new information:

> *You:* The shop thermostat API moved to 192.168.1.55. Update the skill.

> *You:* Add to the shop_thermostat skill: in summer (June–August), the upper comfort limit is 76°F, not 78.

Skills accumulate knowledge through deep-merge updates, so each addition builds on the last without overwriting existing data.

**Skill visibility**

Skills can be global (visible in all channels) or owned by a specific user. When the skill owner sends a message, their personal skills are included in the context automatically alongside global skills.

---

## Cron Jobs

Cron jobs are managed by the `CronJobsTool` and stored in `~/.Skippy/memory/cron.db`. The AI can create, list, enable, disable, and remove jobs.

### Job types

**One-time:**
```json
{ "type": "one_time", "delay": 3600 }           // Run in 1 hour
{ "type": "one_time", "time": "2025-12-31T23:59:00Z" }  // Run at specific UTC time
```

**Interval:**
```json
{ "type": "interval", "intervalMs": 3600000 }   // Every hour
```

**Scheduled (cron-like):**
```json
{ "type": "schedule", "days": [1,2,3,4,5], "hour": 9, "minute": 0 }  // Mon–Fri 9:00 AM
```

### Action types

```json
{ "action_type": "bash",   "action": "df -h >> ~/disk_report.txt" }
{ "action_type": "prompt", "action": "Summarize any important news and DM me" }
```

---

## Extending Skippy — Adding a Tool

Every tool is a class that extends `Tool` from `src/tools/tool_prototype.js`, which has three optional methods:

```js
class MyTool extends Tool {
  async init() { /* called once at startup — open connections, load config */ }
  async run(args) { /* called by the tool loop — do the work, return a result object */ }
  getContext() { /* return a string (usually registry.md) describing this tool to the model */ }
}
```

To add a new tool:

1. Create `src/tools/my_tool/my_tool.js` extending `Tool`
2. Create `src/tools/my_tool/registry.md` describing what the tool does, its arguments, and example calls — this is what the model reads to know how to use it
3. Register it in `src/tools/tools.js`:
   ```js
   const MyTool = require('./my_tool/my_tool');
   // add to the tools array:
   new MyTool(),
   ```

That's it. The tool loop, argument passing, and context injection are all handled automatically.

The `registry.md` is the most important part — a well-written registry means the model will use your tool correctly without any changes to the prompt engine. Look at any existing tool's `registry.md` for examples.

Because the interface is so minimal, an AI coding assistant like Claude Code can produce a complete, working tool in a single prompt if you describe what it should do.

---

## Project Structure

```
skippy/                     # Repo root
├── skippy                  # CLI entry point (chmod +x this)
├── Skippy.example.json     # Config template — copy to ~/.Skippy/Skippy.json
├── src/
│   ├── index.js            # Daemon entry point
│   ├── cli.js              # CLI commands (start/stop/restart/log/prompt/discord)
│   └── core/
│   │   ├── paths.js        # All ~/.Skippy paths in one place
│   │   ├── prompt.js       # Prompt + tool loop engine
│   │   ├── discord.js      # Discord client, slash commands, message handling
│   │   ├── context.js      # Context compression utilities
│   │   ├── context-manager.js  # /context persistent file/image management
│   │   ├── ipc.js          # Unix socket IPC between CLI and daemon
│   │   ├── ollama-cloud.js # Ollama client with retries and model info
│   │   └── color.js        # Terminal colorization helpers
│   └── tools/
│       ├── tool_prototype.js   # Base Tool class
│       ├── bash/
│       ├── file_read/
│       ├── file_write/
│       ├── patch_file/
│       ├── pdf/
│       ├── file_download/
│       ├── http_request/
│       ├── discord/
│       ├── memory/
│       ├── cron_jobs/
│       ├── weather/
│       ├── web_search/
│       ├── trello/
│       └── tools.js        # Tool registry and tool-loop dispatcher
└── ~/.Skippy/              # Created by you — NOT in the repo
    ├── Skippy.json         # Your config (from Skippy.example.json)
    ├── Skippy.log          # Runtime log (truncated on each start)
    ├── daemon.pid          # PID file for background daemon
    ├── skippy.sock         # Unix socket for CLI↔daemon IPC
    ├── context.json        # Persistent /context items
    └── memory/
        ├── memory.db       # Memories and skills (SQLite)
        └── cron.db         # Cron job definitions (SQLite)
```

---

## License

MIT
