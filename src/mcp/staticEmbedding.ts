/**
 * Semantic ranking for memory recall: a Model2Vec static embedding model run in plain TypeScript.
 *
 * A static model is a token -> vector table; a text's embedding is the mean of its tokens' rows. No neural
 * network runs at query time, so encoding costs microseconds and needs no native or WASM dependency.
 * The shipped model (embedding/models, see embedding/scripts) is distilled from jina-embeddings-v2-base-zh and
 * tokenlearn-trained on Chinese and English text; it matches zh->zh and en->en, not across languages.
 *
 * Encoding mirrors model2vec's StaticModel.encode: the Hugging Face tokenizer (NFC + lowercase normalizer,
 * Whitespace pre-tokenizer, BPE without byte fallback) without special tokens, unknown tokens dropped, at most
 * `max_length` tokens, mean pooling. Vectors are L2-normalized here so a dot product is the cosine. int8 rows
 * share one global scale, which cosine similarity ignores, so they are used as stored.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Packaged with the npm module (package.json files); resolved from dist/mcp/. */
export const DEFAULT_MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../embedding/models/m2v-jina-zh-256-tl-int8');

/** Longer input is cut before tokenizing; far beyond max_length tokens for any script. */
const MAX_INPUT_CHARS = 20_000;

// Rust regex `\w` (Unicode) and `\s`, which the Hugging Face Whitespace pre-tokenizer uses: `\w+|[^\w\s]+`.
const W = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}`;
const PRE_TOKEN = new RegExp(`[${W}]+|[^${W}\\p{White_Space}]+`, 'gu');

interface TokenizerJson {
  normalizer?: unknown;
  pre_tokenizer?: { type?: string } | null;
  model: { type: string; unk_token?: string | null; vocab: Record<string, number>; merges: (string | [string, string])[];
    continuing_subword_prefix?: string | null; end_of_word_suffix?: string | null; byte_fallback?: boolean };
}

/** The subset of the Hugging Face BPE tokenizer the shipped model uses; other configurations are refused. */
export class BpeTokenizer {
  private readonly ranks = new Map<string, number>();
  private readonly cache = new Map<string, number[]>();
  readonly unkId: number | undefined;

  constructor(private readonly vocab: Map<string, number>, merges: [string, string][], unkToken: string | null) {
    merges.forEach(([a, b], rank) => this.ranks.set(`${a} ${b}`, rank));
    this.unkId = unkToken === null ? undefined : vocab.get(unkToken);
  }

  static fromJson(json: TokenizerJson): BpeTokenizer {
    const { model, pre_tokenizer: pre, normalizer } = json;
    const expectedNormalizer = JSON.stringify({ type: 'Sequence', normalizers: [{ type: 'NFC' }, { type: 'Lowercase' }] });
    if (model.type !== 'BPE' || model.byte_fallback || model.continuing_subword_prefix || model.end_of_word_suffix
      || pre?.type !== 'Whitespace' || JSON.stringify(normalizer) !== expectedNormalizer) {
      throw new Error('unsupported tokenizer: expected NFC+Lowercase, Whitespace, plain BPE');
    }
    const merges = model.merges.map(merge => (typeof merge === 'string' ? merge.split(' ') : merge) as [string, string]);
    return new BpeTokenizer(new Map(Object.entries(model.vocab)), merges, model.unk_token ?? null);
  }

  /** Token ids without special tokens; unknown characters yield unkId. */
  encode(text: string): number[] {
    const ids: number[] = [];
    for (const [word] of text.normalize('NFC').toLowerCase().matchAll(PRE_TOKEN)) {
      let wordIds = this.cache.get(word);
      if (!wordIds) {
        wordIds = this.encodeWord(word);
        if (this.cache.size > 50_000) this.cache.clear();
        this.cache.set(word, wordIds);
      }
      ids.push(...wordIds);
    }
    return ids;
  }

  /** Repeatedly merge the adjacent pair with the lowest merge rank, leftmost first. */
  private encodeWord(word: string): number[] {
    const parts = [...word];
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let at = 0; at + 1 < parts.length; at++) {
        const rank = this.ranks.get(`${parts[at]} ${parts[at + 1]}`);
        if (rank !== undefined && rank < bestRank) { bestRank = rank; best = at; }
      }
      if (best < 0) break;
      parts.splice(best, 2, parts[best] + parts[best + 1]);
    }
    return parts.flatMap(part => {
      const id = this.vocab.get(part);
      if (id !== undefined) return [id];
      return this.unkId === undefined ? [] : [this.unkId];
    });
  }
}

interface ModelConfig { max_length?: number | null; hidden_dim?: number }

export class StaticEmbedding {
  private constructor(
    readonly tokenizer: BpeTokenizer,
    private readonly rows: Int8Array | Float32Array,
    readonly dim: number,
    private readonly maxLength: number,
  ) {}

  static async load(dir: string = DEFAULT_MODEL_DIR): Promise<StaticEmbedding> {
    const [config, tokenizer, weights] = await Promise.all([
      fs.readFile(path.join(dir, 'config.json'), 'utf8').then(text => JSON.parse(text) as ModelConfig),
      fs.readFile(path.join(dir, 'tokenizer.json'), 'utf8').then(text => BpeTokenizer.fromJson(JSON.parse(text))),
      fs.readFile(path.join(dir, 'model.safetensors')),
    ]);
    const { rows, vocabSize, dim } = readEmbeddings(weights);
    if (config.hidden_dim !== undefined && config.hidden_dim !== dim) throw new Error('config hidden_dim does not match the weights');
    if (tokenizer.unkId !== undefined && tokenizer.unkId >= vocabSize) throw new Error('tokenizer and weights disagree');
    return new StaticEmbedding(tokenizer, rows, dim, config.max_length ?? Number.MAX_SAFE_INTEGER);
  }

  /** Unit-length embedding, or null when the text has no known token. */
  embed(text: string): Float32Array | null {
    const unk = this.tokenizer.unkId;
    const ids = this.tokenizer.encode(text.slice(0, MAX_INPUT_CHARS)).filter(id => id !== unk).slice(0, this.maxLength);
    if (!ids.length) return null;
    const { dim, rows } = this;
    const sum = new Float32Array(dim);
    for (const id of ids) {
      const offset = id * dim;
      for (let at = 0; at < dim; at++) sum[at] += rows[offset + at];
    }
    let norm = 0;
    for (let at = 0; at < dim; at++) norm += sum[at] * sum[at];
    if (!norm) return null;
    const scale = 1 / Math.sqrt(norm);
    for (let at = 0; at < dim; at++) sum[at] *= scale;
    return sum;
  }
}

/** Dot product of unit vectors; 0 when either text had no known token. */
export function cosine(a: Float32Array | null, b: Float32Array | null): number {
  if (!a || !b) return 0;
  let dot = 0;
  for (let at = 0; at < a.length; at++) dot += a[at] * b[at];
  return dot;
}

/** The `embeddings` tensor of a safetensors file (8-byte little-endian header length, JSON header, raw data). */
function readEmbeddings(file: Buffer): { rows: Int8Array | Float32Array; vocabSize: number; dim: number } {
  const headerLength = Number(file.readBigUInt64LE(0));
  const header = JSON.parse(file.subarray(8, 8 + headerLength).toString('utf8'));
  const tensor = header.embeddings as { dtype: string; shape: [number, number]; data_offsets: [number, number] } | undefined;
  if (!tensor || tensor.shape.length !== 2) throw new Error('model.safetensors has no 2-D embeddings tensor');
  const [vocabSize, dim] = tensor.shape;
  const start = 8 + headerLength + tensor.data_offsets[0];
  const bytes = tensor.data_offsets[1] - tensor.data_offsets[0];
  // Copy into a fresh, aligned buffer; Buffer pooling can leave the source at any byte offset.
  const data = new Uint8Array(file.subarray(start, start + bytes)).buffer;
  if (tensor.dtype === 'I8') return { rows: new Int8Array(data), vocabSize, dim };
  if (tensor.dtype === 'F32') return { rows: new Float32Array(data), vocabSize, dim };
  throw new Error(`unsupported embeddings dtype ${tensor.dtype}`);
}

let shared: Promise<StaticEmbedding | null> | undefined;

/**
 * The packaged model, loaded once per process. Resolves to null when it cannot be loaded (missing files in a
 * source checkout, a corrupt download), so recall degrades to keyword ranking instead of failing.
 */
export function loadDefaultEmbedding(): Promise<StaticEmbedding | null> {
  shared ??= StaticEmbedding.load().catch(() => null);
  return shared;
}
