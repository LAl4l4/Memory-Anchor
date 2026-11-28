import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemoryStore, inferMemoryKind, similarity } from '../../dist/mcp/memoryStore.js';
import { projectStateModules } from '../../dist/mcp/memoryCatalog.js';

let workspace: string;
let store: MemoryStore;
const anchor = (file: string) => path.join(workspace, '.memoryanchor', file);
const read = (file: string) => readFile(anchor(file), 'utf8');
const put = (file: string, content: string) => writeFile(anchor(file), content);

const GUARDRAILS = '# Repository-specific Guardrails (maintain as the repository evolves)\n'
  + '- [ ] Run Jest in-band because parser pools race.\n'
  + '- [ ] Keep hook stdout reserved for protocol output.\n';
const DECISIONS = '# Key Decisions\n\n- Use tree-sitter for parsing.\n  Continuation explains why.\n\n'
  + '```md\n- not a decision\n```\n\n- Persist charts as markdown.\n';
const STATE = '## Module Status\n\n### Parser\n- functionality: Parses files.\n- status: Stable\n- notes: Old note\n  wrapped detail\n\n'
  + '### Hooks\n- status: Implemented\n\n## Appendix\nKeep me\n';

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'anchor-memory-'));
  await mkdir(path.join(workspace, '.memoryanchor'));
  await put('guardrails.md', GUARDRAILS);
  await put('decisions.md', DECISIONS);
  await put('project-state.md', STATE);
  store = await MemoryStore.create(workspace);
});

afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

test('lists a directory, each kind, and single entries with content-derived ids', async () => {
  const all = await store.get() as any;
  expect(all.guardrails.entries.map((entry: any) => entry.content)).toEqual([
    'Run Jest in-band because parser pools race.', 'Keep hook stdout reserved for protocol output.']);
  expect(all.decisions.entries.map((entry: any) => entry.summary)).toEqual([
    'Use tree-sitter for parsing. Continuation explains why.', 'Persist charts as markdown.']);
  expect(all.project_state.modules).toMatchObject([{ id: 'Parser', status: 'Stable' }, { id: 'Hooks', status: 'Implemented' }]);
  const id = all.decisions.entries[0].id;
  expect(id).toMatch(/^d-[0-9a-f]{8}$/);
  expect(inferMemoryKind(id)).toBe('decisions');
  expect(await store.get(undefined, id)).toMatchObject({ kind: 'decisions',
    entry: { content: 'Use tree-sitter for parsing.\nContinuation explains why.' } });
  expect(await store.get('project_state', 'Parser')).toMatchObject({ entry: { content: expect.stringContaining('wrapped detail') } });
  await expect(store.get('guardrails', 'g-00000000')).rejects.toThrow('get_memory');
});

test('adds, updates and removes guardrails in place without touching other lines', async () => {
  const added = await store.write({ kind: 'guardrails', op: 'add', content: '- [ ] Validate MCP workspace paths.' }) as any;
  expect(added).toMatchObject({ written: true, id: expect.stringMatching(/^g-/) });
  expect(await read('guardrails.md')).toBe(GUARDRAILS + '- [ ] Validate MCP workspace paths.\n');
  const updated = await store.write({ kind: 'guardrails', op: 'update', id: added.id, content: 'Validate canonical MCP workspace paths.' }) as any;
  expect(updated.id).not.toBe(added.id);
  await expect(store.write({ kind: 'guardrails', op: 'remove', id: added.id })).rejects.toThrow('edited or removed');
  await store.write({ kind: 'guardrails', op: 'remove', id: updated.id });
  expect(await read('guardrails.md')).toBe(GUARDRAILS);
  const plain = await store.write({ kind: 'guardrails', op: 'add', content: '1. Keep parser pools\n   bounded by CPUs.' }) as any;
  expect(await read('guardrails.md')).toBe(GUARDRAILS + '- [ ] Keep parser pools bounded by CPUs.\n');
  await store.write({ kind: 'guardrails', op: 'remove', id: plain.id });
  await expect(store.write({ kind: 'guardrails', op: 'add', content: ' - [ ] ' })).rejects.toThrow('non-empty');
});

