import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bm25Index, searchTerms, stem } from '../../dist/mcp/bm25.js';
import { MemoryStore } from '../../dist/mcp/memoryStore.js';

describe('search terms', () => {
  test('stems inflected forms onto one term', () => {
    const groups = [
      ['cache', 'caches', 'cached', 'caching'], ['parse', 'parses', 'parsed', 'parsing'],
      ['write', 'writes', 'writing'], ['refresh', 'refreshes', 'refreshed', 'refreshing'],
      ['embedding', 'embeddings', 'embedded'], ['policy', 'policies'], ['copy', 'copied'],
      ['process', 'processes', 'processing'], ['run', 'running'], ['setting', 'settings', 'set'],
      ['index', 'indexes', 'indexed'], ['name', 'names', 'named'], ['add', 'added', 'adding'],
    ];
    for (const group of groups) expect(new Set(group.map(stem))).toEqual(new Set([stem(group[0])]));
    const kept = ['status', 'class', 'analysis', 'string', 'thing', 'need', 'call', 'v2'];
    expect(kept.map(stem)).toEqual(kept);
    expect(['called', 'needed', 'calls'].map(stem)).toEqual(['call', 'need', 'call']);
  });

  test('splits identifiers, keeps compounds, drops stop words and short tokens', () => {
    expect(searchTerms('The memoryStore holds get_memory APIs for MCPServer v2')).toEqual([
      'memorystor', 'memory', 'stor', 'hold', 'get_memory', 'get', 'memory', 'api', 'mcpserver', 'mcp', 'server', 'v2']);
    expect(searchTerms('a I to of')).toEqual([]);
  });

  test('indexes CJK runs as overlapping bigrams next to Latin words', () => {
    expect(searchTerms('向量检索 recall 率，缓存')).toEqual(['向量', '量检', '检索', 'recall', '率', '缓存']);
    expect(searchTerms('ＭＣＰ')).toEqual(['mcp']);
  });
});

describe('BM25 index', () => {
  const docs = [
    'parser pools reuse workers',
    'hooks emit json context',
    'parser parser parser cache',
    'mcp server tools and hooks registration with a much longer body about clients configs and launches',
  ].map(searchTerms);
  const index = new Bm25Index(docs);

  test('ranks rarer terms above common ones and excludes documents without matches', () => {
    const hits = index.search(searchTerms('parser json'), 10);
    expect(hits.map(hit => hit.index)).toEqual([1, 2, 0]);
    expect(index.search(searchTerms('nothing here'), 10)).toEqual([]);
  });

  test('saturates term frequency and normalizes by length', () => {
    const [pool, , repeated] = index.scores(searchTerms('parser'));
    expect(repeated).toBeGreaterThan(pool);
    expect(repeated).toBeLessThan(pool * 3);
    const hooks = index.scores(searchTerms('hooks'));
    expect(hooks[1]).toBeGreaterThan(hooks[3]);
  });

  test('keeps document order for ties and honors the limit', () => {
    const tied = new Bm25Index([['a1'], ['b1'], ['a1'], ['a1']]);
    expect(tied.search(['a1'], 2).map(hit => hit.index)).toEqual([0, 2]);
    expect(new Bm25Index([]).search(['a1'], 5)).toEqual([]);
  });
});

