import * as fs from 'node:fs';
import * as path from 'node:path';
import { memoryMaintenanceNotice } from './memoryMaintenance.js';
import { extractRepositoryRules } from './guardrailMaintenance.js';
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
  return [
    '',
    '[MEMORY ANCHOR: CONTEXT INJECTED]',
    MCP_USAGE_INSTRUCTIONS,
    memoryMaintenanceNotice(guardrails, projectState),
    guardrails ? '[GUARDRAILS (rules must follow)]\n' + guardrails : '',
    projectState ? '[PROJECT STATE (module status)]\n' + projectState : '',
    decisions ? '[KEY DECISIONS (architectural choices & rationale)]\n' + decisions : '',
    '',
  ].filter((line, index) => line || index === 0).join('\n');
}
