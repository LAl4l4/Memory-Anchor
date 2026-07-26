# CopilotWolf Copilot Instructions

## Build and run
- `npm install`
- `npm run build` (emits `dist/` via `tsc -p tsconfig.build.json`)
- `npm start` (runs `node dist/cli.js`)

## High-level architecture
- **CLI entrypoint**: `src/cli.ts` (shebang) calls `runCli` from `src/index.ts`, which wires the CAC CLI and registers built-in commands.
- **Core runtime**: `src/index.ts` builds the CAC instance, registers commands, and handles the default/help behavior.
- **Commands**: `src/commands/*` register CAC commands. `src/commands/index.ts` wires them together.
- **Init behavior**: `init` creates `.memory_anchor/{chart,ballast,manifest}.md` and `.github/hooks/memory-anchor.json`.
- **Config/logging**: `src/core/config.ts` provides default `.copilotwolf` paths; `src/utils/logger.ts` is the console logger.

## Key conventions
- Implement new commands by registering with CAC in `src/commands/*`, then wire them in `src/commands/index.ts`.
- Use `context.logger` for output and `context.config` for paths.
- Use Node ESM imports and `node:`-prefixed built-in modules (e.g., `node:fs/promises`).
- The CLI binary points to `dist/cli`; keep built output in sync when changing `src/`.
- The `init` command writes `AGENTS.md` into target projects and links it from their `.github/copilot-instructions.md`.

- Follow `AGENTS.md` for Memory Anchor rules.
