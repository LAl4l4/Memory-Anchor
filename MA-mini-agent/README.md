# MA-mini-agent

A deliberately small coding agent for measuring how MemoryAnchor changes model behaviour.
Same loop and tools in every run; MemoryAnchor is a switch (`--ma` / `--no-ma`).

## Setup

```bash
cd MA-mini-agent && npm install
cp config.example.json config.json   # gitignored — put your API settings here
(cd .. && npm run build)             # hooks and MCP run from ../dist
```

`config.json` selects a `provider`:

| provider    | transport                                   | notes |
|-------------|---------------------------------------------|-------|
| `openai`    | `fetch` → `{baseUrl}/chat/completions`      | DeepSeek, Qwen, Kimi, OpenRouter, vLLM, Ollama… `extraBody` is merged into each request. |
| `anthropic` | official `@anthropic-ai/sdk`                | prompt caching on, `effort` configurable, `fallbacks` off by default so a run is never served by a different model. |
| `mock`      | scripted, offline                           | for smoke tests of the loop and MemoryAnchor wiring. |

Keys can go in `apiKey` or in the env var named by `apiKeyEnv`.

## Run

```bash
node MA-mini-agent/src/cli.mjs -w <repo> -p "Fix the failing pricing test" --ma
node MA-mini-agent/src/cli.mjs -w <repo> -f task.md --no-ma --max-turns 30 -o out/
```

Each run writes `trace.jsonl` (every model turn and tool call) and `result.json` to `runs/<timestamp>/` or `-o`.
Exit code is 0 only when the model finished on its own (`status: completed`).

## What the loop does

1. With `--ma`: run `dist/hooks/claude/session-start.js` in the workspace and put its output in the system
   prompt; connect to `anchor mcp` and expose `get_chart`, `get_file`, `get_project_state`; with
   `--prompt-hook` append the UserPromptSubmit reminder to the task.
2. Load `AGENTS.md` from the workspace root when present (both conditions).
3. Loop: model turn → run tool calls in order → return all results → repeat, until the model stops calling
   tools, refuses, or hits `maxTurns`. Responses cut off by the output limit get up to two "continue" nudges.
4. With `--ma`: run the Stop hook (incremental chart refresh), then close MCP.

Built-in tools: `list_dir`, `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `run_command`
(omit with `--no-commands`). Paths cannot escape the workspace; `run_command` drops credential-like
environment variables.

## result.json (input for bench/)

`status`, `finalText`, `turns`, `toolCalls`, `toolErrors`, `toolCounts`, `usage {input, output, cacheRead, cacheWrite}`,
`files {read, written, matched, listed, maFiles, maCharts}`, `inspections` (first time each file was read via
`read_file` or `get_file`, with its tool-call index), `commands`, and `memoryAnchor` (context bytes, hook timings, MCP tools).
