/**
 * Result selection for memory recall: keyword (BM25) matches first, in BM25 order, plus a few reserved places for
 * entries found by meaning (embedding cosine) alone. See docs/adr/0002-memory-recall-ranking.md.
 *
 * Keyword matches take `limit - semanticSlots(limit)` places, so those places are exactly BM25's own top results
 * and keyword ranking is never reordered. The reserved places hold the most similar entries that share no term
 * with the query and clear a similarity floor. Places one side cannot fill go to the other: with few keyword
 * matches meaning-only entries fill the list, and without confident meaning-only entries BM25 fills it.
 * Score-level fusion (reciprocal rank fusion) was measured and rejected because it moved some correct keyword
 * matches down on this repository's own memory.
 */

/**
 * Places reserved for meaning-only entries. Measured without a regression against BM25 at limits 5 (1 place)
 * and 8 (2 places); at limit 3 a reserved place pushed out keyword matches, so small limits reserve none.
 */
export function semanticSlots(limit: number): number {
  return Math.floor(limit / 4);
}

/**
 * Minimum cosine for an entry found by meaning alone. Results carry complete entries, so padding them with
 * unrelated ones costs the caller context. Calibrated on embedding/scripts/eval_data.py for the shipped model:
 * unrelated text pairs mostly score below 0.2 (median 0.17-0.2), so next to keyword matches a meaning-only
 * entry must clear that; when nothing matches by keyword, only near-orthogonal entries are dropped.
 */
export const MIN_SIMILARITY_WITH_KEYWORDS = 0.2;
export const MIN_SIMILARITY_WITHOUT_KEYWORDS = 0.1;

export interface RecallHit {
  index: number;
  /** keyword: shares a search term with the query (bm25 is set); meaning: found by similarity alone. */
  match: 'keyword' | 'meaning';
  bm25?: number;
  /** Set when semantic ranking ran and the entry has an embedding. */
  similarity?: number;
}

/** Indices passing `keep`, best value first; ties keep document order. */
function ranked(values: number[], keep: (index: number) => boolean): number[] {
  return values.map((value, index) => ({ value, index })).filter(({ index }) => keep(index))
    .sort((a, b) => b.value - a.value || a.index - b.index).map(({ index }) => index);
}

/**
 * @param bm25 One score per document; 0 means no shared term.
 * @param similarity One cosine per document, null for a document without an embedding; omit the array when
 *   semantic ranking is unavailable, which reduces this to BM25's top `limit`.
 */
export function selectRecallHits(bm25: number[], similarity: (number | null)[] | null, limit: number): RecallHit[] {
  const keyword = ranked(bm25, index => bm25[index] > 0);
  const floor = keyword.length ? MIN_SIMILARITY_WITH_KEYWORDS : MIN_SIMILARITY_WITHOUT_KEYWORDS;
  const meaning = similarity
    ? ranked(similarity.map(value => value ?? -Infinity), index => !(bm25[index] > 0)
      && similarity[index] !== null && similarity[index]! >= floor)
    : [];
  const meaningTaken = Math.min(meaning.length, Math.max(semanticSlots(limit), limit - keyword.length));
  const keywordTaken = Math.min(keyword.length, limit - Math.min(meaningTaken, semanticSlots(limit)));
  const cosine = (index: number) => {
    const value = similarity?.[index];
    return value !== null && value !== undefined ? { similarity: value } : {};
  };
  return [
    ...keyword.slice(0, keywordTaken).map((index): RecallHit => ({ index, match: 'keyword', bm25: bm25[index], ...cosine(index) })),
    ...meaning.slice(0, meaningTaken).map((index): RecallHit => ({ index, match: 'meaning', ...cosine(index) })),
  ].slice(0, limit);
}
