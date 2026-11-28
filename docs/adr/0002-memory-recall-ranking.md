# 0002. Combine BM25 and semantic similarity in `recall_memory`

- **Status:** Accepted
- **Date:** 2026-11-28
- **Related:** [0001](0001-bundled-static-embedding-model.md) (the embedding model)

## Context

`recall_memory({query, kind?, limit?})` returns complete memory entries (guardrails, decisions, project_state
modules), best first. Two signals are available per entry:

- **BM25** over `src/mcp/bm25.ts` terms (identifier splitting, light stemming, CJK character bigrams). It
  scores 0 for an entry that shares no term with the query.
- **Cosine similarity** from the bundled static embedding model (ADR 0001), available for every entry.

**Requirement:** adding semantic similarity must never make a result worse than BM25 alone. Agents are told to
query with module, file and symbol names, and for those queries BM25 is already strong.

Sizes that bound the design, measured on this repository's memory (61 entries):

- An entry is 332 characters at the median, 951 at p90 and 2,568 at most; all 61 total 32,175 characters.
- A query shares at least one term with many entries: 21-23 of 61 at the median, up to 39. Returning every
  keyword match would therefore hand back about a third of all memory per call.
- Results are complete entries, roughly 450-850 characters of JSON each here.

## Options

Common to all options with semantic input: an entry found by meaning alone must clear a cosine floor of 0.2
when some entry matches by keyword and 0.1 when none does, so unrelated entries do not pad results
(calibration in `src/mcp/hybridRank.ts`).

- **A. BM25 only** (before this work).
- **B. Reciprocal rank fusion, equal weight**: score = 1/(60 + BM25 rank) + 1/(60 + semantic rank) over every
  keyword match plus the `limit` most similar entries. Shipped briefly as the first version.
- **C. RRF with a lower semantic weight**: score = 1/(60 + BM25 rank) + w/(60 + semantic rank), w = 0.25 or 0.5.
- **D. BM25 first with reserved places**: keyword matches in BM25 order take `limit - k` places, then the k most
  similar entries without a keyword match; places one side cannot fill go to the other. Measured with fixed
  k = 1 and 2, and with k = ⌊limit/4⌋.
- **E. Every keyword match plus some semantic matches.** Rejected without measurement: about a third of memory per
  call (see Context).

## Evaluation

### Data

1. `zh` and `en`: the monolingual sets of ADR 0001 (24 passages and 25 queries per language, mostly paraphrases;
   `embedding/scripts/eval_data.py`). These favour semantic ranking.
2. **MA memory, keyword queries**: 12 queries written the way the tool description asks (module, file, symbol
   names), over this repository's 61 memory entries.
3. **MA memory, English paraphrases**: 12 queries describing a topic without the entries' wording.
4. **MA memory, Chinese queries**: 4 queries; cross-language against English memory, which the model does not
   target. Reported but excluded from means.

Sets 2-4 are built by `embedding/scripts/build_ma_memory_eval.mjs`. Several gold entries are allowed per query
because entries overlap (for example the Jest guardrail and the Test tooling module); the best-placed one
counts. The built file snapshots memory content, so it stays in gitignored `embedding/data/`.

### Reproduce

```bash
npm run build
cd embedding/scripts
python eval_data.py > ../data/eval_sets.json
node build_ma_memory_eval.mjs
node eval_recall_pipeline.mjs ../data/eval_sets.json ../data/eval_ma_memory.json --limit 8 --misses shipped
```

`eval_recall_pipeline.mjs` runs the shipped tokenizer, BM25 index, embedding runtime and selection from `dist/`
(strategy `shipped`) next to the alternatives above. Metrics are MRR over the returned list and recall@limit
(gold anywhere in the returned list); agents read every returned entry, so recall@limit is the primary metric.
It also counts, per query, whether a strategy places the gold worse or better than BM25 at the same limit
(missing counts as worst); `--misses` lists the regressions.

### Results at limit 8 (BM25 6 places + 2 reserved): MRR / recall@8

| Set | A. BM25 | semantic only | B. RRF w=1 | C. RRF w=0.25 | **D. ⌊limit/4⌋ = 2 places** |
|---|---|---|---|---|---|
| zh (paraphrases) | 0.56 / 68% | 0.78 / 96% | 0.75 / 96% | 0.72 / 96% | **0.69 / 96%** |
| en (paraphrases) | 0.51 / 60% | 0.61 / 84% | 0.71 / 88% | 0.62 / 88% | **0.66 / 88%** |
| MA memory, keyword | 1.00 / 100% | 0.92 / 92% | 0.94 / 100% | 1.00 / 100% | **1.00 / 100%** |
| MA memory, paraphrases | 0.63 / 92% | 0.52 / 83% | 0.63 / 92% | 0.76 / 92% | **0.63 / 92%** |
| Mean of the four | 0.67 / 80% | 0.71 / 89% | 0.76 / 94% | 0.78 / 94% | **0.74 / 94%** |
| MA memory, Chinese (cross-language) | 0.00 / 0% | 0.36 / 75% | 0.36 / 75% | 0.36 / 75% | 0.36 / 75% |
| **Queries worse / better than BM25 (of 78)** | — | 15 / 28 | 7 / 27 | 3 / 24 | **0 / 17** |

