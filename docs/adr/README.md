# Architecture Decision Records

Each file here records one architectural decision for Memory Anchor's own codebase: the problem, the options
that were weighed, the evidence (benchmarks, measurements) and the outcome. They are kept for maintainers and
reviewers; they are separate from `.memoryanchor/decisions.md`, which is the short decision list injected into
agent sessions.

## Format

- File name: `NNNN-short-title.md`, numbered in order of creation. Numbers are never reused.
- Sections: **Status**, **Context**, **Options**, **Evaluation** (when measurements were taken: data sets,
  commands to reproduce, results, caveats), **Decision**, **Consequences**.
- Status is one of `Proposed`, `Accepted`, `Superseded by NNNN` or `Rejected`. A superseded record is left in
  place and points to its successor instead of being rewritten.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-bundled-static-embedding-model.md) | Bundle a distilled static embedding model for memory recall | Accepted |
| [0002](0002-memory-recall-ranking.md) | Combine BM25 and semantic similarity in `recall_memory` | Accepted |
