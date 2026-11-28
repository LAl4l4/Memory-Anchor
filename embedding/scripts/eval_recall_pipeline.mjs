// Evaluate recall ranking strategies against the shipped selection (dist/mcp: bm25.ts tokenizer + Bm25Index,
// staticEmbedding.ts, hybridRank.ts selectRecallHits) rather than the Python approximations in eval_monolingual.py.
//
// Input: JSON {sets: {name: {docs: string[], queries: [text, gold][]}}} files; gold is a doc index or an array
// of acceptable indices (overlapping entries), and the best-placed one counts. Build them with
// `python eval_data.py > ../data/eval_sets.json` and `node build_ma_memory_eval.mjs`.
// For each set and strategy prints MRR@limit / recall@limit (gold anywhere in the returned list), then the mean
// over sets whose name does not contain "cross-language", and per query how often each strategy places the
// gold worse or better than BM25 alone at the same limit (missing counts as worst).
//
// Usage (after npm run build): node eval_recall_pipeline.mjs <sets.json>... [--limit 5] [--misses <strategy>]
//   --misses lists the strategy's queries without the gold at rank 1 and those it ranks worse than BM25.
import { readFileSync } from 'node:fs';
import { Bm25Index, searchTerms } from '../../dist/mcp/bm25.js';
import { cosine, loadDefaultEmbedding } from '../../dist/mcp/staticEmbedding.js';
import { MIN_SIMILARITY_WITH_KEYWORDS, MIN_SIMILARITY_WITHOUT_KEYWORDS, selectRecallHits } from '../../dist/mcp/hybridRank.js';

/** Reciprocal rank fusion constant for the score-fusion strategies kept for comparison (ADR 0002). */
const RRF_K = 60;

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const limit = Number(option('--limit') ?? 5);
const missesFor = option('--misses');
const sets = Object.assign({}, ...args.map(file => JSON.parse(readFileSync(file, 'utf8')).sets));
const model = await loadDefaultEmbedding();
if (!model) throw new Error('embedding model failed to load; run npm run build first');

/** Indices passing `keep`, best value first; ties keep document order. */
const order = (values, keep) => values.map((value, index) => ({ value, index })).filter(({ value, index }) => keep(value, index))
  .sort((a, b) => b.value - a.value || a.index - b.index).map(({ index }) => index);

/** Reciprocal rank fusion over every keyword match plus floor-passing top-`limit` similar entries, semantic term scaled by `weight`. */
function weightedRrf(bm25, similarity, weight) {
  const lexical = order(bm25, value => value > 0);
  const semantic = order(similarity.map(value => value ?? -Infinity), (_, index) => similarity[index] !== null);
  const lexicalRank = new Map(lexical.map((index, at) => [index, at + 1]));
  const semanticRank = new Map(semantic.map((index, at) => [index, at + 1]));
  const floor = lexical.length ? MIN_SIMILARITY_WITH_KEYWORDS : MIN_SIMILARITY_WITHOUT_KEYWORDS;
  const candidates = new Set(lexical);
  semantic.slice(0, limit).forEach(index => { if (similarity[index] >= floor) candidates.add(index); });
  const score = index => (lexicalRank.has(index) ? 1 / (RRF_K + lexicalRank.get(index)) : 0)
    + weight * (semanticRank.has(index) ? 1 / (RRF_K + semanticRank.get(index)) : 0);
  return [...candidates].sort((a, b) => score(b) - score(a) || bm25[b] - bm25[a] || a - b).slice(0, limit);
}

/**
 * Keyword matches in BM25 order fill limit - slots places; the `slots` most similar entries without a keyword
 * match (above the similarity floor) follow. Places one side leaves empty go to the other.
 */
function reservedSlots(bm25, similarity, slots) {
  const lexical = order(bm25, value => value > 0);
  const floor = lexical.length ? MIN_SIMILARITY_WITH_KEYWORDS : MIN_SIMILARITY_WITHOUT_KEYWORDS;
  const meaningOnly = order(similarity.map(value => value ?? -Infinity),
    (_, index) => similarity[index] !== null && similarity[index] >= floor && !(bm25[index] > 0));
  const semantic = meaningOnly.slice(0, Math.max(slots, limit - lexical.length));
  return [...lexical.slice(0, limit - Math.min(semantic.length, slots)), ...semantic].slice(0, limit);
}

