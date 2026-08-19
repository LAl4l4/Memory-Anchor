# Incremental Untracked-File Deletion Fix

## Status

Fixed for files that have been observed as untracked by at least one Stop or
session-end refresh.

## Symptom

An untracked source file can be parsed and added to
`.memoryanchor/dependencyGraph.json`, then be deleted before it is ever staged
or committed. Its old reverse callers can remain in generated charts after a
later incremental refresh. For example, a deleted caller can still appear as:

```text
resetProject() <- scripts/cross-chart-demo/ma-demo-lib.ts:...
```

The stale entry was not caused by chart rendering. The persistent dependency
graph still contained the deleted file's forward and reverse edges because no
deletion path reached graph reconciliation.

## Discovery

The repository author found this through repeated real-world runs against a
large Next.js workspace with OpenCode. After each lifecycle refresh, they
compared the generated chart files with the expected cross-chart callers and
found that deleted demo callers remained in the `scripts` and `turbo` charts.

DeepSeek V4 Flash then inspected `.memoryanchor/debug.log`. The log recorded
only the newly added `demo/` files in the Stop batch; it contained no paths for
the deleted `scripts/cross-chart-demo/ma-demo-lib.ts` and
`turbo/cross-chart-demo/ma-turbo-demo.ts` files. That evidence narrowed the
failure to Git change capture rather than chart rendering or reverse-edge
formatting.

## Why creation works but deletion does not

Stop and session-end hooks obtain incremental inputs from:

```text
git status --porcelain --untracked-files=all
```

`--untracked-files=all` expands a newly created untracked directory into
individual `??` file paths, so new files enter parsing and graph creation.
Once such a file is deleted, Git has no record that the never-tracked path
previously existed. It is absent from `git status`, so it cannot be supplied
to the incremental parser or dependency-graph reconciler.

| File lifecycle | Creation visible | Deletion visible |
| --- | --- | --- |
| Never staged or committed | Yes (`??`) | No |
| Staged but not committed | Yes | Yes (`AD`) |
| Committed | Yes | Yes (`D`) |

This is not a distinction between pre-commit and post-commit work. The
important boundary is whether the path has ever entered Git's index.

## Solution design

The initial AI-proposed recovery was to run a full rebuild, which clears the
stale graph but repeats repository-wide work after every occurrence. The
repository author proposed the more precise fix: persist only the paths Git
currently labels `??`, then perform a cheap existence check on that small set
at every Stop hook. When a watched path disappears, feed the existing
incremental reconciler a deletion path; when Git begins tracking the path,
remove it from the watch set.

This is the better operational solution because it:

- preserves the incremental path instead of falling back to a full workspace
  rebuild;
- scales with the number of observed untracked files, not repository size;
- reuses the existing deletion and dependency-graph cleanup logic; and
- stops checking a file as soon as Git can report its deletion itself.

## Fix

When Git reports a `??` path, Memory Anchor persists its normalized relative
path in `.memoryanchor/untracked-files.json`. Each later Git capture:

1. Adds any current `??` paths to that watch set.
2. Removes a watched path as soon as `git ls-files --error-unmatch -- <path>`
   confirms that it has entered Git's index.
3. Checks whether every remaining watched path exists in the workspace.
4. Emits a synthetic `D` change for a missing path, then removes it from the
   watch set.

The existing incremental dependency-graph reconciler receives that `D` path
and removes its forward and reverse edges normally. The watch JSON is deleted
when its set becomes empty and never watches `.memoryanchor/` internal files.

## Scope

The file must have appeared in a lifecycle refresh while it was untracked; a
file deleted before its first observation cannot have contributed a persistent
graph node. Existing stale nodes from before this fix still need one full
rebuild to establish a clean baseline.

## Verification

`tests/hooks/captureGitChanges.test.js` covers persistence, synthetic deletion
capture, and automatic removal after `git add`. `tests/hooks/stopPublic.test.js`
verifies that a Stop hook forwards the synthetic deletion to incremental chart
refresh.
