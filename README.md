# Memory Anchor

Memory Anchor is a Copilot CLI scaffold that saves tokens and improves long-term memory and cold-start time.

The workflow revolves around a small set of files in `./.memoryanchor/`: a chart of the repository structure and exports, a ballast file for constraints and rules, and a manifest that captures ongoing and completed work. Pre-session hooks read these files to build the context payload; post-session hooks update the manifest/ballast and incrementally refresh the chart based on git changes.

For AI behavior rules (what to read first and what to update at the end), see the `AGENTS.md` file created by `anchor init`.

## Requirements
- Node.js >= 18

## Getting Started
```bash
npm install -g memory-anchor
anchor init
```

## CLI Commands
### `anchor init`
Initializes a workspace by creating:
- `./.memoryanchor/chart.md` (project map: directory skeleton + export signatures)
- `./.memoryanchor/ballast.md` (lessons learned / constraints)
- `./.memoryanchor/manifest.md` (cross-session TODO/DONE board)
- `./AGENTS.md` (AI behavior rules and memory workflow)
- `./.github/hooks/memory-anchor.json` (hook entry for pre/post session)
- `./.github/copilot-instructions.md` (points Copilot to AGENTS.md)

## Hooks
The init command registers hooks in `./.github/hooks/memory-anchor.json`:
- **sessionStart**: runs `.memoryanchor/dist/pre-session.js`
- **sessionEnd**: runs `.memoryanchor/dist/post-session.js`

These hooks are expected to read/write the Memory Anchor files above. The build-chart logic generates the project chart, and the post-session hook updates the manifest/ballast and performs incremental chart updates based on git changes.

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
