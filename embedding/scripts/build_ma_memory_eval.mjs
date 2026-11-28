// Build a recall eval over this repository's own memory (.memoryanchor) for eval_recall_pipeline.mjs.
//
// Docs are the entries recall_memory searches (guardrails, decisions, project_state modules as "name\ncontent").
// Gold entries are named by the start of their text (module names for project_state), so the set survives
// unrelated memory edits; the build fails if a prefix matches no entry or several. Several golds per query
// mark overlapping entries that answer it equally. The output snapshots memory content, so it is written to
// gitignored embedding/data/ rather than committed (.memoryanchor itself is not tracked).
//
// Usage (after npm run build): node build_ma_memory_eval.mjs [out=../data/eval_ma_memory.json]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../../dist/mcp/memoryStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? path.join(here, '../data/eval_ma_memory.json');

const KEYWORD = [
  ['jest in-band', ['Run Jest in-band', 'Test tooling']],
  ['gitignore memoryanchorignore exclusions', ['Apply one workspace-rooted ignore policy', 'Use workspace and nested `.gitignore` rules', 'File inclusion policy']],
  ['Codex SessionStart JSON', ['Use only supported lifecycle events']],
  ['OpenCode workspace resolution worktree', ['OpenCode must resolve the first', 'Resolve OpenCode workspace state']],
  ['Hermes config.yaml pre_llm_call', ['Edit global Hermes YAML', 'Hermes hooks live in the global', 'Hermes Agent integration']],
  ['debug.log diagnostics', ['Keep diagnostics opt-in through debug.json', 'Keep diagnostics opt-in through `.memoryanchor/debug.json`', 'Diagnostics and session maintenance']],
  ['parse cache full build', ['Full builds must share one absolute-path parse cache', 'Share a build-scoped parse cache']],
  ['untracked git paths deletion', ['Capture Git changes with', 'Persist observed Git-untracked paths']],
  ['write_memory lock atomic rename', ['MCP queries must reuse chart ownership', 'Expose memory reads and writes through get_memory']],
  ['recall_memory BM25 embedding', ['Recall memory keyword-first', 'MCP chart queries']],
  ['Antigravity hooks.json', ['Integrate Antigravity through workspace', 'Antigravity integration']],
  ['execArgv input-type worker', ['Strip `--input-type`', 'Parser pools must be lazy']],
];
const PARAPHRASE = [
  ['why do tests have to run one at a time', ['Run Jest in-band', 'Test tooling']],
  ['how do I keep some folders out of the architecture map', ['Apply one workspace-rooted ignore policy', 'Use workspace and nested `.gitignore` rules', 'File inclusion policy']],
  ['where is the memory search ranking explained', ['Recall memory keyword-first']],
  ['what happens if two agents change memory at the same time', ['Expose memory reads and writes through get_memory', 'MCP queries must reuse chart ownership']],
  ['avoid parsing the same file twice during a rebuild', ['Share a build-scoped parse cache', 'Full builds must share one absolute-path parse cache']],
  ['how are worker threads kept from blocking process exit', ['Keep parser pools demand-lazy', 'Parser pools must be lazy']],
  ['how do lifecycle hooks log troubleshooting information', ['Keep diagnostics opt-in through debug.json', 'Keep diagnostics opt-in through `.memoryanchor/debug.json`', 'Diagnostics and session maintenance']],
  ['do hooks automatically delete outdated rules', ['Lifecycle hooks do not infer stale rules', 'Keep memory maintenance advisory']],
  ['how is context added to the system prompt in OpenCode', ['OpenCode context uses `experimental.chat.system.transform`', 'OpenCode must resolve the first']],
  ['detect files that were changed and then reverted', ['Skip unchanged dirty files', 'Capture Git changes with']],
  ['the benchmark for agents breaking hidden invariants', ['MA-mini-agent evaluation harness']],
  ['which tools does the MCP server expose', ['MCP chart queries', 'Expose on-demand architecture through a read-only stdio MCP server']],
];
// This memory is English, so these are cross-language queries, which the shipped model does not target.
const CHINESE = [
  ['测试为什么必须串行运行', ['Run Jest in-band', 'Test tooling']],
  ['多个智能体同时写记忆会不会丢数据', ['Expose memory reads and writes through get_memory', 'MCP queries must reuse chart ownership']],
  ['调试日志写在哪里', ['Keep diagnostics opt-in through debug.json', 'Keep diagnostics opt-in through `.memoryanchor/debug.json`', 'Diagnostics and session maintenance']],
  ['解析缓存', ['Full builds must share one absolute-path parse cache', 'Share a build-scoped parse cache']],
];

const store = await MemoryStore.create(path.resolve(here, '../..'));
const docs = [];
for (const kind of ['guardrails', 'decisions']) for (const entry of (await store.get(kind)).entries) docs.push(entry.content);
for (const module of (await store.get('project_state')).modules) {
  docs.push(`${module.id}\n${(await store.get('project_state', module.id)).entry.content}`);
}

const resolve = prefix => {
  const found = docs.flatMap((doc, index) => (doc.startsWith(prefix) ? [index] : []));
  if (found.length !== 1) throw new Error(`gold prefix ${JSON.stringify(prefix)} matches ${found.length} entries`);
  return found[0];
};
const build = queries => ({ docs, queries: queries.map(([query, golds]) => [query, golds.map(resolve)]) });

writeFileSync(out, JSON.stringify({ sets: {
  'MA memory: keyword queries': build(KEYWORD),
  'MA memory: English paraphrases': build(PARAPHRASE),
  'MA memory: Chinese queries (cross-language)': build(CHINESE),
} }, null, 1));
console.log(`${docs.length} entries, ${KEYWORD.length + PARAPHRASE.length + CHINESE.length} queries -> ${out}`);
