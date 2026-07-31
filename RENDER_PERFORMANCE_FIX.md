# Partition Render Performance Regression Fix

## Summary

`anchor init` could spend over a minute in Stage 4 when rendering a large,
heavily partitioned repository, even though the measured rendering CPU and
write time were only a few seconds. This document records the regression, its
root causes, and the fix.

## Observed symptom

On a Next.js workspace with 24,602 source files and 3,108 chart partitions:

```text
[Render] workers wall=64759.50ms
cpu-sum dependency=901.69ms skeleton=122.03ms nodes=105.30ms
assembly=4.46ms write=1488.38ms, max-task=155.84ms
```

The gap between the 64.8-second wall time and the small in-worker timings
showed that the bottleneck was outside the chart-content formatter itself.

## Root causes

1. Each render worker received a structured clone of the complete project-wide
   reverse dependency registry. Every chart task also crossed the worker
   boundary with its FileNodes and directory groups.
2. Stage 4 created a dependency-path Set relative to every chart's source
   directory. For 3,108 charts and 24,602 source paths, that meant roughly
   76 million repeated relative-path conversions. This work occurred before
   the worker's dependency timing began, so it was absent from the reported
   CPU subtotals.

Stage 3 did not show the same regression because it already supplied its
workers with one reusable root-relative dependency-path Set.

## Fix

- Full partition rendering is now in-process. It reuses the immutable reverse
  registry and the build-scoped parse cache on the main V8 heap.
- A single root-relative dependency-path Set is built for the Stage 4 batch.
  Each chart receives a lightweight lookup that prefixes a local candidate
  path before testing the shared Set; no per-chart full Set is allocated.
- `getChartFileNodes` deep-copies symbols, dependencies, and import bindings
  that rendering mutates, keeping chart tasks isolated from the shared parse
  cache.
- The worker-backed chart pool remains in use for partition sizing, where the
  shared root lookup is already available and the measured cost is low.

## Expected result

Stage 4 should now track its actual rendering and synchronous write cost,
rather than worker startup, structured cloning, and repeated dependency-path
normalization. On the affected workspace, the render phase is expected to
fall from roughly 68 seconds to a small number of seconds; rerun `anchor init`
against that workspace to capture the exact post-fix timing.

## Verification

```bash
npm test
```

The complete test suite passes: 18 suites and 150 tests.
