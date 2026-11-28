# 0001. Bundle a distilled static embedding model for memory recall

- **Status:** Accepted
- **Date:** 2026-11-28
- **Related:** [0002](0002-memory-recall-ranking.md) (how its scores are combined with BM25)

## Context

`recall_memory` ranked memory entries with BM25 alone, so a query that describes a topic in other words than
the entry uses finds nothing. Adding semantic similarity needs an embedding model that:

1. supports **Chinese and English** in one model, but only **monolingually** (Chinese queries over Chinese
   memory, English over English); cross-language retrieval is not a requirement;
2. runs with **near-zero latency** and can embed large batches (whole memory files) without a GPU;
3. **ships inside the npm package** with no native or WASM runtime, so installation stays as portable as it is.

## Options

| Option | Size | Runtime |
|---|---|---|
| Model2Vec static model distilled from `jinaai/jina-embeddings-v2-base-zh` (zh/en bilingual teacher), 256 dims, int8 | 15.5 MB weights + 1.4 MB tokenizer | table lookup + mean, plain TypeScript |
| Same, further trained with tokenlearn on zh+en text | 15.5 MB + 1.4 MB | same |
| `minishlab/potion-multilingual-128M` (official static model, bge-m3 teacher, 101 languages) | 128 MB at int8/256d, 64 MB at int8/128d | same |
| `BAAI/bge-small-zh-v1.5` transformer, ONNX int8 | 23.9 MB | onnxruntime (native addon or WASM) |
| Teacher `jina-embeddings-v2-base-zh` itself (reference only) | ~640 MB fp32 | transformer runtime |

Ruled out earlier without benchmarks: transformer models of 100M+ parameters (multilingual-e5-small,
EmbeddingGemma: 120-300 MB and millisecond-level latency) and the existing multilingual static models aimed at
similarity rather than retrieval (`static-similarity-mrl-multilingual-v1`).

## Evaluation

### Data

- **Monolingual set** (`embedding/scripts/eval_data.py`): 24 Chinese and 24 English technical-documentation
  passages with 25 queries each. Queries are mostly paraphrases sharing few words with their target, so they
  measure semantic recall rather than literal overlap. Written by the author of this ADR, one gold passage per
  query.
- **Cross-language smoke test** (`embedding/scripts/smoke_test.py`): 8 mixed zh/en passages, 11 queries, several
  of them cross-language. Kept for the record; cross-language matching turned out not to be a requirement.

### Monolingual retrieval (top-1 / recall@3 / MRR, embedding alone)

Reproduce: `python embedding/scripts/eval_monolingual.py` (environment: `embedding/scripts/requirements.txt`).

| Model | Size | Chinese | English |
|---|---|---|---|
| BM25 baseline (character bigrams / lowercase words) | 0 | 48% / 64% / 0.57 | 24% / 36% / 0.34 |
| jina distill, int8 256d | 15.5 MB | 72% / 84% / 0.80 | 32% / 64% / 0.53 |
| **jina distill + tokenlearn, int8 256d (shipped)** | **15.5 MB** | 64% / **92%** / 0.78 | **48% / 72% / 0.62** |
| potion-multilingual-128M, int8 256d | 128 MB | 68% / 76% / 0.74 | 48% / 64% / 0.62 |
| potion-multilingual-128M, int8 128d | 64 MB | 60% / 68% / 0.68 | 32% / 56% / 0.49 |
| bge-small-zh-v1.5, ONNX int8 | 23.9 MB | 76% / 88% / 0.83 | 28% / 52% / 0.44 |
| bge-small-zh-v1.5, ONNX int8 + BAAI query instruction | 23.9 MB | 72% / 88% / 0.81 | 20% / 44% / 0.38 |
| [reference] jina-v2-base-zh teacher | ~640 MB | 88% / 96% / 0.93 | 76% / 92% / 0.85 |

Mean MRR over both languages: shipped 0.70, potion 256d 0.68, plain distill 0.665, bge-small 0.635.

### Cross-language smoke test (top-1 of 11)

jina distill 4/11, potion-multilingual (all variants) 7/11, bge-small-zh 7/11 (8/11 with the query
instruction), teacher 11/11. Every small model fails most cross-language queries without literal overlap.

