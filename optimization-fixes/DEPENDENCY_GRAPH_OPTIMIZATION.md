# Dependency Graph Performance Optimization

## Summary

Chart initialization became unnecessarily slow on large workspaces because the original AI-generated implementation discarded structural information that Tree-sitter already knew, then reconstructed that information through repeated scans on the main thread.

The new implementation attaches deduplicated forward calls directly to their containing symbols during the worker's single AST traversal. After parsing, reverse dependencies are produced with path-qualified symbol indexes, per-file import-alias indexes, and caller-identity maps keyed by source path and symbol position.

## Problem in the Original AI-Generated Implementation

The parser worker traversed the complete Tree-sitter AST, but represented calls as a flat file-level array:

```ts
calls: { name: string; startIndex: number }[]
```

This representation discarded the fact that, while descending into a function or another symbol, Tree-sitter already provides enough structure to know which symbol contains each call.

The main thread then attempted to recover that lost relationship inside `buildChartDependencyGraph`:

1. For every import binding, it linearly searched the target file's symbols with `find`.
2. For every binding, it scanned every call in the source file.
3. For every matching call, it scanned the source file's symbols with `filter`.
4. It sorted the matching symbols by range size to recover the innermost caller.
5. It used array `includes` to deduplicate each target symbol's reverse-dependency list.

This repeated work was especially expensive for files containing many imports, functions, and call sites. It also transferred a position record for every call from worker threads to the main thread, even though only deduplicated function-level relationships were needed.

## Complexity of the Original Implementation

For one source file, define:

- `B`: number of import bindings.
- `C`: number of file-level call records.
- `S_s`: number of symbols in the source file.
- `S_t`: number of symbols in a target file.
- `R`: current length of a target symbol's reverse-dependency array.
- `M`: number of calls that match an import binding.

The reverse-dependency phase had the following complexity:

```text
O(B * S_t + B * C + M * (S_s log S_s + R))
```

The terms came from:

- `B * S_t`: repeated target-symbol `find` operations.
- `B * C`: rescanning all source calls for every import binding.
- `M * S_s log S_s`: filtering and sorting source symbols for every matched call.
- `M * R`: array-based reverse-edge deduplication.

In the worst case, `M = B * C`, producing:

```text
O(B * (S_t + C * (S_s log S_s + R)))
```

The implementation therefore scaled far worse than the number of actual dependency edges.

## How I Found the Issue

I noticed that chart initialization slowed down sharply as workspace size increased. I followed the chart-generation path and inspected `buildChartDependencyGraph` directly instead of assuming Tree-sitter parsing was the bottleneck.

The nested flow made the problem visible:

```text
dependency -> binding -> every call
```

Inside that loop, the implementation also performed:

```text
targetSymbol.find
getContainingSymbol(filter + sort)
dependedOnBy.includes
```

This showed that the dependency inversion phase repeatedly searched data that could have been indexed once. The key observation was that the Tree-sitter traversal already enters function bodies with the containing symbol known. Recovering the caller later from `startIndex` was unnecessary.

## Solution

### 1. Preserve Function Ownership in the Worker

The worker now carries the nearest containing symbol through the recursive AST traversal. When it encounters a call, it writes the bare call name directly to that symbol:

```ts
symbol.forwardDependencies: string[]
```

A worker-local `Set` deduplicates repeated calls from the same symbol. The file-level `calls` array and its position records are no longer generated or transferred.

Conceptually, the worker produces:

```text
caller() -> [sample1, sample2]
```

instead of:

```text
file calls -> [
  { name: sample1, startIndex: ... },
  { name: sample2, startIndex: ... }
]
```

### 2. Index Every Target Symbol Once

After parsing, the main thread builds a hash table using both the normalized file path and symbol name:

```text
(target file path, exported symbol name) -> target symbol
```

The file path is part of the key because symbol names are not globally unique. This prevents same-named exports from different files from being merged accidentally.

### 3. Resolve Import Aliases Once Per Source File

Each source file receives a second hash table:

```text
local import alias -> target symbol
```

This preserves alias semantics such as:

```ts
import { shared as selected } from "./dependency.js";
```

A forward dependency on `selected` can therefore resolve to the path-qualified `shared` symbol in constant average time.

### 4. Write Reverse Dependencies Directly Without Caller-Name Collisions

The main thread traverses each symbol's deduplicated forward dependencies once. Every dependency performs:

1. One average `O(1)` alias lookup.
2. One average `O(1)` insertion into the target symbol's reverse-dependency `Map`.

The reverse map uses this identity:

```text
(normalized source file path, caller start offset) -> caller
```

It does not use the rendered caller name as the key. Consequently, two files that both declare `run()` remain distinct callers, as do two same-named methods within one file.

Formatting uses two linear passes over each target symbol's reverse edges:

1. Hash-count the bare caller labels and the `(source path, label)` pairs.
2. Keep unique labels compact, qualify cross-file collisions with their paths, and add source range/offset information only for same-file duplicate names.

For example:

```text
shared() <- src/a.ts:run(); src/b.ts:run()
```

No sorting, symbol scanning, or array membership lookup is introduced.

Cross-chart forward edges (`->`) and chart-local reverse edges (`<-`) retain their previous semantics.

## Complexity of the New Implementation

Define:

- `N`: total number of Tree-sitter AST nodes.
- `C_raw`: total number of raw call occurrences.
- `S`: total number of parsed symbols.
- `D`: total number of file imports.
- `B`: total number of import bindings.
- `E`: total number of deduplicated function-level forward dependencies.

Worker extraction now costs:

```text
O(N + C_raw)
```

Main-thread dependency inversion costs:

```text
O(S + D + B + E)
```

Hash lookups and map insertions are average `O(1)`. The two collision-formatting passes add `O(E)` work, so the global bound remains unchanged. Additional space usage is:

```text
O(S + B + E)
```

The new implementation scales linearly with the parsed symbols, imports, bindings, and actual deduplicated dependency edges. It no longer scales with repeated combinations of bindings, all file-level calls, symbol-range scans, or reverse-array lengths.

## Correctness Coverage

Regression tests cover:

- Deduplication when one function calls the same dependency multiple times.
- Direct worker attribution of forward calls to their containing symbol.
- Import aliases.
- Isolation of same-named exported functions by resolved file path.
- Preservation and path qualification of same-named callers from different files.
- Position-qualified isolation of duplicate caller names within one file.
- Preservation of repository-wide forward file edges.
- Preservation of chart-local reverse symbol edges.
