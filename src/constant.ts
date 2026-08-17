// =============================================================================
// Ignore Lists (chart build / scan)
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
export const INDEX_FILE_NAME = 'index.md';
/** @deprecated Use INDEX_FILE_NAME. Retained for compatibility with integrations. */
export const CHART_FILE_NAME = INDEX_FILE_NAME;
export const BALLAST_FILE_NAME = 'ballast.md';
export const MANIFEST_FILE_NAME = 'manifest.md';

// =============================================================================
// Default File Contents
// =============================================================================

export const BALLAST_DEFAULT_RULES: string[] = [  
  '- [ ] At the start of every task, read ./.memoryanchor/chart/.../chart.md to establish a project-wide view before working on repository files.',
  '- [ ] If the agent has any uncertainty about the overall project structure, immediately read ./.memoryanchor/index.md again. Then open partition chart files when index.md identifies the relevant directory.',
  '- [ ] Do not change ./.memoryanchor/index.md or ./.memoryanchor/chart/ by yourself. Only do it when user explicitly instructs you to.',
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

- sample decision 2: Remember to keep /n/n after each decision.
`;

export const AGENTS_CONTENT = `
## Memory Anchor Rules
Memory Anchor is initialized in this repository. Follow these rules to ensure it works effectively.

### File Roles
- ./.memoryanchor/index.md: Auto-generated project chart index. Its entries point to directory-level architecture maps under ./.memoryanchor/chart/.
- ./.memoryanchor/chart/.../chart.md: Directory-level architecture map. Read the root chart at the start of every task for project-wide context, then use index.md and Child Charts to find the chart closest to the task.
- ./.memoryanchor/manifest.md: Current project state — Module Status (functionality/status/known_issues/notes) and Key Decisions (architectural choices and rationale).
- ./.memoryanchor/ballast.md: Persistent repo-specific rules/guardrails, one per line.
- ./.memoryanchor/prompt-hooks.json: Optional UserPrompt hook selection; missing or empty means disabled.

### Chart Relationship Notation
- '+' marks an exported symbol; '-' marks the default/internal symbol. Function rows omit the words 'function'; '+' functions include only source-declared parameter/return types, while '-' functions omit signatures.
- Every symbol includes an '[Lstart-end]' source range. Source comments are not included in charts.
- '->' lists parseable repository files referenced by a file, including targets in full repository.
- '<-' lists import-resolved cross-file callers (across charts in full builds), never same-file, member, or dynamic calls; it is attached only to symbols.
- A missing '->' means no parseable repository target was resolved; package and other unresolved imports are omitted.

### Workflow
- At the start of every task, read ./.memoryanchor/chart/.../chart.md to establish a project-wide view before working on repository files.
- If the agent has any uncertainty about the overall project structure, immediately read ./.memoryanchor/index.md again, then read the closest matching directory chart listed there.
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
  CLAUDE_PROMPT: 'memoryanchor-claude-prompt',
  COPILOT_PRE: 'memoryanchor-copilot-pre',
  COPILOT_STOP: 'memoryanchor-copilot-stop',
  COPILOT_POST: 'memoryanchor-copilot-post',
  COPILOT_PROMPT: 'memoryanchor-copilot-prompt',
  CODEX_PRE: 'memoryanchor-codex-pre',
  CODEX_STOP: 'memoryanchor-codex-stop',
  /** Used when the workspace enables the Codex UserPromptSubmit hook; also removes old entries. */
  CODEX_PROMPT: 'memoryanchor-codex-prompt',
  CODEBUDDY_PRE: 'memoryanchor-codebuddy-pre',
  CODEBUDDY_STOP: 'memoryanchor-codebuddy-stop',
  CODEBUDDY_POST: 'memoryanchor-codebuddy-post',
  CODEBUDDY_PROMPT: 'memoryanchor-codebuddy-prompt',
  QODERCN_PRE: 'memoryanchor-qodercn-pre',
  QODERCN_STOP: 'memoryanchor-qodercn-stop',
  QODERCN_POST: 'memoryanchor-qodercn-post',
  QODERCN_PROMPT: 'memoryanchor-qodercn-prompt',
  OPENCODE: 'memoryanchor-opencode',
} as const;

// =============================================================================
// Optional user-prompt hook configuration
// =============================================================================

export const PROMPT_HOOK_AGENTS = [
  'claude',
  'codex',
  'codebuddy',
  'qodercn',
  'copilot',
  'opencode',
] as const;

export type PromptHookAgent = typeof PROMPT_HOOK_AGENTS[number];

export const PROMPT_HOOK_CONFIG_FILE_NAME = 'prompt-hooks.json';
export const PROMPT_HOOK_CONFIG_DEFAULT_CONTENT = '{\n  "enabled": []\n}\n';

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
  // The plugin injects index.md, ballast.md, and manifest.md together.
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
// Tree-sitter Node Type Sets (for symbol extraction in chart build)
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