test('reports duplicates and similar entries unless forced', async () => {
  expect(await store.write({ kind: 'guardrails', op: 'add', content: 'Keep hook stdout reserved for protocol output.' }))
    .toMatchObject({ written: false, reason: 'duplicate' });
  const similar = await store.write({ kind: 'guardrails', op: 'add', content: 'Keep hook stdout reserved for protocol output only.' }) as any;
  expect(similar).toMatchObject({ written: false, reason: 'similar_entries', similar: [{ content: 'Keep hook stdout reserved for protocol output.' }] });
  expect(await read('guardrails.md')).toBe(GUARDRAILS);
  expect(await store.write({ kind: 'guardrails', op: 'add', force: true,
    content: 'Keep hook stdout reserved for protocol output only.' })).toMatchObject({ written: true });
  expect(similarity('解析器线程池复用', '解析器线程池')).toBeGreaterThan(0.5);
});

test('writes multi-line decisions, ignores fenced bullets, and preserves blank-line separation', async () => {
  const all = await store.get('decisions') as any;
  expect(all.entries).toHaveLength(2);
  const added = await store.write({ kind: 'decisions', op: 'add', content: 'Expose memory writes through MCP.\nAgents still may edit files.' }) as any;
  expect(await read('decisions.md')).toBe(DECISIONS + '\n- Expose memory writes through MCP.\n  Agents still may edit files.\n');
  await store.write({ kind: 'decisions', op: 'update', id: all.entries[0].id, content: 'Use tree-sitter WASM for parsing.' });
  await store.write({ kind: 'decisions', op: 'remove', id: added.id });
  expect(await read('decisions.md')).toBe(DECISIONS.replace('- Use tree-sitter for parsing.\n  Continuation explains why.', '- Use tree-sitter WASM for parsing.'));
});

test('patches project-state fields, adds and removes modules, and checks versions', async () => {
  const parser = await store.get('project_state', 'Parser') as any;
  await store.write({ kind: 'project_state', op: 'update', id: 'Parser', version: parser.entry.version,
    fields: { notes: 'New note', known_issues: 'None' } });
  const content = await read('project-state.md');
  expect(content).toContain('- status: Stable\n- notes: New note\n- known_issues: None\n\n### Hooks');
  expect(content).not.toContain('wrapped detail');
  await expect(store.write({ kind: 'project_state', op: 'update', id: 'Parser', version: parser.entry.version,
    fields: { status: 'Deprecated' } })).rejects.toThrow('changed since');
  expect(await store.write({ kind: 'project_state', op: 'add', id: 'parser', fields: { status: 'x' } }))
    .toMatchObject({ written: false, reason: 'duplicate', id: 'Parser' });
  await store.write({ kind: 'project_state', op: 'add', id: 'MCP memory', fields: { status: 'Implemented', functionality: 'Reads and writes memory.' } });
  const added = await read('project-state.md');
  expect(added).toContain('- status: Implemented\n\n### MCP memory\n- functionality: Reads and writes memory.\n- status: Implemented\n\n## Appendix\nKeep me');
  expect(projectStateModules(added).map(module => module.name)).toEqual(['Parser', 'Hooks', 'MCP memory']);
  await store.write({ kind: 'project_state', op: 'remove', id: 'MCP memory' });
  await store.write({ kind: 'project_state', op: 'remove', id: 'Hooks' });
  expect(await read('project-state.md')).toContain('- known_issues: None\n\n## Appendix\nKeep me\n');
  await store.write({ kind: 'project_state', op: 'update', id: 'Parser', fields: { status: 'Stable,\n  reviewed' } });
  expect(await read('project-state.md')).toContain('- status: Stable, reviewed\n');
});

test('creates missing files, keeps CRLF, and refuses symlinked memory files', async () => {
  await rm(anchor('guardrails.md'));
  await rm(anchor('decisions.md'));
  await rm(anchor('project-state.md'));
  await store.write({ kind: 'guardrails', op: 'add', content: 'First rule.' });
  await store.write({ kind: 'decisions', op: 'add', content: 'First decision.' });
  await store.write({ kind: 'project_state', op: 'add', id: 'Core', fields: { status: 'Planned' } });
  expect(await read('guardrails.md')).toBe('# Repository-specific Guardrails (maintain as the repository evolves)\n- [ ] First rule.\n');
  expect(await read('decisions.md')).toBe('# Key Decisions\n\n- First decision.\n');
  expect(await read('project-state.md')).toBe('## Module Status\n\n### Core\n- status: Planned\n');
  await put('decisions.md', '# Key Decisions\r\n\r\n- One.\r\n');
  await store.write({ kind: 'decisions', op: 'add', content: 'Two.' });
  expect(await read('decisions.md')).toBe('# Key Decisions\r\n\r\n- One.\r\n\r\n- Two.\r\n');
  await rm(anchor('guardrails.md'));
  await symlink(path.join(os.tmpdir(), 'outside.md'), anchor('guardrails.md'));
  await expect(store.write({ kind: 'guardrails', op: 'add', content: 'x' })).rejects.toThrow('regular file');
});

