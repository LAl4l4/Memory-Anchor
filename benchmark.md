# Benchmark

This document records a representative `anchor init` run against the
[Next.js](https://github.com/vercel/next.js) repository. It is a single-run
snapshot, not a cross-machine comparison or a performance guarantee.

## Latest incremental benchmark (2026/08/17)

The benchmark ran against an isolated copy of
`../MAtest/nextjs/next.js`, using the persisted chart registry and the complete
v2 dependency graph produced by the current full-build pipeline. The target
working tree was not modified.

### Full-build baseline

| Item | Result |
| --- | ---: |
| Source files parsed | 24,603 |
| Directories sized | 11,848 |
| Chart partitions written | 3,108 |
| File nodes rendered | 28,222 |
| **Total initialization time** | **13.21 s** |

| Phase | Time |
| --- | ---: |
| Parse | 8.41 s |
| Project-wide reverse dependency index | 374 ms |
| Partition sizing | 546 ms |
| Render charts and index | 3.84 s |

### Incremental updates

The first round in each process includes lazy parser-pool startup. The reported
steady-state value is the median of repeated calls in one process, so parser
workers and loaded languages are reused.

| Scenario | Direct file nodes parsed | Charts rendered | Rounds | Median | Compared with full build |
| --- | ---: | ---: | ---: | ---: | ---: |
| One changed file (`server/web/exports/index.ts`) | 1 | 1 | 5 | 494 ms | 26.8× faster |
| Ten-file directory (`server/route-matcher-providers`) | 10 | 1 | 3 | 488 ms | 27.1× faster |
| Fifty-five-file directory (`server/next-server.ts` owner) | 55 | 1 | 3 | 601 ms | 22.0× faster |
| Cross-chart caller change (temporary isolated fixture) | 71 | 2 | 1 | 1.30 s | 10.1× faster |

The final chart render itself remained in the millisecond range. Most of the
incremental wall time is fixed work around direct-directory enumeration,
incremental parsing, dependency-graph reconciliation, and chart preparation.

The benchmark commands must be run from an `.mjs` file (or another file-based
entry point). Running the parent with `node --input-type=module -e ...` causes
Node to inherit an invalid `--input-type` flag in file-based workers; the
worker-pool fix and regression test are recorded in the changelog below.

## Historical full-build snapshot

The original snapshot below is retained for comparison with the latest run.

## Environment and workload

| Item | Result |
| --- | ---: |
| Command | `anchor init` |
| Repository | Next.js |
| Machine | MacBook Air (Mac14,2) |
| Chip | Apple M2, 8 cores (4 performance + 4 efficiency) |
| Memory | 16 GB unified memory |
| Operating system | macOS 26.2 (build 25C56) |
| Node.js | v24.11.0 |
| Source files parsed | 24,602 |
| Directories sized | 11,848 |
| Chart partitions written | 3,108 |
| File nodes rendered | 28,221 |

## Results

| Phase | Time |
| --- | ---: |
| Parse | 9.31 s |
| Project-wide reverse dependency index | 438 ms |
| Partition sizing | 639 ms |
| Render charts and index | 2.94 s |
| **Total initialization time** | **13.33 s** |

The render phase prepared 3,108 chart tasks in 1.55 s, rendered them in-process
in 842 ms wall-clock time, and spent 410 ms writing chart files. The reported
render CPU subtimings overlap, so they should not be added to the phase wall
time.

## Raw CLI output

```text
[Memory Anchor] Compiling partitioned repository architecture...
[Memory Anchor] Parsing 24602 source files...
[Memory Anchor] [Stage 1/4] parse finished in 9310.68ms
[Memory Anchor] Indexing project-wide reverse dependencies...
[Memory Anchor] [Stage 2/4] reverse dependency finished in 438.07ms
[Memory Anchor] Sizing 11848 directories for chart partitions...
[Memory Anchor] [Stage 3/4] partition finished in 639.03ms
[Memory Anchor] [Render] reset chart output in 491.55ms
[Memory Anchor] [Render] prepared 3108 chart tasks / 28221 file nodes in 1545.47ms
[Memory Anchor] Rendering 3108 partition charts...
[Memory Anchor] [Render] in-process wall=841.95ms, cpu-sum dependency=384.41ms skeleton=17.92ms nodes=14.94ms assembly=0.97ms write=410.16ms, max-task=16.66ms
[Memory Anchor] [Render] wrote chart index in 0.24ms
[Memory Anchor] [Stage 4/4] render finished in 2937.44ms
[Memory Anchor] Partitioned chart index rendered to: .memoryanchor/index.md (3108 charts)
```
