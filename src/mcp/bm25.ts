/**
 * Lexical ranking for memory recall: a tokenizer for mixed prose, code identifiers and CJK text, and an
 * Okapi BM25 index. The index scores every document so another ranker (embeddings) can be fused later.
 */

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'so', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your']);
/** Scripts written without spaces; they are indexed as overlapping character bigrams. */
const UNSPACED_RUN = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+)/u;
const WORD = /[\p{L}\p{N}_]+/gu;

/**
 * Light English suffix stripping so plurals and -ed/-ing forms meet (cache/caches/cached/caching).
 * Not a full Porter stemmer; queries and documents share it, so only consistency matters.
 */
export function stem(word: string): string {
  if (word.length < 4 || !/^[a-z]+$/.test(word)) return word;
  let w = word;
  if (w.length > 4 && /i(es|ed)$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (/[^isu]s$/.test(w)) w = w.slice(0, -1);
  const base = w.match(/^(.+?)(?:ing|ed)$/)?.[1];
  if (base && base.length >= 3 && /[aeiouy]/.test(base)) {
    // running -> run, embedding -> embed; keep doubled l/s/z/f and short stems such as add.
    return base.length >= 4 && /([^aeioulszf])\1$/.test(base) ? base.slice(0, -1) : base;
  }
  return w.length >= 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

/** Split camelCase, PascalCase, acronyms and snake_case; acronym plurals (APIs, IDs) lose the s. */
function identifierParts(word: string): string[] {
  return word.replace(/([A-Z]{2,})s(?=[A-Z_\d]|$)/g, '$1')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/).filter(Boolean);
}

function wordTerms(word: string, out: string[]): void {
  const parts = identifierParts(word).map(part => part.toLowerCase());
  const whole = parts.join(word.includes('_') ? '_' : '');
  // Keep the compound so exact identifiers rank above documents that only share their parts.
  const candidates = parts.length > 1 ? [whole, ...parts] : parts;
  for (const term of candidates) {
    if (term.length < 2 || STOP_WORDS.has(term)) continue;
    out.push(stem(term));
  }
}

/** Search terms with repetition (term frequency matters to BM25). */
export function searchTerms(text: string): string[] {
  const out: string[] = [];
  text.normalize('NFKC').split(UNSPACED_RUN).forEach((segment, index) => {
    if (index % 2 === 1) {
      const chars = [...segment];
      if (chars.length === 1) out.push(chars[0]);
      for (let at = 1; at < chars.length; at++) out.push(chars[at - 1] + chars[at]);
      return;
    }
    for (const [word] of segment.matchAll(WORD)) wordTerms(word, out);
  });
  return out;
}

export interface Bm25Options {
  /** Term-frequency saturation. */
  k1: number;
  /** Document-length normalization, 0 (none) to 1 (full). */
  b: number;
}

export interface Bm25Hit { index: number; score: number }

export class Bm25Index {
  private readonly frequencies: Map<string, number>[];
  private readonly lengths: number[];
  private readonly documentFrequency = new Map<string, number>();
  private readonly averageLength: number;

  constructor(documents: string[][], private readonly options: Bm25Options = { k1: 1.2, b: 0.75 }) {
    this.frequencies = documents.map(terms => {
      const counts = new Map<string, number>();
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      for (const term of counts.keys()) this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      return counts;
    });
    this.lengths = documents.map(terms => terms.length);
    this.averageLength = this.lengths.reduce((sum, length) => sum + length, 0) / (documents.length || 1) || 1;
  }

  get size(): number { return this.frequencies.length; }

  /** Lucene's non-negative idf, so a term found in most documents still adds a little. */
  private idf(term: string): number {
    const n = this.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (this.size - n + 0.5) / (n + 0.5));
  }

  /** One score per document, in document order; 0 when a document shares no query term. */
  scores(query: string[]): number[] {
    const { k1, b } = this.options;
    const terms = [...new Set(query)].filter(term => this.documentFrequency.has(term));
    return this.frequencies.map((counts, index) => {
      const norm = k1 * (1 - b + b * this.lengths[index] / this.averageLength);
      let score = 0;
      for (const term of terms) {
        const tf = counts.get(term);
        if (tf) score += this.idf(term) * tf * (k1 + 1) / (tf + norm);
      }
      return score;
    });
  }

  /** Highest-scoring documents first; ties keep document order. */
  search(query: string[], limit: number): Bm25Hit[] {
    return this.scores(query).map((score, index) => ({ index, score }))
      .filter(hit => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit);
  }
}
