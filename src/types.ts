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


export type Lang = typeof LANGS[number];
