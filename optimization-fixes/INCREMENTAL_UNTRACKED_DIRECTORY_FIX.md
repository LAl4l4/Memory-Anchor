# Incremental New-Partition Update Fix

## Summary

Stop and session-end hooks could refresh existing charts without creating
charts for newly created directories. The failure was most visible when a new
directory was added below a split parent: recursive frontier charts could show
the new file incidentally, while shallow split charts omitted the new child
chart and its parent route.

## Root cause

`captureGitChanges()` used the default `git status --porcelain` output. Git
collapses an untracked directory into one directory entry, for example:

```text
?? bench/demo-crosschart/
```

The incremental partitioner expects file paths. It therefore treated the
directory entry as a change to its existing parent, pre-rendered only the
parent's direct files, and never materialized the new directory in the
physical or virtual chart topology.

## Fix

Git status collection now uses:

```text
git status --porcelain --untracked-files=all
```

New directories are expanded to their actual files before entering the
incremental parse, graph reconciliation, pre-render, topology, and final
render stages. The existing owner resolution and boundary rebuild logic can
then create the new chart and update the parent Child Charts route.

## Incremental topology capability

The incremental partitioner itself already handles new charts correctly when
it receives repository-relative file paths. Its existing flow:

1. Lists and parses the changed directory's direct files.
2. Materializes missing physical directory nodes with
   `ensureDirectoryTreeNode()`.
3. Propagates rendered character deltas through physical ancestors.
4. Rebuilds virtual chart ownership and detects changed child routes.
5. Rebuilds the affected boundary, writes the new chart, updates the parent
   `Child Charts` section, and refreshes the partition index when routing
   changes.

Therefore the partitioner was not missing new-chart creation logic. The bug
was at the Git change-capture boundary: directory-collapsed untracked paths
never supplied the file-level input required by this existing flow.

## Scope

This fixes newly created untracked directory branches reported by the stop and
session-end hooks. The incremental API continues to require repository-relative
file paths.

## Verification

The regression coverage is split across the hook boundary and the chart
pipeline:

- `tests/hooks/captureGitChanges.test.js` uses a real temporary Git repository
  and verifies that one batch containing several new nested directories is
  returned as file paths, never collapsed directory paths. This is the
  function-level correctness test.
- `tests/behavior-consistency/partitionedChartArtifacts.test.js` creates
  several virtual child directories in one batch and compares the complete
  `.memoryanchor` artifact snapshot from a full build with the incremental
  result.
- `tests/behavior-consistency/dependencyGraphArtifacts.test.js` exercises a
  large cross-chart reverse-dependency update and compares its full and
  incremental outputs, including the persisted graph. These files form the
  behavior-consistency test partition.

The OpenCode loopback test in `tests/hooks/opencode-runtime.test.js` remains
focused on plugin context injection and stop/post lifecycle delivery through a
local fake backend; it is not the assertion boundary for incremental chart
artifacts.

Run the focused regression set with:

```bash
npm run build
node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand \
  tests/hooks/captureGitChanges.test.js \
  tests/behavior-consistency/partitionedChartArtifacts.test.js \
  tests/behavior-consistency/dependencyGraphArtifacts.test.js
```
