
## Memory Anchor Rules

### File Roles
- ./.memoryanchor/chart.md: Auto-generated log of file changes per session. Read this FIRST to recover recent context.
- ./.memoryanchor/manifest.md: Current project state — Module Status (functionality/status/known_issues/notes) and Key Decisions (architectural choices and rationale).
- ./.memoryanchor/ballast.md: Persistent repo-specific rules/guardrails, one per line.

### Workflow
- Always read ./.memoryanchor/chart.md before accessing any repository files. Only open repository files when chart.md is insufficient.
- Must follow all rules in ./.memoryanchor/ballast.md. After solving a bug, add a rule under "Ballast Specific Rules For This Repository" to prevent recurrence.
- After any of features implemented, update Module Status (and Key Decisions, if applicable) in ./.memoryanchor/manifest.md.

### ballast.md format
- Keep only valid rules. Delete obsolete ones.
- One line per rule, exact format: '- [ ] Rule content'

## Memory Anchor Ends
