## Optimization
Implement threadPool and language load cache to reuse the parser and loaded language, 
make it sharply faster when appling initialization on large workspace.

threadPool is lazy create, it will automatically creating when necessary, but it should exit

WorkerPool will exist when you use the cli, to catch the file change after every change, 
it will destroy when you exit the cli, ensuring highest reuse amount.

Initialization will destroy the pool after it finished.


## Memory Anchor Rules
Memory Anchor is initialized in this repository. Follow these rules to ensure it works effectively.

### File Roles
- ./.memoryanchor/index.md: Auto-generated project chart index. Its entries point to directory-level architecture maps under ./.memoryanchor/chart/.
- ./.memoryanchor/manifest.md: Current project state — Module Status (functionality/status/known_issues/notes) and Key Decisions (architectural choices and rationale).
- ./.memoryanchor/ballast.md: Persistent repo-specific rules/guardrails, one per line.

### Workflow
- If the agent has any uncertainty about the overall project structure, immediately read ./.memoryanchor/index.md again, then read the closest matching directory chart listed there.
- Must follow all rules in ./.memoryanchor/ballast.md. After solving a bug, add a rule under "Ballast Specific Rules For This Repository" to prevent recurrence.
- After any of features implemented, update Module Status (and Key Decisions, if applicable) in ./.memoryanchor/manifest.md.

### ballast.md format
- Keep only valid rules. Delete obsolete ones.
- One line per rule, exact format: '- [ ] Rule content'

## Memory Anchor Ends
