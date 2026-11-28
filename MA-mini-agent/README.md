# MA-mini-agent

A deliberately small coding agent for measuring how MemoryAnchor changes model behaviour.
Same loop and tools in every run; MemoryAnchor is a switch (`--ma` / `--no-ma`).

## Engines

Two implementations of the same agent, plus a multi-agent variant, picked with `--engine` or `agent.engine` in config:

| engine | folder | loop | model I/O |
|---|---|---|---|
| `langgraph` (default) | `src/langgraph/` | LangGraph `StateGraph`: `agent → tools → agent`, `agent → nudge → agent`, `agent → END` | LangChain `ChatAnthropic` / `ChatOpenAICompletions` (`models.mjs`) |
| `langgraph-multi` | `src/langgraph/multi.mjs` | planner → coder → reviewer (see below) | same as `langgraph` |
| `native` (`--engine native`) | `src/native/` | hand-written `while` loop | `providers/*` (fetch / `@anthropic-ai/sdk`) |

`src/agent.mjs` only dispatches and imports the selected engine. Both share the files at the `src/` root:
`core.mjs` (system prompt, AGENTS.md, input validation, tool execution, stop decision,
result shape), `tools/` (built-in tools), `memoryAnchor.mjs`, `config.mjs`, `trace.mjs` and `cli.mjs`, so a bench
difference between them comes from the loop and SDK layer only. Tool calls run one at a time in order
in both. Known differences in `langgraph`: tool-call arguments that are not valid JSON are replayed to the
model as `{}` (the model still gets the parse error), and `providers.anthropic.fallbacks` is not supported.

### Multi-agent (`--engine langgraph-multi`)

A fixed pipeline; each role is the single-agent `langgraph` graph run as a subgraph with its own role prompt
(appended to the shared system prompt) and tool subset:

| role | tools | gets | returns |
|---|---|---|---|
| planner | read-only (`list_dir`, `read_file`, `grep`, `glob`, MemoryAnchor reads) | the task | a plan |
| coder | all | task + plan; on later rounds its own history + review feedback | summary of the change |
| reviewer | read-only + `run_command` | task + plan + coder summary (fresh each round) | findings ending in `VERDICT: APPROVE` or `VERDICT: CHANGES` |

`VERDICT: CHANGES` sends the coder back, at most `agent.multiAgent.maxReviewRounds` times (default 2).
`agent.maxTurns` is the total across all roles, so a run never makes more model calls than a single-agent run;
`plannerMaxTurns` (12) and `reviewerMaxTurns` (10) cap each planner/reviewer run. A planner or reviewer that hits its
own cap hands over what it has. The run status is the coder's; it becomes `max_turns` when the total runs out before
the coder finished, and `refused` when any role refuses. Trace events carry `agent: <role>`, plus `agent_start` /
`agent_end`; `result.json` adds `multiAgent {roles {runs, turns, toolCalls, lastStatus}, reviewRounds, verdict, plan, lastReview}`.

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
node MA-mini-agent/src/cli.mjs -w <repo> -p "Fix the failing pricing test" --ma --engine langgraph-multi
node MA-mini-agent/src/cli.mjs -w <repo> -p "Fix the failing pricing test" --ma --engine native   # hand-written loop
```

In bench the default is also `langgraph`; for the hand-written loop:
`node bench/src/cli.mjs run --suite <s> --agent-engine native --run-id <s>-native`.

Each run writes `trace.jsonl` (every model turn and tool call) and `result.json` to `runs/<timestamp>/` or `-o`.
Exit code is 0 only when the model finished on its own (`status: completed`).

## What the loop does

1. With `--ma`: run `dist/hooks/claude/session-start.js` in the workspace and put its output in the system
   prompt; connect to `anchor mcp` and expose `get_chart`, `get_file`, `get_memory`, `recall_memory`, `write_memory`; with
   `--prompt-hook` append the UserPromptSubmit reminder to the task.
2. Load `AGENTS.md` from the workspace root when present (both conditions).
3. Loop: model turn → run tool calls in order → return all results → repeat, until the model stops calling
   tools, refuses, or hits `maxTurns`. Responses cut off by the output limit get up to two "continue" nudges.
4. With `--ma`: run the Stop hook (incremental chart refresh), then close MCP.

Built-in tools: `list_dir`, `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `run_command`
(omit with `--no-commands`). Paths cannot escape the workspace; `run_command` drops credential-like
environment variables.

## result.json (input for bench/)

`status`, `engine`, `finalText`, `turns`, `toolCalls`, `toolErrors`, `toolCounts`, `usage {input, output, cacheRead, cacheWrite}`,
`files {read, written, matched, listed, maFiles, maCharts}`, `inspections` (first time each file was read via
`read_file` or `get_file`, with its tool-call index), `commands`, and `memoryAnchor` (context bytes, hook timings, MCP tools).
