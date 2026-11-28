import { describe, expect, test } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpeTokenizer, DEFAULT_MODEL_DIR, StaticEmbedding, cosine, loadDefaultEmbedding } from '../../dist/mcp/staticEmbedding.js';
import { MIN_SIMILARITY_WITH_KEYWORDS, MIN_SIMILARITY_WITHOUT_KEYWORDS, selectRecallHits, semanticSlots } from '../../dist/mcp/hybridRank.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Token ids and pairwise cosines from model2vec's Python StaticModel on the shipped model. */
const golden = JSON.parse(readFileSync(path.join(here, 'fixtures', 'static-embedding-golden.json'), 'utf8')) as {
  texts: string[]; ids: number[][]; similarity: number[][];
};

describe('static embedding model', () => {
  test('ships next to dist and loads through the shared loader', async () => {
    expect(DEFAULT_MODEL_DIR.endsWith(path.join('embedding', 'models', 'm2v-jina-zh-256-tl-int8'))).toBe(true);
    const model = await loadDefaultEmbedding();
    expect(model).not.toBeNull();
    expect(model!.dim).toBe(256);
    expect(await loadDefaultEmbedding()).toBe(model);
  });

  test('tokenizes exactly like the Python reference, unknown tokens dropped', async () => {
    const model = (await loadDefaultEmbedding())!;
    const unk = model.tokenizer.unkId;
    golden.texts.forEach((text, at) => {
      expect(model.tokenizer.encode(text).filter(id => id !== unk)).toEqual(golden.ids[at]);
    });
  });

  test('produces unit vectors whose cosines match the Python reference', async () => {
    const model = (await loadDefaultEmbedding())!;
    const vectors = golden.texts.map(text => model.embed(text));
    golden.texts.forEach((text, at) => {
      const vector = vectors[at];
      if (!golden.ids[at].length) { expect(vector).toBeNull(); return; }
      expect(cosine(vector, vector)).toBeCloseTo(1, 5);
      golden.texts.forEach((_, other) => {
        if (!golden.ids[other].length) return;
        expect(Math.abs(cosine(vector, vectors[other]) - golden.similarity[at][other])).toBeLessThan(1e-4);
      });
    });
    expect(cosine(null, vectors[0])).toBe(0);
  });

  test('ranks a same-language paraphrase above an unrelated sentence', async () => {
    const model = (await loadDefaultEmbedding())!;
    const near = (query: string, related: string, unrelated: string) =>
      cosine(model.embed(query), model.embed(related)) - cosine(model.embed(query), model.embed(unrelated));
    expect(near('一直拿不到数据库连接', '数据库连接池默认最多 20 个连接，获取连接超时会抛出异常。', '图片上传后会异步生成缩略图。')).toBeGreaterThan(0.1);
    expect(near('can\'t get a db connection', 'The database connection pool allows at most 20 connections.',
      'Uploaded images get thumbnails generated asynchronously.')).toBeGreaterThan(0.1);
  });

  test('refuses tokenizers it does not implement and missing model files', async () => {
    const base = { normalizer: { type: 'Sequence', normalizers: [{ type: 'NFC' }, { type: 'Lowercase' }] },
      pre_tokenizer: { type: 'Whitespace' }, model: { type: 'BPE', vocab: { a: 0 }, merges: [] } };
    expect(() => BpeTokenizer.fromJson(base)).not.toThrow();
    expect(() => BpeTokenizer.fromJson({ ...base, model: { ...base.model, type: 'WordPiece' } })).toThrow('unsupported tokenizer');
    expect(() => BpeTokenizer.fromJson({ ...base, model: { ...base.model, byte_fallback: true } })).toThrow('unsupported tokenizer');
    expect(() => BpeTokenizer.fromJson({ ...base, pre_tokenizer: { type: 'ByteLevel' } })).toThrow('unsupported tokenizer');
    expect(() => BpeTokenizer.fromJson({ ...base, normalizer: null })).toThrow('unsupported tokenizer');
    const empty = await mkdtemp(path.join(os.tmpdir(), 'anchor-model-'));
    try {
      await expect(StaticEmbedding.load(empty)).rejects.toThrow();
      await writeFile(path.join(empty, 'config.json'), '{}');
      await writeFile(path.join(empty, 'tokenizer.json'), JSON.stringify(base));
      await writeFile(path.join(empty, 'model.safetensors'), Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0x7b, 0x7d]));
      await expect(StaticEmbedding.load(empty)).rejects.toThrow('embeddings tensor');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('merges BPE pairs by rank, leftmost first', () => {
    const vocab = new Map([['<unk>', 0], ['a', 1], ['b', 2], ['ab', 3], ['aa', 4], ['aab', 5]]);
    const tokenizer = new BpeTokenizer(vocab, [['a', 'a'], ['a', 'b'], ['aa', 'b']], '<unk>');
    expect(tokenizer.encode('aaab')).toEqual([4, 3]);
    expect(tokenizer.encode('aab')).toEqual([5]);
    expect(tokenizer.encode('AB c')).toEqual([3, 0]);
  });
});

describe('recall hit selection', () => {
  const indices = (hits: { index: number }[]) => hits.map(hit => hit.index);

  test('reserves a quarter of the limit, rounded down, for meaning-only entries', () => {
    expect([1, 3, 4, 5, 8, 11, 12, 20].map(semanticSlots)).toEqual([0, 0, 1, 1, 2, 2, 3, 5]);
  });

  test('reduces to BM25 order without semantic ranking', () => {
    const hits = selectRecallHits([0, 3, 1, 3], null, 10);
    expect(indices(hits)).toEqual([1, 3, 2]);
    expect(hits[0]).toEqual({ index: 1, match: 'keyword', bm25: 3 });
    expect(indices(selectRecallHits([0, 3, 1, 3], null, 2))).toEqual([1, 3]);
  });

  test('keeps BM25 top places untouched and appends confident meaning-only entries in the reserved places', () => {
    // Ten keyword matches (indices 0-9, BM25 descending) and three meaning-only candidates (10-12).
    const bm25 = [...Array.from({ length: 10 }, (_, at) => 10 - at), 0, 0, 0];
    const similarity = [...Array(10).fill(0.9), 0.5, 0.4, MIN_SIMILARITY_WITH_KEYWORDS - 0.01];
    const hits = selectRecallHits(bm25, similarity, 8);
    expect(indices(hits)).toEqual([0, 1, 2, 3, 4, 5, 10, 11]);
    expect(hits.slice(0, 6).every(hit => hit.match === 'keyword' && hit.bm25 !== undefined)).toBe(true);
    expect(hits[6]).toEqual({ index: 10, match: 'meaning', similarity: 0.5 });
    // Without enough confident meaning-only entries, BM25 keeps the places.
    expect(indices(selectRecallHits(bm25, [...Array(10).fill(0.9), 0.5, 0.1, 0.1], 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 10]);
    // Small limits reserve nothing.
    expect(indices(selectRecallHits(bm25, similarity, 3))).toEqual([0, 1, 2]);
  });

  test('fills places keyword matches leave empty, with a lower floor when nothing matches by keyword', () => {
    const similarity = [0.5, 0.4, 0.3, MIN_SIMILARITY_WITHOUT_KEYWORDS + 0.01, MIN_SIMILARITY_WITHOUT_KEYWORDS - 0.01, null];
    expect(indices(selectRecallHits([0, 0, 0, 0, 0, 0], similarity, 2))).toEqual([0, 1]);
    expect(indices(selectRecallHits([0, 0, 0, 0, 0, 0], similarity, 10))).toEqual([0, 1, 2, 3]);
    const one = selectRecallHits([0, 0, 0, 0, 1, 0], similarity, 10);
    expect(indices(one)).toEqual([4, 0, 1, 2]);
    expect(one.map(hit => hit.match)).toEqual(['keyword', 'meaning', 'meaning', 'meaning']);
  });
});
