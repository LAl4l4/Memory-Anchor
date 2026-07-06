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
  '.github',
  '.qoder'
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

export const BALLAST_DEFAULT_RULES: string[] = [  
  '- [ ] Always check the ./.memoryanchor/chart.md before accessing any repositpory files. Only open files when the chart is insufficient.',
  '- [ ] Do not change ./.memoryanchor/chart.md by yourself. Only do it when user explicitly instructs you to.',
  '- [ ] Follow ./.memoryanchor/AGENTS.md rules.',
  '- [ ] Do not rebuild a function that already exists and used by others, instead, pull it out to a separate file and import it',
  '- [ ] After implementing a feature, update the Module Status in ./.memoryanchor/manifest.md. If it is a significant architectural change, also update Key Decisions.',
];

export const BALLAST_DEFAULT_TITLE = '# Default Ballast Rules(You must not change these part)';

export const BALLAST_SPECIFIC_TITLE = '# Specific Rules For This Repository(Change this after solve bugs or user add specific rules)';

export const BALLAST_DEFAULT_RULE = BALLAST_DEFAULT_RULES.join('\n');

export const BALLAST_DEFAULT_CONTENT = `${BALLAST_DEFAULT_RULE}\n`;

export const MANIFEST_DEFAULT_CONTENT = `
## Module Status

### sample-module-1(e.g. initialization): 
- functionality: The explanation of this module.
- status: Planned/In progress/Stable/Deprecated etc.
- dependencies: dependented modules(e.g. sample.ts)
- known_issues: Any known issues or limitations with this module.
- notes: Any additional notes or comments about this module.

## Key Decisions
- sample decision: The explanation of this decision(e.g. Use jest to do automated testing because it is the most popular).
`;

export const AGENTS_CONTENT = `
## Memory Anchor Rules
Memory Anchor is initialized in this repository. Follow these rules to ensure it works effectively.

### File Roles
- ./.memoryanchor/chart.md: Auto-generated log of file changes per session. Read this FIRST to recover recent context.
- ./.memoryanchor/manifest.md: Current project state — Module Status (functionality/status/known_issues/notes) and Key Decisions (architectural choices and rationale).
- ./.memoryanchor/ballast.md: Persistent repo-specific rules/guardrails, one per line.

### Workflow
- Always read ./.memoryanchor/chart.md before accessing any repository files. Only open repository files when chart.md is insufficient.
- Must follow all rules in ./.memoryanchor/ballast.md. After solving a bug, add a rule under "Ballast Specific Rules For This Repository" to prevent recurrence.
- After any of features implemented, update Module Status (and Key Decisions, if applicable) in ./.memoryanchor/manifest.md.

### ballast.md format
- Keep only valid rules. Delete obsolete ones.
- One line per rule, exact format: '- [ ] Rule content'

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
  QODERCN_PRE: 'memoryanchor-qodercn-pre',
  QODERCN_STOP: 'memoryanchor-qodercn-stop',
  QODERCN_POST: 'memoryanchor-qodercn-post',
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
// Tree-sitter Node Type Sets (for symbol extraction in build-chart)
// =============================================================================

/** Languages that use `export` keyword syntax */
export const JS_EXPORT_LANGS = new Set(["javascript", "typescript", "tsx"]);

/** Generic declaration node types matched by the tree-sitter parser */
export const GENERIC_DECLARATIONS = new Set([
  "function_definition",
  "function_declaration",
  "method_definition",
  "method_declaration",
  "class_definition",
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "type_definition",
  "struct_specifier",
]);

export const FUNCTION_DECLARATION_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "method_definition",
  "method_declaration",
]);

export const CLASS_DECLARATION_TYPES = new Set([
  "class_definition",
  "class_declaration",
]);

export const INTERFACE_DECLARATION_TYPES = new Set([
  "interface_declaration",
]);

export const ENUM_DECLARATION_TYPES = new Set([
  "enum_declaration",
]);

export const TYPE_DECLARATION_TYPES = new Set([
  "record_declaration",
  "type_definition",
  "struct_specifier",
]);

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
