# Memory Anchor Project Specification

## Purpose

Memory Anchor is a local, file-based memory layer for coding agents. It generates compact architecture charts from a repository, supplies durable project rules and decisions, and refreshes the generated memory after source changes.

## Primary capabilities

- Build threshold-partitioned `chart.md` files from repository source.
- Extract architecture symbols with Tree-sitter and a reusable worker-thread parser pool.
- Generate repository-wide file dependency and chart-local symbol reverse-call relationships.
- Route agents through `.memoryanchor/index.md`, with shared rules in `AGENTS.md` and durable state in `ballast.md` and `manifest.md`.
- Configure the shared workflow for Copilot, Claude Code, Codex CLI, CodeBuddy, OpenCode, and QoderCLI CN.
- Incrementally refresh the owning chart after Git-detected changes, rebuilding chart topology only when directory-size boundaries change.

## Chart format

Charts have a directory skeleton followed by architecture symbols. Relationship notation is defined once in the managed `AGENTS.md` block:

- `->` means the file references the listed parseable repository files.
- `<-` means the listed in-chart symbols depend on or call the current symbol; it is never attached to a file heading.
- `+` marks an exported symbol; `-` marks a default/internal symbol. Languages without explicit exports, such as C, use `-`.
- Function rows omit `function` and `export`; explicit category labels remain for interfaces, classes, enums, and types.
- Every symbol includes its `[Lstart-end]` source range. Exported functions retain only explicit parameter/return type annotations; internal functions omit signatures. Source comments are intentionally omitted.
- A missing arrow means no relationship is represented.

Example:

```md
### /buildChart.ts -> parse/ASTParser.ts; parse/runParse.ts; reverse/runReverseDependency.ts; partition/runPartitioner.ts; render/runRender.ts
+ buildChartFull() [L52-67] <- initPublic.ts
### /incremental.ts -> buildChart.ts; partition/incrementalPartitioner.ts; shared/utils.ts
+ updatePartitionedChartIncrementally() [L10-21] <- stopPublic.ts; sessionEndPublic.ts
```

## Dependency graph scope and precision

Tree-sitter supplies import declarations and call sites. Forward and reverse relationships deliberately use different scopes because they answer different questions.

### Forward dependencies: repository-wide file navigation

Every parseable repository file is eligible as a `->` target, regardless of the chart that contains the importing file. Tree-sitter can collect these imports while parsing the repository, so cross-chart forward edges provide useful, low-cost navigation of module coupling. Package and otherwise unresolved imports remain omitted because they do not resolve to a repository file.

### Reverse dependencies: chart-local symbol impact

`<-` is resolved only among symbols in the current chart and is attached to the specific referenced symbol, never to a file heading. This preserves the information agents need for safe edits: changing `ensurePublicFile()` identifies its actual callers, rather than implying that every declaration in `initPublic.ts` affects every importing file.

File-level reverse edges are intentionally excluded. A heading such as `### /initHelper/initPublic.ts <- initClaude.ts; initCodebuddy.ts; ...` is noisy and imprecise: it cannot identify the referenced declaration or call site, and would cause unnecessary investigation whenever an unrelated symbol in that file changes. Keeping reverse lookup chart-local also bounds the work and output size during incremental chart refreshes.

A missing `->` means no parseable repository target was resolved. A missing `<-` means no caller was resolved for that symbol within the chart; it does not rule out callers in other charts.

## Operational constraints

- Full builds share one build-scoped parse cache and destroy the parser pool afterward.
- Incremental chart updates reparse the affected chart's full scan set so reverse dependency annotations remain current.
- The worker pool is demand-lazy, bounded by available CPUs, and each worker reuses its parser and loaded languages.
- Generated charts are output artifacts; `ballast.md` and `manifest.md` capture persistent project knowledge.