### Throughput (Apple M2 CPU)

| Model | Short text (~17-20 tokens) | Long chunk (~480 tokens) |
|---|---|---|
| Static models (jina distill, potion) | 60,000-300,000 texts/s (Python, model2vec) | barely changes with length |
| Shipped model in TypeScript (`src/mcp/staticEmbedding.ts`) | ~11,500 Wikipedia paragraphs/s, cold word cache | — |
| bge-small-zh ONNX int8 (onnxruntime) | 1,059 texts/s | 34 texts/s (10,000 chunks ≈ 5 min) |
| bge-small-zh ONNX fp32 | 480 texts/s | 18 texts/s |
| jina teacher (PyTorch CPU) | ~200 texts/s | — |

int8 quantization changed no result of any static or ONNX model compared with fp32.

### How the shipped model was built

Scripts in `embedding/scripts/`; corpus and features are written to gitignored `embedding/data/`.

1. `distill.py`: Model2Vec distillation of `jinaai/jina-embeddings-v2-base-zh`, PCA to 256 dims (60,513-token
   vocabulary; ~70 s on CPU). jina's remote code requires `transformers<5`; model2vec disables MPS on
   torch ≥ 2.8, so distillation runs on CPU.
2. `prepare_corpus.py`: 60,000 Chinese and 60,000 English Wikipedia paragraphs
   (`wikimedia/wikipedia` shards `20231101.zh/train-00002` and `20231101.en/train-00028`).
3. `featurize_teacher.py`: teacher sentence embeddings (masked mean pooling) for all 120,000 paragraphs on MPS
   (about 70 minutes). Replaces `tokenlearn.featurize`, which needs sentence-transformers 6 / transformers 5.
4. `train_tokenlearn.py`: tokenlearn's `train_model` (target PCA kept 97% of variance; 16 epochs on CPU until
   validation MSE stopped improving at 0.009), then int8 quantization. No vocabulary is added (tokenlearn's word
   splitter would add whole Chinese clauses), and the `[PAD]` lookup is patched to jina's `<pad>` (id 0).

### TypeScript runtime parity

`src/mcp/staticEmbedding.ts` reimplements the tokenizer (NFC + lowercase normalizer, Whitespace pre-tokenizer,
BPE) and mean pooling. On 3,232 texts (Wikipedia paragraphs, the eval sets, this repository's memory files and
edge cases such as empty strings, emoji, full-width and combining characters) token ids matched model2vec
exactly and vectors agreed to a worst cosine of 0.999998. The model loads in 40-80 ms once per process.
`tests/mcp/staticEmbedding.test.ts` pins this against a golden fixture.

### Caveats

- 25 queries per language: one query moves top-1 or recall by 4 points, so differences of one or two queries
  are ties (for example the shipped model vs bge-small-zh on Chinese).
- Queries and gold labels were written by the same person who ran the comparison.
- The corpus is general Wikipedia text, not technical documentation.

## Decision

Ship the tokenlearn-trained static model, `embedding/models/m2v-jina-zh-256-tl-int8`, inside the npm package
and run it with the dependency-free TypeScript runtime.

- It has the best mean quality of the small models (English clearly ahead of every other small option, Chinese
  tied with bge-small-zh) at the smallest size.
- Static inference is three orders of magnitude faster than bge-small-zh on long text and needs no
  onnxruntime, so embedding whole memory files on every content change costs nothing noticeable.
- bge-small-zh is not better on Chinese within the precision of this evaluation and is clearly worse on English.

## Consequences

- The package grows to about 13.6 MB compressed / 36.5 MB unpacked.
- Semantic matching works only within a language. This repository's memory is English, so Chinese queries
  against it get little help.
- The static model is far behind its teacher, especially on English paraphrases (MRR 0.62 vs 0.85). Likely
  improvements, none measured yet: technical-domain training text, 384 or 512 dimensions (about 23-31 MB), and a
  larger evaluation set.
- The plain distill `embedding/models/m2v-jina-zh-256-int8` is kept for comparison in the eval scripts; it is not
  used at runtime and not packaged.
