# Memory Anchor

**Memory Anchor is a local, file-based memory layer for coding agents.** It builds a compact map of your repository, preserves the rules and decisions that matter, and keeps that context current across sessions.

![Node.js 18 or newer](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

Instead of forcing an agent to rediscover the codebase at the start of every session, Memory Anchor gives it a compact, structured head start: an AST-based project map, durable repository knowledge, and an up-to-date module-status record. Git-aware hooks refresh this memory as the repository evolves.

## Quick start

```bash
npm install -g memory-anchor

cd /path/to/your-project
anchor init
anchor status
```

`anchor init` initializes the shared Memory Anchor files and configures every currently supported agent integration. To set up only one integration, use an `init-<agent>` command instead.

## Why Memory Anchor?

Coding agents work best when they can start with the right context rather than an unbounded pile of files. Memory Anchor is designed to make that context durable and easy to inspect:

- **Faster orientation** — `chart.md` provides a directory map and extracted architectural symbols, so an agent can locate the relevant code before opening files.
- **Persistent guardrails** — `ballast.md` keeps repository-specific rules and lessons learned close to the work.
- **Shared project state** — `manifest.md` records module status, known issues, and architectural decisions across sessions.
- **Incremental maintenance** — lifecycle hooks inspect Git changes and reparse only affected files after the initial build.
- **Local and reviewable** — the memory is plain Markdown in your workspace, not a hosted vector database or an opaque chat-history store.

## How it works

1. `anchor init` creates the memory files, writes the project chart, and registers hooks for the selected agent.
2. At the start of a session, the agent receives `chart.md`, `ballast.md`, and `manifest.md` together as one context payload. `AGENTS.md` tells it to reread the chart only when the overall project structure is unclear.
3. While the agent works, the chart acts as a compact navigation layer: directory structure first, then exported functions, classes, interfaces, enums, and types.
4. When work stops or a session ends, Memory Anchor reads the Git diff and incrementally refreshes the chart for changed files. Session-end processing also normalizes ballast rules and flags rules that may have become stale after source-code changes.

The initial chart build uses a lazy worker-thread pool. Each worker reuses its tree-sitter parser and loaded language, making large-workspace initialization substantially faster while allowing the pool to be torn down cleanly afterward.

## Session lifecycle

```text
anchor init
    │  create memory files + full AST chart + agent hook configuration
    ▼
Session starts
    │  inject chart + durable rules + current project state together
    ▼
Agent works
    │  rereads chart when structure is unclear, then opens only needed files
    ▼
Agent stops
    │  Git diff → incrementally refresh chart entries for changed files
    ▼
Session ends
       normalize ballast, flag potentially stale rules, refresh chart, release workers
```

![Memory Anchor initialization and incremental refresh demo](assets/memoryanchorDemo.gif)

## Memory layers

| File | Purpose | Ownership |
| --- | --- | --- |
| `.memoryanchor/chart.md` | Auto-generated project chart: directory skeleton plus extracted architectural symbols. | Generated; do not edit manually. |
| `.memoryanchor/ballast.md` | Durable coding rules and lessons learned. It keeps separate default and repository-specific sections. | Maintained during development; keep valid, one-line rules. |
| `.memoryanchor/manifest.md` | Module status, dependencies, known issues, and key architectural decisions. | Update when features or significant decisions change project state. |
| `AGENTS.md` | Instructions that tell agents how to use the three memory files. | Shared project guidance. |

## Supported agents

| Agent | Setup command | Integration written by Memory Anchor |
| --- | --- | --- |
| GitHub Copilot | `anchor init-copilot` | `.github/hooks/memory-anchor.json` and `.github/copilot-instructions.md` |
| Claude Code | `anchor init-claude` | `.claude/settings.json` and `CLAUDE.md` |
| Codex CLI | `anchor init-codex` | `.codex/hooks.json` |
| CodeBuddy | `anchor init-codebuddy` | `.codebuddy/settings.json` and `CODEBUDDY.md` |
| OpenCode | `anchor init-opencode` | `.opencode/plugins/memory-anchor.js` and `opencode.json` |
| QoderCLI CN | `anchor init-qodercn` | `.qoder/settings.json` |

For OpenCode, the generated plugin injects chart, ballast, and manifest content together through `experimental.chat.system.transform`; its idle and deleted session events run the incremental refresh and session-end tasks.

## Installation

### Requirements

- Node.js 18 or newer
- Git, for incremental updates based on repository changes

### Global installation

```bash
npm install -g memory-anchor
```

Run the command from the root of the repository you want to anchor:

```bash
anchor init
```

The command is safe to run again: it adds missing Memory Anchor entries and does not duplicate an existing matching hook. It also updates `.gitignore` with Memory Anchor and agent-configuration paths, so review the resulting diff if those files are normally versioned in your project.

## Commands

| Command | Description |
| --- | --- |
| `anchor init` | Set up shared files and all supported agent integrations. |
| `anchor init-public` | Set up only `.memoryanchor`, `AGENTS.md`, and `.gitignore`. |
| `anchor init-copilot` | Set up shared files and GitHub Copilot hooks/instructions. |
| `anchor init-claude` | Set up shared files and Claude Code hooks/instructions. |
| `anchor init-codex` | Set up shared files and Codex CLI hooks. |
| `anchor init-codebuddy` | Set up shared files and CodeBuddy hooks/instructions. |
| `anchor init-opencode` | Set up shared files and the OpenCode plugin/configuration. |
| `anchor init-qodercn` | Set up shared files and QoderCLI CN hooks. |
| `anchor status` | Show the version, working directory, configured data paths, and existence of the three anchor files. |
| `anchor version` | Print the installed Memory Anchor version. |
| `anchor help` | Show CLI help. |

## Example output

After initialization, the three files are deliberately small, readable Markdown documents. The following abbreviated examples show their shape rather than copying a complete workspace.

`.memoryanchor/chart.md`

```text
# PROJECT CHART

## 1. Directory Skeleton
- /package.json: Project manifest and CLI scripts.
- /README.md: Local documentation asset.

### src/
- cli.ts: CLI entry point.
- commands/: Command registration and initialization.
- chartBuild/: Chart generation and incremental updates.
- hooks/: Agent lifecycle hook handlers.

## 2. Key Architecture Nodes
### /src/commands/init.ts
- export function initCommand()

### /src/chartBuild/build-chart.ts
- export async function buildChartFull()
- export async function updateChartIncrementally()
```

`.memoryanchor/ballast.md`

```text
# Default Ballast Rules(You must not change these part)
- [ ] If the overall project structure is unclear, immediately reread ./.memoryanchor/chart.md.
- [ ] Do not change the auto-generated chart unless the user explicitly asks.
- [ ] After implementing a feature, update Module Status in manifest.md.

# Specific Rules For This Repository(Change this after solve bugs or user add specific rules)
- [ ] Keep parser-worker lifecycle changes covered by automated tests.
- [ ] Preserve the default/specific two-section ballast structure when normalizing rules.
```

`.memoryanchor/manifest.md`

```text
## Module Status

### parser
- functionality: Extracts architecture symbols from supported source files.
- status: Stable
- dependencies: parserPool.ts, parserWorker.ts, symbolExtractor.ts
- known_issues: None
- notes: Full builds parse in parallel; incremental updates reuse the pool.

### session end hook
- functionality: Refreshes memory from Git-detected changes.
- status: Stable
- dependencies: captureGitChanges.ts, build-chart.ts
- known_issues: None

## Key Decisions
- Use a worker-thread pool so parser and language instances can be reused.
- Use incremental chart updates at session end instead of a full rebuild.
```

## How it differs

Memory Anchor is not a chat transcript, a general documentation generator, or a remote RAG service.

| Approach | Primary artifact | Memory Anchor difference |
| --- | --- | --- |
| Chat history | Conversation messages | Stores project facts in files that outlive any individual conversation. |
| Full-repository rescanning | Raw source files | Starts with an AST-derived chart and opens source only when necessary. |
| Vector/RAG system | Hosted embeddings and retrieval | Uses local Markdown and Git-aware incremental updates; no embedding pipeline is required. |
| Static architecture docs | Manually maintained prose | Regenerates the structural chart and keeps operational rules/state beside it. |

## Limitations

- `chart.md` is generated output. Do not manually edit it; rerun `anchor init` if a full rebuild is needed.
- Incremental updates depend on Git-detected changes. Files changed outside the repository’s visible Git state may require a full initialization rebuild.
- The chart focuses on architecture-level symbols, not a complete semantic understanding of every implementation detail.
- Parsing support depends on the bundled tree-sitter WASM grammars. The current language set includes JavaScript, TypeScript/TSX, Python, Java, C/C++, Go, Rust, PHP, Ruby, Kotlin, Swift, C#, Scala, Dart, Lua, HTML, CSS, JSON, and YAML.
- Agent hook formats are platform-specific. Keep the generated integration files in place for automatic lifecycle refreshes.

## Roadmap

- [ ] Add an end-to-end demo GIF for initialization and incremental refresh.
- [ ] Publish benchmark results for full and incremental chart builds on representative large repositories.
- [ ] Extend parser coverage as additional tree-sitter WASM grammars become available.
- [ ] Improve generated chart detail while retaining a compact, agent-friendly format.

## Documentation

- Run `anchor help` for the installed command reference.
- Read the generated `AGENTS.md` for the workflow agents follow in an anchored repository.
- The session-start hook injects `.memoryanchor/chart.md`, `.memoryanchor/ballast.md`, and `.memoryanchor/manifest.md` together. Reread the chart when the overall structure becomes unclear.
- See [CHANGELOG.md](CHANGELOG.md) for project update notes.

## Contributing

```bash
npm install
npm test
```

Please keep changes focused, add or update tests for behavior changes, and preserve the generated-memory workflow: update module status after implementing a feature and record significant architectural decisions in the manifest.

## License

Apache-2.0. See [LICENSE](LICENSE).
