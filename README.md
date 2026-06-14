# Memory Anchor

**Memory Anchor** is a lightweight, local context scaffolding tool engineered for the AI-Agent (GitHub Copilot, Claude Code, Cline, etc.). 

By maintaining a compact set of incremental metadata anchors directly within your repository, Memory Anchor drastically slashes LLM token consumption, eliminates context drift (the "Lost in the Middle" problem), and cuts down cold-start latencies in long-lived agent sessions.

### 🔥 Key Features
- 🪙 **Token Optimization**: Prevents AI agents from mindlessly rescanning your entire codebase. It feeds them precise, compact code signatures instead.
- 🧠 **Long-Term Memory (Ballast)**: Two-section rule system — default rules are auto-managed and refreshed on every init, while repository-specific rules (constraints, architectural decisions, "lessons learned") are preserved across sessions so your AI never repeats the same mistakes.
- 📅 **State Synchronization (Manifest)**: Module status tracker and key decisions log that helps AI agents understand what state each module is in and what critical design choices have been made.
- 🔄 **Automated Lifecycle Hooks**: Seamless pre/post-session integration. Automatically injects compact payloads on session start, and incrementally refreshes the codebase chart based on Git diffs upon session end.

---

## 🧭 How It Works

Memory Anchor operates via lightweight lifecycle hooks that orchestrate a tight loop between your source code, Git state, and the AI's system instructions:

### [ 1. Start Session ]
↓ Trigger: sessionStart Hook
Aggregate Ballast + Manifest
Automatically scans and consolidates the core architecture benchmarks and file index lists.
↓
Inject Compact Payload
Injects the highly compressed, noise-free context payload directly into the AI's system instructions.

### [ 2. AI Coding Session ]
↓ Interactive Development
Context-Aware Coding
The AI collaborates and modifies source code with a precise, global understanding of your workspace.

### [ 3. agent stop ]
Trigger: agentStop Hook
Incremental Git Diff Analysis
Automatically analyzes Git states to pinpoint only the files changed, added, or deleted during the session.
Sync & Update
Runs heavy AST parsing exclusively on those changed files, instantly updating the registry.json cache and chart.md blueprint.

### [ 3. End Session ]
↓ Trigger: sessionEnd Hook
Update ballast, manifest. Do full update for chart.md to ensure the correctness.

## Requirements
- Node.js >= 18

## Getting Started
```bash
npm install -g memory-anchor
anchor init
```

## Extra Commands
```bash
anchor init-copilot 
anchor init-claude
anchor init-codex
anchor init-opencode
anchor init-public
```
Used to initialize a specific agent.

## CLI Commands
### `anchor init`
Initializes a workspace by creating:
- `./.memoryanchor/chart.md` (project map: directory-grouped skeleton + export signatures)
- `./.memoryanchor/ballast.md` (two-section rules: default system rules + repo-specific rules)
- `./.memoryanchor/manifest.md` (module status tracker + key decisions log)
- `./AGENTS.md` (AI behavior rules and memory workflow)

### `anchor init-opencode`
OpenCode-only setup. Creates:
- `./.opencode/plugins/memory-anchor.js` — a plugin that subscribes to `session.idle` / `session.deleted` / `tool.execute.after` and invokes the `memoryanchor-opencode-{pre,stop,post}` hooks.
- `./opencode.json` — adds `AGENTS.md` + the three anchor files to the `instructions` array so the LLM sees them on every turn. Existing keys (`model`, `provider`, `mcp`, …) are preserved.

## Hooks
The init command registers hooks in `./.github/hooks/memory-anchor.json`:
- **sessionStart**: runs `.memoryanchor/dist/hooks/public/sessionStartPublic.js`
- **agentStop**: runs `.memoryanchor/dist/hooks/public/stopPublic.js`
- **sessionEnd**: runs `.memoryanchor/dist/sessionEndPublic.js`

These hooks are expected to read/write the Memory Anchor files above. The build-chart logic generates the project chart, and the post-session hook updates the manifest/ballast and refreshes the chart every session (incremental when git changes exist).

Hook effects and purpose:
1. **sessionStart**: loads chart/ballast/manifest to inject a compact context payload and reduce token spend on re-reading the repo.
2. **sessionEnd**: records changes into manifest/ballast and refreshes chart slices to preserve long-term memory and cut cold-start time next session.

## Project Layout
- `src/cli.ts`: CLI entrypoint (shebang)
- `src/index.ts`: CAC wiring and command registration
- `src/commands/`: CLI commands
- `src/core/`: chart building and configuration
- `src/hooks/`: pre-session / post-session hooks
- `src/utils/`: shared utilities

## Development
```bash
npm run build
npm start
```