test('serializes concurrent writers so no entry is lost', async () => {
  const other = await MemoryStore.create(workspace);
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? store : other).write({ kind: 'guardrails', op: 'add', force: true, content: `Concurrent rule ${index} ${'abcdefgh'[index]}.` })));
  const entries = (await store.get('guardrails') as any).entries;
  expect(entries).toHaveLength(10);
});

test('warns when memory exceeds advisory budgets without truncating', async () => {
  const result = await store.write({ kind: 'guardrails', op: 'add', content: `Long rule ${'x'.repeat(6000)}` }) as any;
  expect(result).toMatchObject({ written: true, warning: expect.stringContaining('guardrails.md') });
  expect(await read('guardrails.md')).toContain('x'.repeat(6000));
});

test('real CLI stdio serves get_memory, recall_memory and write_memory', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('dist/cli.js'), 'mcp', '--workspace', workspace], stderr: 'pipe' });
  const client = new Client({ name: 'memory-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const write = await client.callTool({ name: 'write_memory', arguments: { kind: 'project_state', op: 'update', id: 'Hooks', fields: { notes: 'Via MCP' } } });
    expect(write.isError).not.toBe(true);
    const get = await client.callTool({ name: 'get_memory', arguments: { kind: 'project_state', id: 'Hooks' } });
    expect(JSON.stringify(get.content)).toContain('Via MCP');
    const recall = await client.callTool({ name: 'recall_memory', arguments: { query: 'hook stdout protocol' } });
    expect(recall.isError).not.toBe(true);
    const recalled = JSON.parse((recall.content as any)[0].text);
    // The CLI resolves the packaged embedding model relative to dist/.
    expect(recalled.ranking).toBe('bm25+semantic');
    const hits = recalled.results;
    expect(hits[0]).toMatchObject({ kind: 'guardrails', content: 'Keep hook stdout reserved for protocol output.' });
    expect((await client.callTool({ name: 'recall_memory', arguments: { query: 'hooks', limit: 50 } })).isError).toBe(true);
    expect((await client.callTool({ name: 'write_memory', arguments: { kind: 'project_state', op: 'update', id: 'Hooks', fields: { bogus: 'x' } } })).isError).toBe(true);
    expect((await client.callTool({ name: 'write_memory', arguments: { kind: 'guardrails', op: 'remove' } })).isError).toBe(true);
  } finally { await client.close(); }
}, 15000);

test('separate MCP server processes writing at once lose no entries or field updates', async () => {
  const clients = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const client = new Client({ name: `writer-${index}`, version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('dist/cli.js'), 'mcp', '--workspace', workspace], stderr: 'pipe' }));
    return client;
  }));
  try {
    const fields = ['functionality', 'dependencies', 'known_issues', 'notes'];
    const results = await Promise.all(clients.flatMap((client, writer) => [
      ...Array.from({ length: 5 }, (_, item) => client.callTool({ name: 'write_memory', arguments: {
        kind: 'guardrails', op: 'add', force: true, content: `Writer ${writer} rule ${item} ${'qwxyz'[item]}${'abcd'[writer]}.` } })),
      client.callTool({ name: 'write_memory', arguments: {
        kind: 'project_state', op: 'update', id: 'Hooks', fields: { [fields[writer]]: `from writer ${writer}` } } }),
    ]));
    expect(results.filter(result => result.isError)).toEqual([]);
  } finally { await Promise.all(clients.map(client => client.close())); }
  expect((await store.get('guardrails') as any).entries).toHaveLength(22);
  const hooks = (await store.get('project_state', 'Hooks') as any).entry.content;
  for (let writer = 0; writer < 4; writer++) expect(hooks).toContain(`from writer ${writer}`);
  expect(hooks).toContain('- status: Implemented');
}, 30000);
