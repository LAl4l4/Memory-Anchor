# Bench suites

A suite is one repository snapshot plus hidden-invariant tasks. Suites built from private code stay
out of git (`bench/suites/*` is ignored except this file).

```
<suite>/
  suite.json                 source repo + ref + paths, test command, where hidden tests go
  overlay/                   files copied over the export (fixtures, .gitignore)
  knowledge/
    AGENTS.full.md           doc: uncompressed AGENTS.md (400–500 lines), invariant knowledge included
    AGENTS.compact.md        ma: the trimmed AGENTS.md a MemoryAnchor user keeps
    memory/                  ma: guardrails.md, decisions.md, project-state.md → .memoryanchor/
    invariant-lines.txt      lines of AGENTS.full.md removed for off
    scattered/               scattered: loose notes copied into the repo at these paths (must not overwrite repo files)
  tasks/<id>/
    task.json                prompt, files to hide, task (F2P) tests, invariant tests per rule
    tests/                   hidden test classes, added only at grading
    solution.patch           correct reference change (must be fully intact)
    trap.patch               the "obvious" change (completes the task, breaks ≥1 invariant)
```

`suite.json`

```json
{
  "name": "example",
  "source": { "repo": "/abs/path/to/repo", "ref": "<commit>", "paths": ["Backend", "Config"] },
  "overlay": "overlay",
  "testCommand": "cd Backend && ./mvnw -q -o test",
  "testSourceRoot": "Backend/src/test/java",
  "hiddenTestDir": "Backend/src/test/java/pkg/benchhidden",
  "reportsDir": "Backend/target/surefire-reports",
  "knowledge": { "agentsFull": "...", "agentsCompact": "...", "memoryDir": "...", "invariantLines": "...", "scattered": "..." }
}
```

`task.json`

```json
{
  "id": "settings-reset",
  "prompt": "What the agent is asked to do. Never mention the invariant.",
  "hide": ["Backend/src/test/java/.../TestThatRevealsTheRule.java"],
  "f2p": ["pkg.benchhidden.FooBenchTest#task_works"],
  "invariants": { "rule-id": ["pkg.benchhidden.FooBenchTest#inv_keepsBehaviour"] }
}
```

Test ids are `fully.qualified.Class#method` as reported by surefire. Hidden files are removed from the
agent's workspace and restored before grading, together with any original test the agent edited.

Check a suite before running it:

```bash
node bench/src/cli.mjs validate --suite <name>
```
