# PROJECT CHART

## 1. Directory Skeleton
- /AGENTS.md: Local documentation asset.
- /LICENSE: Source code module.
- /Makefile: Source code module.
- /README.md: Local documentation asset.
- /package.json: Project manifest, dependency definitions, and entry scripts.
- /src/cli.ts: Source code module.
- /src/commands/index.ts: Main entry gate and routing aggregator for this directory.
- /src/commands/init.ts: Source code module.
- /src/commands/status.ts: Source code module.
- /src/core/build-chart.ts: Source code module.
- /src/core/config.ts: Source code module.
- /src/core/context.ts: Source code module.
- /src/core/parser-loader.ts: Source code module.
- /src/hooks/post-session.ts: Source code module.
- /src/hooks/pre-session.ts: Source code module.
- /src/hooks/types.ts: Source code module.
- /src/index.ts: Main entry gate and routing aggregator for this directory.
- /src/types.ts: Source code module.
- /src/utils/ext-to-lang.ts: Source code module.
- /src/utils/logger.ts: Source code module.
- /src/utils/wasmbuilder.ts: Source code module.
- /tests/init-ballast.test.js: Automated test suites and verification scripts.
- /tests/init-chart.test.js: Automated test suites and verification scripts.
- /tests/init-manifest.test.js: Automated test suites and verification scripts.
- /tests/test-src/Sample.java: Automated test suites and verification scripts.
- /tests/test-src/sample.c: Automated test suites and verification scripts.
- /tests/test-src/sample.js: Automated test suites and verification scripts.
- /tests/test-src/sample.py: Automated test suites and verification scripts.
- /tests/test-src/sample.ts: Automated test suites and verification scripts.
- /tree-sitter-parser/tree-sitter-c.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-cpp.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-css.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-go.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-html.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-java.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-javascript.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-json.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-python.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-ruby.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-rust.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-scala.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-swift.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-tsx.wasm: Source code module.
- /tree-sitter-parser/tree-sitter-typescript.wasm: Source code module.
- /tsconfig.build.json: Source code module.
- /tsconfig.json: TypeScript compiler options and workspace path mappings.

## 2. Key Architecture Nodes
### /src/commands/index.ts
- export function registerBuiltInCommands()

### /src/commands/init.ts
- interface HookCommand
- interface HooksConfig
- interface WorkspacePaths
- export function initCommand()
- function getWorkspacePaths()
- function ensureWorkspaceDirectories()
- function ensureAnchorFiles()
- function ensureAgentsFile()
- function ensureCopilotInstructions()
- function ensureGitignore()
- function ensureHookConfig()
- function registerHooks()
- function ensureHookEntry()
- function isSameHook()
- function fileExists()
- function readJsonFile()
- function writeJsonFile()
- function ensureFile()
- function ensureFileWithAppend()
- function fileContainsLine()
- function fileContains()

### /src/commands/status.ts
- export function statusCommand()

### /src/core/build-chart.ts
- export function ensureParserInit()
- interface WorkspacePaths
- function resolveWorkspacePaths()
- interface FileExport
- interface FileNode
- function logToUser()
- export function parseFileArchitecture()
- function extractExports()
- function getExportInfo()
- function formatExport()
- function getNodeName()
- function findIdentifier()
- function generateTreeSkeleton()
- function listProjectFiles()
- function buildSkeletonSection()
- function buildNodesSection()
- function buildChartContent()
- function ensureAnchorDirExists()
- function writeChart()
- export function updateChartIncrementally()
- export function buildChartFull()

### /src/core/config.ts
- export interface AppConfig
- export function createDefaultConfig()

### /src/core/context.ts
- export interface CommandContext

### /src/core/parser-loader.ts
- export function loadLanguage()

### /src/hooks/post-session.ts
- function logToUser()
- function captureGitChanges()
- function updateManifest()
- function cleanBallastRules()
- function sanitizeBallast()
- function refreshChart()
- function main()

### /src/hooks/pre-session.ts
- function loadMemory()
- function main()

### /src/hooks/types.ts
- export interface SessionStartResponse
- export interface GitChange

### /src/index.ts
- export function runCli()

### /src/utils/logger.ts
- export interface Logger
- function info()
- function warn()
- function error()

### /tests/init-ballast.test.js
- function runInit()

### /tests/init-chart.test.js
- function escapeRegExp()
- function getNodeBlock()
- function cleanupAnchor()
- function seedFixtures()

### /tests/init-manifest.test.js
- function runInit()

### /tests/test-src/Sample.java
- class Sample
- function add()

### /tests/test-src/sample.c
- function add()
- function main()

### /tests/test-src/sample.js
- export function add()

### /tests/test-src/sample.py
- function greet()
- class Greeter
- function __init__()

### /tests/test-src/sample.ts
- export function add()


### /.memoryanchor/chart.md

### /src/utils/sample.ts
- export function buildGreeting()

### /.memoryanchor/registry.json