describe('MemoryStore.recall', () => {
  let workspace: string;
  let store: MemoryStore;
  const put = (file: string, content: string) => writeFile(path.join(workspace, '.memoryanchor', file), content);

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'anchor-recall-'));
    await mkdir(path.join(workspace, '.memoryanchor'));
    await put('guardrails.md', '# Repository-specific Guardrails (maintain as the repository evolves)\n'
      + '- [ ] Run Jest in-band because parser pools race.\n'
      + '- [ ] Keep hook stdout reserved for protocol output.\n'
      + '- [ ] Keep hook stdout reserved for protocol output.\n');
    await put('decisions.md', '# Key Decisions\n\n- Use tree-sitter for parsing source files.\n\n'
      + '- Persist charts as markdown so agents can read them.\n  Rendering stays on the main heap.\n\n'
      + '- 记忆检索先使用 BM25，之后再融合向量召回。\n');
    await put('project-state.md', '## Module Status\n\n'
      + '### Parser and worker pools\n- functionality: Extracts symbols with reusable workers.\n- status: Stable\n\n'
      + '### Hooks\n- functionality: Emits session context for each agent.\n- status: Implemented\n'
      + '- notes: Codex output must be one JSON object.\n');
    store = await MemoryStore.create(workspace);
  });

  afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

  test('returns complete entries across kinds with ids get_memory accepts', async () => {
    const result = await store.recall({ query: 'parser worker pools' }) as any;
    expect(result).toMatchObject({ query: 'parser worker pools', searched: 7 });
    expect(result.results.map((hit: any) => hit.id)).toEqual(['Parser and worker pools', expect.stringMatching(/^g-/)]);
    const [module, guardrail] = result.results;
    expect(module).toMatchObject({ kind: 'project_state', version: expect.stringMatching(/^[0-9a-f]{8}$/),
      content: expect.stringContaining('- status: Stable') });
    expect(await store.get('project_state', module.id)).toMatchObject({ entry: { version: module.version, content: module.content } });
    expect(guardrail).toMatchObject({ kind: 'guardrails', content: 'Run Jest in-band because parser pools race.' });
    expect(guardrail).not.toHaveProperty('version');
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
  });

  test('filters by kind, honors limit and lists duplicate entries once', async () => {
    const hooks = await store.recall({ query: 'hook stdout output', kind: 'guardrails' }) as any;
    expect(hooks.searched).toBe(2);
    expect(hooks.results).toHaveLength(1);
    expect((await store.recall({ query: 'parser hooks markdown', limit: 2 }) as any).results).toHaveLength(2);
    const cjk = await store.recall({ query: '向量召回', kind: 'decisions' }) as any;
    expect(cjk.results[0].content).toContain('BM25');
  });

  test('reads current files on every call', async () => {
    const before = await store.recall({ query: 'embeddings' }) as any;
    expect(before.results).toEqual([]);
    expect(before.hint).toContain('get_memory');
    await store.write({ kind: 'decisions', op: 'add', content: 'Fuse embedding similarity with BM25 scores later.' });
    const after = await store.recall({ query: 'embeddings' }) as any;
    expect(after.results.map((hit: any) => hit.content)).toEqual(['Fuse embedding similarity with BM25 scores later.']);
    expect(after).not.toHaveProperty('hint');
  });

  test('reuses the index only while file content is unchanged, not by mtime', async () => {
    const file = path.join(workspace, '.memoryanchor', 'guardrails.md');
    expect((await store.recall({ query: 'jest' }) as any).results).toHaveLength(1);
    const { mtime } = await stat(file);
    const content = await readFile(file, 'utf8');
    // Same byte length and restored mtime: only a content comparison can notice the edit.
    await writeFile(file, content.replace('Run Jest in-band', 'Run Vite in-band'));
    await utimes(file, mtime, mtime);
    const fresh = await MemoryStore.create(workspace);
    expect((await fresh.recall({ query: 'jest' }) as any).results).toEqual([]);
    expect((await store.recall({ query: 'vite' }) as any).results[0].content).toBe('Run Vite in-band because parser pools race.');
  });

  test('rejects queries without searchable words and invalid options', async () => {
    await expect(store.recall({ query: 'the and of ?' })).rejects.toThrow('searchable words');
    await expect(store.recall({ query: 'parser', limit: 0 })).rejects.toThrow('limit');
    await expect(store.recall({ query: 'parser', limit: 21 })).rejects.toThrow('limit');
    await expect(store.recall({ query: 'parser', kind: 'bogus' as any })).rejects.toThrow('kind must be one of');
  });
});
