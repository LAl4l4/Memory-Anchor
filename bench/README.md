# bench

Measures whether MemoryAnchor helps `MA-mini-agent` complete tasks **without breaking behaviour the code
does not reveal**. The design (groups, task format, metrics, significance) is in [PROTOCOL.md](PROTOCOL.md).

## Run

```bash
(cd .. && npm run build)                         # hooks and MCP come from ../dist
node bench/src/cli.mjs validate --suite <suite>  # every task: base fails, solution intact, trap breaks an invariant
node bench/src/cli.mjs run --suite <suite> --trials 3
node bench/src/cli.mjs report bench/runs/<run-id>
```

## Agents

`--agent` picks who does the task (default `mini`):

| agent | what runs | billing | notes |
|---|---|---|---|
| `mini` | `MA-mini-agent` with `--agent-config` | the API key in that config | MA context injected in full by the agent itself |
| `claude-code` | `claude -p` (stream-json) | the Claude account signed in on this machine | `--setting-sources project,local --strict-mcp-config`: no `~/.claude/CLAUDE.md`, user hooks, plugins or MCP; `ma` gets `.mcp.json` and the workspace hooks; other groups get `CLAUDE.md` = `@AGENTS.md` |
| `codex` | `codex exec --json` | the ChatGPT account signed in on this machine; `service_tier="default"` (never priority) | memories, plugins, apps, rules, notify and every user MCP server disabled; `ma` gets the MemoryAnchor MCP server and workspace hooks |

`--agent-model` (e.g. `haiku`, `sonnet`; Codex defaults to `gpt-6.2-sol`),
`--agent-effort` (Codex reasoning effort, default `low`), `--agent-timeout-min` (default 45). Both CLIs inherit no
`ANTHROPIC_*`, `CLAUDE_CODE_*` or API-key variables, so they always use the signed-in subscription.
`ma` workspaces run `anchor init-claude` / `init-codex` and point the hooks at this repo's `dist/`
(the globally installed `memoryanchor-*` commands may be an older version). Results from different
agents are not comparable; use a separate `--run-id` per agent.

`run` options: `--tasks a,b`, `--groups off,scattered,ma` (default; add `doc` only when you need the packed-AGENTS.md upper bound), `--agent-config <file>` (default
`MA-mini-agent/config.json`), `--max-turns N`, `--run-id`, `--work-dir` (default `$TMPDIR/ma-bench`),
`--keep-workspaces`.

Per trial the harness builds a fresh workspace, gives it the group's knowledge (`off` / `scattered` / `doc` / `ma`),
runs the agent, saves `trace.jsonl`, `agent-result.json` and `diff.patch`, then restores the original
tests, adds the hidden tests and grades. Output: `bench/runs/<run-id>/{results.jsonl,report.md,trials/}`
(gitignored).

## Layout

- `src/` — harness (`suite`, `workspace`, `grade`, `report`, `cli`)
- `suites/` — task suites; see [suites/README.md](suites/README.md). Suites built from private code are gitignored.
- `runs/` — results (gitignored)