const strategies = {
  'BM25 only': bm25 => order(bm25, value => value > 0).slice(0, limit),
  'semantic only': (bm25, similarity) => selectRecallHits(bm25.map(() => 0), similarity, limit).map(hit => hit.index),
  'shipped': (bm25, similarity) => selectRecallHits(bm25, similarity, limit).map(hit => hit.index),
  'RRF w=1': (bm25, similarity) => weightedRrf(bm25, similarity, 1),
  'RRF w=0.25': (bm25, similarity) => weightedRrf(bm25, similarity, 0.25),
  'BM25 + 1 slot': (bm25, similarity) => reservedSlots(bm25, similarity, 1),
  'BM25 + 2 slots': (bm25, similarity) => reservedSlots(bm25, similarity, 2),
};

const width = 16;
console.log(`limit ${limit}: MRR / recall@${limit}`);
console.log('set'.padEnd(44) + Object.keys(strategies).map(name => name.padStart(width)).join(''));
const totals = Object.fromEntries(Object.keys(strategies).map(name => [name, { mrr: 0, recall: 0 }]));
let averaged = 0;
const misses = [];
const worseThanBm25 = [];
const versus = Object.fromEntries(Object.keys(strategies).map(name => [name, { worse: 0, better: 0 }]));
for (const [setName, { docs, queries }] of Object.entries(sets)) {
  const index = new Bm25Index(docs.map(searchTerms));
  const vectors = docs.map(doc => model.embed(doc));
  const inAverage = !setName.includes('cross-language');
  if (inAverage) averaged++;
  const rankOf = {};
  const cells = Object.entries(strategies).map(([name, rank]) => {
    rankOf[name] = [];
    let mrr = 0;
    let recall = 0;
    for (const [query, gold] of queries) {
      const queryVector = model.embed(query);
      const similarity = vectors.map(vector => (vector && queryVector ? cosine(queryVector, vector) : null));
      const terms = searchTerms(query);
      const hits = terms.length ? rank(index.scores(terms), similarity) : [];
      const golds = Array.isArray(gold) ? gold : [gold];
      const at = hits.findIndex(hit => golds.includes(hit));
      if (at >= 0) { mrr += 1 / (at + 1); recall++; }
      rankOf[name].push(at < 0 ? Infinity : at + 1);
      if (name === missesFor && at !== 0) misses.push(`  [${setName}] ${at < 0 ? 'missing' : `rank ${at + 1}`}  ${query}`);
    }
    mrr /= queries.length;
    recall /= queries.length;
    if (inAverage) { totals[name].mrr += mrr; totals[name].recall += recall; }
    return `${mrr.toFixed(2)} / ${Math.round(recall * 100)}%`.padStart(width);
  });
  console.log(setName.padEnd(44) + cells.join(''));
  for (const name of Object.keys(strategies)) {
    rankOf[name].forEach((rank, at) => {
      const base = rankOf['BM25 only'][at];
      if (rank > base) {
        versus[name].worse++;
        if (name === missesFor) worseThanBm25.push(`  [${setName}] BM25 rank ${base}, now ${rank === Infinity ? 'missing' : `rank ${rank}`}  ${queries[at][0]}`);
      } else if (rank < base) versus[name].better++;
    });
  }
}
if (averaged) {
  console.log(`mean of ${averaged} sets (cross-language excluded)`.padEnd(44) + Object.values(totals)
    .map(({ mrr, recall }) => `${(mrr / averaged).toFixed(2)} / ${Math.round(recall / averaged * 100)}%`.padStart(width)).join(''));
}
const total = Object.values(sets).reduce((sum, set) => sum + set.queries.length, 0);
console.log(`queries ranked worse / better than BM25 (of ${total})`.padEnd(44) + Object.values(versus)
  .map(({ worse, better }) => `${worse} / ${better}`.padStart(width)).join(''));
if (misses.length) console.log(`\nmisses for ${missesFor}:\n${misses.join('\n')}`);
if (missesFor) console.log(`\nranked worse than BM25 by ${missesFor}:\n${worseThanBm25.join('\n') || '  none'}`);
