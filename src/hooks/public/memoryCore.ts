import * as fs from 'node:fs';
import * as path from 'node:path';
import { memoryMaintenanceNotice } from './memoryMaintenance.js';
import { extractRepositoryRules } from './guardrailMaintenance.js';
import { chartEntryDirectories, compactDirectory, projectStateModules } from '../../mcp/memoryCatalog.js';
import { MCP_USAGE_INSTRUCTIONS } from '../../mcp/instructions.js';

function readFileSafe(filePath: string, fallback: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').trim() : fallback;
  } catch {
    return fallback;
  }
}

export function buildMemoryCore(workspaceRoot: string): string {
  const anchorDir = path.join(workspaceRoot, '.memoryanchor');
  const guardrails = extractRepositoryRules(readFileSafe(path.join(anchorDir, 'guardrails.md'), '')).join('\n');
  const projectState = readFileSafe(path.join(anchorDir, 'project-state.md'), '');
  const decisions = readFileSafe(path.join(anchorDir, 'decisions.md'), '');
  let chartEntries = ['.'];
  try { chartEntries = chartEntryDirectories(readFileSafe(path.join(anchorDir, 'dirTree.json'), '')); }
  catch { /* Missing or invalid snapshots retain the root query entry. */ }
  const modules = projectStateModules(projectState);
  return [
    '',
    '[MEMORY ANCHOR: CONTEXT INJECTED]',
    MCP_USAGE_INSTRUCTIONS,
    memoryMaintenanceNotice(guardrails, projectState),
    guardrails ? '[GUARDRAILS (rules must follow)]\n' + guardrails : '',
    '[CHART DIRECTORY]\n' + compactDirectory(chartEntries, 'get_chart({path:"."})'),
    modules.length ? '[PROJECT STATE DIRECTORY]\n' + compactDirectory(modules.map(module => module.name), 'get_project_state({})') : '',
    decisions ? '[KEY DECISIONS (architectural choices & rationale)]\n' + decisions : '',
    '',
  ].filter((line, index) => line || index === 0).join('\n');
}
