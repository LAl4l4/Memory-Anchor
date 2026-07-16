# Memory Anchor

**Memory Anchor** is a lightweight, local context scaffolding tool engineered for the AI-Agent (GitHub Copilot, Claude Code, Cline, etc.). 

By maintaining a compact set of incremental metadata anchors directly within your repository, Memory Anchor drastically slashes LLM token consumption, eliminates context drift (the "Lost in the Middle" problem), and cuts down cold-start latencies in long-lived agent sessions.

## 🔥 Key Features
- 🪙 **Token Optimization**: Prevents AI agents from mindlessly rescanning your entire codebase. It feeds them precise, compact code signatures instead.
- 🧠 **Long-Term Memory (Ballast)**: Two-section rule system — default rules are auto-managed and refreshed on every init, while repository-specific rules (constraints, architectural decisions, "lessons learned") are preserved across sessions so your AI never repeats the same mistakes.
- 📅 **State Synchronization (Manifest)**: Module status tracker and key decisions log that helps AI agents understand what state each module is in and what critical design choices have been made.
- 🔄 **Automated Lifecycle Hooks**: Seamless pre/post-session integration. Automatically injects compact payloads on session start, and incrementally refreshes the codebase chart based on Git diffs upon session end.

---
## Optimization
Implement threadPool and language load cache to reuse the parser and loaded language, 
make it sharply faster when appling initialization on large workspace.

threadPool is lazy create, it will automatically creating when necessary, but it should exit


WorkerPool will exist when you use the cli, to catch the file change after every change, 
it will destroy when you exit the cli, ensuring highest reuse amount.

Initialization will destroy the pool after it finished.


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
Will initialize mamory-anchor for all supported cli.

## Extra Commands
```bash
anchor init-copilot 
anchor init-claude
anchor init-codex
anchor init-opencode
anchor init-codebuddy
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

### `anchor init-{your cli name}`
Specific cli only setup. Creates:
- cli only depending files.

## Hooks
The init command registers following hooks:
- **sessionStart**: runs `.memoryanchor/dist/hooks/public/sessionStartPublic.js`
- **agentStop**: runs `.memoryanchor/dist/hooks/public/stopPublic.js`
- **sessionEnd**: runs `.memoryanchor/dist/sessionEndPublic.js`

These hooks are expected to read/write the Memory Anchor files above. The build-chart logic generates the project chart, and the post-session hook updates the manifest/ballast and refreshes the chart every session (incremental when git changes exist).

Hook effects and purpose:
1. **sessionStart**: loads chart/ballast/manifest to inject a compact context payload and reduce token spend on re-reading the repo.
2. **sessionEnd**: records changes into manifest/ballast and refreshes chart slices to preserve long-term memory and cut cold-start time next session. Now use increment update with threading pool.

## Project Layout
- `src/cli.ts`: CLI entrypoint (shebang)
- `src/index.ts`: CAC wiring and command registration
- `src/commands/`: CLI commands
- `src/core/`: chart building and configuration
- `src/hooks/`: pre-session / post-session hooks
- `src/utils/`: shared utilities

## Current work
Implement multi-thread in chart-building, use threading pool.

## Update log
- `2026/07/08`: [Known Limitation] Manual edits/deletions in chart.md are not resolved by incremental updating, because it relies on registry mtime which doesn't change. This is by design - chart.md is auto-generated and should never be edited manually. Will not occur in normal use.

- `2026/07/14`: Opencode's plugin does not injecting ballast.md and manifest.md successfully, add this
resolving to Todo. Change sample decision in manifest.md to make models remember to keep /n/n after each decision.

- `2026/07/15`: Solve opencode's plugin by substitute session.created to experimental.chat.system.transform
solve the bug that init will not cover old opencode plugin js file.

- `2026/07/16`: Find copilot's test will occasionally failed by overtime. It's might because threadpool
do not have failed worker recreate mechanism. Need further explore. From afternoon, solved this bug, now
threadpool can reinit the worker. And remove some duplicated redundent autotests. Then, right now, if the function is called with empty input, threadpool will not create.
