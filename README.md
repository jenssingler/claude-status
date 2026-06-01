# Claude Code status line

This is a simple status line helper which displays information about the current session.
The main motivation is to help to understand, if the prompt cache might have reached TTL and how much context is currently being used.
Based on those factors you can decide whether `/clear` or continue prompting is the better option. 

## How it works

Reads the session JSON from stdin and prints a single status line:
```
~/path | sonnet-4.6 | 12% ctx | 1m4s | +$0.0123 / $0.8572
```
**Design notes:**
- Model name comes from model.display_name (e.g. "Opus 4.8"), falling back to model.id when the display name has no version. New models like opus-5 render correctly without edits.
- Per-turn cost is the delta of the cumulative cost.total_cost_usd that Claude Code reports.
- The idle timer reads the transcript to find the last *main-session* activity (any user prompt or tool turn), skipping subagent sidechain entries.

## Setup in ~/.claude/settings.json

You need Node.js (18+ is fine) and you need to store the script somewhere, e.g. `~/.claude/statusline.js`
Then edit `~/.claude/settings.json` (or project level only: `.claude/settings.json`) and add this in the top-level object:
```json
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.js",
    "refreshInterval": 1
  }
```
Typically, it should work without a Claude restart, but if the status line should not appear restart Claude.

The `refreshInterval` should be 1 second, since you want to know, when the cache TTL might hit (minimum Claude Code version v2.1.97 required).

Official status line [documentation](https://code.claude.com/docs/en/statusline).