### Regressions against BM25 by limit (queries worse / better, of 78)

| Limit | B. RRF w=1 | C. RRF w=0.25 | D. 1 place | D. 2 places | **D. ⌊limit/4⌋ (shipped)** |
|---|---|---|---|---|---|
| 3 | 7 / 22 | 3 / 19 | 5 / 12 | 13 / 15 | **0 / 12** (0 places) |
| 5 | 7 / 25 | 3 / 22 | 0 / 15 | 2 / 16 | **0 / 15** (1 place) |
| 8 | 7 / 27 | 3 / 24 | 0 / 17 | 0 / 17 | **0 / 17** (2 places) |
| 12 | 7 / 29 | 3 / 25 | 0 / 18 | 0 / 18 | **0 / 18** (3 places) |
| 20 | 7 / 31 | 3 / 28 | 0 / 20 | 0 / 20 | **0 / 20** (5 places) |

At limit 3 the shipped rule reserves no place and still beats BM25 on 12 queries: when fewer than three entries
match by keyword, confident meaning-only entries fill the empty places.

### Mean of the four sets by limit, shipped rule: MRR / recall@limit

| Limit | A. BM25 | D. ⌊limit/4⌋ (shipped) |
|---|---|---|
| 3 | 0.67 / 78% | 0.73 / 88% |
| 5 | 0.67 / 80% | 0.74 / 93% |
| 8 | 0.67 / 80% | 0.74 / 94% |
| 12 | 0.67 / 80% | 0.74 / 94% |
| 20 | 0.67 / 80% | 0.74 / 96% |

### Findings

- **Score fusion moves correct keyword matches down.** B is worse than BM25 on 7 of 78 queries at every limit
  (for example "Codex SessionStart JSON" falls from 1st to 4th), C on 3. On this repository's memory (long,
  term-dense English entries) BM25 with stemming is strong while the static model's English is weak (semantic
  only: MRR 0.51-0.54), so any fused score lets similarity overturn some right BM25 orderings. C has the best
  mean MRR but fails the requirement.
- **Reserved places never regressed when sized ⌊limit/4⌋.** Fixed reservations regress at small limits (one place
  at limit 3: 5 queries worse; two places at 5: 2 worse), because they evict keyword matches BM25 had ranked just
  below the cut. A quarter of the limit, rounded down, had no regression at any measured limit.
- **The gains are on paraphrases.** Recall on the synthetic paraphrase sets rises from 68% / 60% to 96% / 88% at
  limit 8. On real memory D equals BM25 (keyword 100%, paraphrases 92%): the one real paraphrase BM25 misses
  ("what happens if two agents change memory at the same time") is not found by similarity either.
- **Result count.** Recall reaches 93% at 5 and 94% at 8. The default rises from 5 to 8 so that two places can be
  reserved without shrinking BM25's share below six, which costs about 60% more output per call
  (about 3,500-7,000 characters of JSON on this memory).

### Caveats

- **No guarantee, only a measured absence of regressions.** The first `limit - ⌊limit/4⌋` places are exactly
  BM25's top results by construction, so recall is never worse than BM25 at that smaller limit. A keyword match
  that BM25 ranks inside the reserved tail (7th or 8th at limit 8) can still be displaced by a meaning-only
  entry; it did not happen on these 78 queries.
- 12-25 queries per set; one query moves MRR by 0.04-0.08 and recall by 4-8 points.
- All queries and gold labels were written by the same person who ran the comparison, and the real-memory sets
  come from a single repository.
- The similarity floors were calibrated on the synthetic sets and were not tuned here.
- The real-memory sets snapshot memory as it was when built. The tables were measured before the recall decision
  in `.memoryanchor/decisions.md` was rewritten for this outcome; rebuilt afterwards, B scores MRR 0.69 on real
  paraphrases and regresses on 6 queries instead of 7, while the shipped rule's results are unchanged.

## Decision

Option **D with ⌊limit/4⌋ reserved places** (`selectRecallHits` in `src/mcp/hybridRank.ts`), default `limit` 8
(BM25 6 + meaning 2), maximum 20:

1. Keyword matches, in BM25 order, take `limit - ⌊limit/4⌋` places.
2. The most similar entries without a keyword match that clear the floor (0.2 with keyword matches, 0.1 without)
   take the reserved places.
3. Places either side cannot fill go to the other.

Each result reports `match` (`keyword` or `meaning`), `bm25` for keyword matches and `similarity` whenever the
model ran; there is no fused score. When no entry matches by keyword, a hint says the results were found by
meaning alone. Without the model the selection is BM25's top `limit` and the response reports `ranking: "bm25"`.

## Consequences

- Keyword ranking keeps its exact order, so agents querying with names see the same leading results as before.
- Calls return up to 8 entries by default instead of 5.
- Meaning-only entries are appended rather than interleaved, so a highly similar entry never outranks a keyword
  match; the cost is that real-memory MRR does not improve (C would have raised paraphrase MRR from 0.63 to 0.76
  at the price of 3 regressions).
- Re-run the evaluation when the model, the tokenizer, the floors or the default limit change, and extend the
  real-memory query sets before tuning further: they are the deciding data and the smallest.
