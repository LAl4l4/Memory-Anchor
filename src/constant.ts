// =============================================================================
// Ignore Lists (build-chart / scan)
// =============================================================================

export const IGNORED_DIR_NAMES = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '.memoryanchor',
    '__pycache__'
]);

export const IGNORED_FILE_NAMES = new Set([
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    '.DS_Store'
]);

// =============================================================================
// Gitignore Entries
// =============================================================================

export const GITIGNORE_ENTRY = [
  '.memoryanchor',
  'CLAUDE.md',
  '.codex',
  'CODEBUDDY.md',
  '.codebuddy',
  '.opencode',
  'opencode.json',
  '.claude',
  '.github'
];

// =============================================================================
// Anchor Directory & File Names
// =============================================================================

export const ANCHOR_DIR_NAME = '.memoryanchor';
export const CHART_FILE_NAME = 'chart.md';
export const BALLAST_FILE_NAME = 'ballast.md';
export const MANIFEST_FILE_NAME = 'manifest.md';

// =============================================================================
// Default File Contents
// =============================================================================

export const BALLAST_DEFAULT_RULE =
`- [ ] Always check the chart.md before accessing any repositpory files. Only open files when the chart is insufficient.
- [ ] Do not change chart.md by yourself. Only do it when user explicitly instructs you to.
- [ ] Follow AGENTS.md rules.
- [ ] Do not rebuild a function that already exists and used by others, instead, pull it out to a separate file and import it`;

export const BALLAST_DEFAULT_CONTENT = `${BALLAST_DEFAULT_RULE}\n`;

export const MANIFEST_DEFAULT_CONTENT = '## Todo:\n\n## Done:\n';

export const AGENTS_CONTENT = `
## Memory Anchor Rules
- Required memory files:
  - ./.memoryanchor/chart.md
  - ./.memoryanchor/ballast.md
  - ./.memoryanchor/manifest.md
- Significant! Always read chart.md before accessing any repository files.
- Only open repository files when the chart is insufficient.
- Must follow all rules in ballast.md.
- After each turn, update TODO/DONE entries in manifest.md.

For '.memoryanchor/ballast.md':
Keep only valid rules. Delete obsolete ones.
Use one line per rule with exact format:
'- [ ] Rule content'
## Memory Anchor Ends
`;

// =============================================================================
// AGENTS.md Anchor Line (shared by Claude, Copilot, CodeBuddy)
// =============================================================================

export const AGENTS_ANCHOR_LINE = '- Follow `AGENTS.md` for Memory Anchor rules.';

// =============================================================================
// Hook Command Names
// =============================================================================

export const HOOK_COMMANDS = {
  CLAUDE_PRE: 'memoryanchor-claude-pre',
  CLAUDE_STOP: 'memoryanchor-claude-stop',
  CLAUDE_POST: 'memoryanchor-claude-post',
  COPILOT_PRE: 'memoryanchor-copilot-pre',
  COPILOT_STOP: 'memoryanchor-copilot-stop',
  COPILOT_POST: 'memoryanchor-copilot-post',
  CODEX_PRE: 'memoryanchor-codex-pre',
  CODEX_STOP: 'memoryanchor-codex-stop',
  CODEX_POST: 'memoryanchor-codex-post',
  CODEBUDDY_PRE: 'memoryanchor-codebuddy-pre',
  CODEBUDDY_STOP: 'memoryanchor-codebuddy-stop',
  CODEBUDDY_POST: 'memoryanchor-codebuddy-post',
  OPENCODE: 'memoryanchor-opencode',
} as const;

// =============================================================================
// Hook Event Names
// =============================================================================

export const HOOK_EVENT_NAMES = {
  SESSION_START: 'SessionStart',
  STOP: 'Stop',
  SESSION_END: 'SessionEnd',
} as const;

// =============================================================================
// OpenCode Constants
// =============================================================================

export const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

export const REQUIRED_INSTRUCTION_ENTRIES = [
  './AGENTS.md',
  './.memoryanchor/chart.md',
  './.memoryanchor/ballast.md',
  './.memoryanchor/manifest.md',
] as const;

// =============================================================================
// Language Constants (tree-sitter parsing)
// =============================================================================

export const LANGS = [
  "javascript",
  "typescript",
  "tsx",
  "python",
  "java",
  "c",
  "cpp",
  "go",
  "rust",
  "php",
  "ruby",
  "kotlin",
  "swift",
  "c_sharp",
  "scala",
  "dart",
  "lua",
  "html",
  "css",
  "json",
  "yaml",
] as const;

// =============================================================================
// Code Extensions (for [STALE] marking on ballast rules)
// =============================================================================

// Files/extensions that SHOULD trigger [STALE] marking on ballast rules.
// Only code files — config files, docs, and assets don't make business-logic rules obsolete.
export const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.java', '.class',
  '.go',
  '.rs',
  '.rb',
  '.php', '.phtml',
  '.swift', '.kt', '.kts',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs',
  '.scala',
  '.dart',
  '.r',
  '.zig',
]);

// Explicit blacklist: these files should never trigger [STALE] even if matched by
// other heuristics.
export const STALE_BLACKLIST = new Set([
  'AGENTS.md',
  'README.md',
]);
