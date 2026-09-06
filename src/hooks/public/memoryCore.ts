import * as fs from 'node:fs';
import * as path from 'node:path';
import { memoryMaintenanceNotice } from './memoryMaintenance.js';

function readFileSafe(filePath: string, fallback: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8').trim() : fallback;
  } catch {
    return fallback;
  }
}

export function buildMemoryCore(workspaceRoot: string): string {
  const anchorDir = path.join(workspaceRoot, '.memoryanchor');
  const indexPath = path.join(anchorDir, 'index.md');
  const rootChartPath = path.join(anchorDir, 'chart', 'chart.md');
  const guardrailsPath = path.join(anchorDir, 'guardrails.md');
  const projectStatePath = path.join(anchorDir, 'project-state.md');
  const decisionsPath = path.join(anchorDir, 'decisions.md');
  const index = readFileSafe(indexPath, 'No project chart available.');
  const rootChart = fs.existsSync(rootChartPath) ? readFileSafe(rootChartPath, '') : '';
  const chart = rootChart
    ? '[INDEX ROUTING RULES — ALWAYS INJECTED]\n' +
      index +
      '\n\n[ROOT CHART ALREADY INJECTED — DO NOT READ IT AGAIN]\n' +
      rootChart
    : '[INDEX ROUTING RULES — ALWAYS INJECTED]\n' + index;
  const guardrails = readFileSafe(
    guardrailsPath,
    'No active coding constraints or lessons-learned enforced.',
  );
  const projectState = readFileSafe(projectStatePath, 'No active cross-session tasks found.');
  const decisions = readFileSafe(decisionsPath, 'No architectural decisions recorded.');
  const maintenanceNotice = memoryMaintenanceNotice(guardrails, projectState);

  return [
    '',
    '==================================================',
    '[MEMORY ANCHOR: CONTEXT INJECTED]',
    'Target: Assist the developer by ensuring all generated code aligns with local repository constraints.',
    '',
    maintenanceNotice,
    '[1. CHART (project structure & architectural symbols)]',
    chart,
    '',
    '[2. GUARDRAILS (rules must follow)]',
    guardrails,
    '',
    '[3. PROJECT STATE (module status)]',
    projectState,
    '',
    '[4. KEY DECISIONS (architectural choices & rationale)]',
    decisions,
    '==================================================',
    '',
  ].join('\n');
}
