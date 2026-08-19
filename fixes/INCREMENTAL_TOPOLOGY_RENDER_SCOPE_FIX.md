# Incremental Topology Render Scope Fix

## Summary

An incremental refresh that changed both root-level files and files in another
directory could render every partition chart after any split, merge, or route
change. On a large workspace, a batch that should have refreshed five charts
prepared and rendered all 3,109 charts.

## Observed symptom

The render telemetry exposed the mismatch:

```text
[Render] prepared 3109 chart tasks / 28225 file nodes in 14865.92ms
Rendering 3109 partition charts...
...
Incremental partition pipeline rendered 5 chart(s); topology changed: true.
```

The final line was misleading: it reported the ordinary affected-owner set,
not the charts actually rendered by the topology path.

## Root cause

When topology changed, the incremental partitioner collected all changed
physical directories, old owners, and new owners, then selected their common
physical ancestor as the rebuild boundary. A batch containing root files such
as `.gitignore` or `AGENTS.md` and files under `demo/` therefore had `.` as
its common ancestor.

The boundary rebuilder interpreted `.` as the whole chart output directory:
it removed `.memoryanchor/chart/` and regenerated every current chart. The
topology change could have been local to `demo/`; the presence of an unrelated
root-level change widened it to a full render.

## Fix

Topology reconciliation now compares the previous and next chart snapshots
directly. It renders only charts that are newly owned, change between shallow
and recursive scope, or have changed `Child Charts` routes. The usual changed
owners, dirty reverse-call targets, and dirty importers are added to that same
set.

Former owners are removed one generated `chart.md` at a time, pruning only
empty output directories. This preserves sibling chart outputs and avoids any
root-wide reset during an incremental refresh.

The compatibility boundary-rebuild API remains available for callers that do
not have a previous topology snapshot; the incremental path always has both
snapshots and uses the precise reconciliation path.

## Diagnostics

The completion record now reports actual work:

```text
Incremental partition pipeline completed: rendered 5 chart(s), removed 1 obsolete chart(s); topology changed: true.
```

This agrees with the render-stage task count and distinguishes chart writes
from obsolete-chart removals.

## Verification

`tests/chart/partitionedChartIncremental.test.js` creates a mixed batch with
a root-level edit and a child-directory split. It fixes the timestamp of an
unrelated sibling chart and verifies that the topology refresh leaves it
untouched. `tests/chart/debugLogging.test.js` verifies the completion count
format.

Run:

```bash
npm test
```
