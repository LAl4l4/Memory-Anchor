# PROJECT CHART

## 1. Directory Skeleton
- /AGENTS.md: Local documentation asset.
- /CLAUDE.md: Local documentation asset.
- /CODEBUDDY.md: Local documentation asset.
- /LICENSE: Source code module.
- /Makefile: Source code module.
- /README.md: Local documentation asset.
- /opencode.json: Source code module.
- /package.json: Project manifest, dependency definitions, and entry scripts.
- /src/cli.ts: Source code module.
- /src/commands/index.ts: Main entry gate and routing aggregator for this directory.
- /src/commands/init.ts: Source code module.
- /src/commands/initHelper/initClaude.ts: Source code module.
- /src/commands/initHelper/initCodebuddy.ts: Source code module.
- /src/commands/initHelper/initCodex.ts: Source code module.
- /src/commands/initHelper/initCopilot.ts: Source code module.
- /src/commands/initHelper/initOpencode.ts: Source code module.
- /src/commands/initHelper/initPublic.ts: Source code module.
- /src/commands/status.ts: Source code module.
- /src/commands/version.ts: Source code module.
- /src/core/build-chart.ts: Source code module.
- /src/core/config.ts: Source code module.
- /src/core/context.ts: Source code module.
- /src/core/parser-loader.ts: Source code module.
- /src/hooks/claude/session-end.ts: Source code module.
- /src/hooks/claude/session-start.ts: Source code module.
- /src/hooks/claude/stop.ts: Source code module.
- /src/hooks/codebuddy/session-end.ts: Source code module.
- /src/hooks/codebuddy/session-start.ts: Source code module.
- /src/hooks/codebuddy/stop.ts: Source code module.
- /src/hooks/codex/session-end.ts: Source code module.
- /src/hooks/codex/session-start.ts: Source code module.
- /src/hooks/codex/stop.ts: Source code module.
- /src/hooks/copilot/agent-stop.ts: Source code module.
- /src/hooks/copilot/post-session.ts: Source code module.
- /src/hooks/copilot/pre-session.ts: Source code module.
- /src/hooks/opencode/session-end.ts: Source code module.
- /src/hooks/opencode/session-start.ts: Source code module.
- /src/hooks/opencode/stop.ts: Source code module.
- /src/hooks/public/sessionEndPublic.ts: Source code module.
- /src/hooks/public/sessionStartPublic.ts: Source code module.
- /src/hooks/public/stopPublic.ts: Source code module.
- /src/index.ts: Main entry gate and routing aggregator for this directory.
- /src/types.ts: Source code module.
- /src/utils/captureGitChanges.ts: Source code module.
- /src/utils/ext-to-lang.ts: Source code module.
- /src/utils/logger.ts: Source code module.
- /src/utils/wasmbuilder.ts: Source code module.
- /tests/init-ballast.test.js: Automated test suites and verification scripts.
- /tests/init-chart.test.js: Automated test suites and verification scripts.
- /tests/init-claude.test.js: Automated test suites and verification scripts.
- /tests/init-codebuddy.test.js: Automated test suites and verification scripts.
- /tests/init-codex.test.js: Automated test suites and verification scripts.
- /tests/init-copilot.test.js: Automated test suites and verification scripts.
- /tests/init-manifest.test.js: Automated test suites and verification scripts.
- /tests/init-opencode.test.js: Automated test suites and verification scripts.
- /tests/init-public.test.js: Automated test suites and verification scripts.
- /tests/status.test.js: Automated test suites and verification scripts.
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
- export function initCommand()

### /src/commands/initHelper/initClaude.ts
- interface ClaudeHookCommand
- interface ClaudeHookEntry
- interface ClaudeHooksConfig
- interface ClaudePaths
- export interface ClaudeSetupResult
- function getClaudePaths()
- function ensureClaudeSettings()
- function registerClaudeHooks()
- function ensureClaudeHookEntry()
- function ensureClaudeMd()
- export function claudeSetup()
- export function initClaudeCommand()

### /src/commands/initHelper/initCodebuddy.ts
- interface CodebuddyHookCommand
- interface CodebuddyHookEntry
- interface CodebuddyHooksConfig
- interface CodebuddyPaths
- export interface CodebuddySetupResult
- function getCodebuddyPaths()
- function ensureCodebuddySettings()
- function registerCodebuddyHooks()
- function ensureCodebuddyHookEntry()
- function ensureCodebuddyMd()
- export function codebuddySetup()
- export function initCodebuddyCommand()

### /src/commands/initHelper/initCodex.ts
- interface CodexHookCommand
- interface CodexHookEntry
- interface CodexHooksConfig
- interface CodexPaths
- export interface CodexSetupResult
- function getCodexPaths()
- function ensureCodexHooks()
- function registerCodexHooks()
- function ensureCodexHookEntry()
- export function codexSetup()
- export function initCodexCommand()

### /src/commands/initHelper/initCopilot.ts
- interface CopilotHooksConfig
- interface CopilotPaths
- export interface CopilotSetupResult
- function getCopilotPaths()
- function ensureHookConfig()
- function registerHooks()
- function ensureHookEntry()
- function isSameHook()
- function ensureCopilotInstructions()
- export function copilotSetup()
- export function initCopilotCommand()

### /src/commands/initHelper/initOpencode.ts
- interface OpencodeConfig
- interface OpencodePaths
- export interface OpencodeSetupResult
- function getOpencodePaths()
- function ensurePluginFile()
- function ensureOpencodeConfig()
- function mergeOpencodeConfig()
- export function opencodeSetup()
- export function initOpencodeCommand()

### /src/commands/initHelper/initPublic.ts
- export interface HookCommand
- export function fileExists()
- export function readJsonFile()
- export function writeJsonFile()
- export function ensureFile()
- export function ensureFileWithAppend()
- export function fileContainsLine()
- export function fileContains()
- export function ensureGitignore()
- export function ensureAnchorFiles()
- export function ensureAgentsFile()
- export function ensureWorkspaceDirectories()
- export interface BasePaths
- export function getBasePaths()
- export interface InitPublicResult
- export function initPublic()

### /src/commands/status.ts
- function fileExists()
- export function statusCommand()

### /src/commands/version.ts
- export function getVersion()
- export function versionCommand()

### /src/core/build-chart.ts
- export function ensureParserInit()
- interface WorkspacePaths
- function resolveWorkspacePaths()
- interface FileSymbol
- interface FileNode
- function logToUser()
- export function parseFileArchitecture()
- function extractSymbols()
- function getExportInfo()
- function formatSymbol()
- function getNodeName()
- function findIdentifier()
- function generateTreeSkeleton()
- function isIgnored()
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

### /src/hooks/copilot/pre-session.ts
- interface SessionStartResponse

### /src/hooks/public/sessionEndPublic.ts
- function logToUser()
- export function updateManifest()
- export function cleanBallastRules()
- export function sanitizeBallast()
- export function runSessionEnd()

### /src/hooks/public/sessionStartPublic.ts
- export function loadMemoryCore()

### /src/hooks/public/stopPublic.ts
- function refreshChart()
- export function runStop()

### /src/index.ts
- export function runCli()

### /src/utils/captureGitChanges.ts
- interface GitChange
- function captureGitChanges()

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
### /tests/init-claude.test.js
- function runInitClaude()

### /tests/init-codebuddy.test.js
- function runInitCodebuddy()

### /tests/init-codex.test.js
- function runInitCodex()

### /tests/init-copilot.test.js
- function runInitCopilot()

### /tests/init-manifest.test.js
- function runInit()

### /tests/init-opencode.test.js
- function runInitOpencode()

### /tests/init-public.test.js
- function runInitPublic()

### /tests/status.test.js
- function runStatus()

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

