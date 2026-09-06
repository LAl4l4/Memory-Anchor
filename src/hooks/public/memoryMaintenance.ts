import * as fs from 'node:fs';
import * as path from 'node:path';
import { GUARDRAILS_MAX_BYTES, PROJECT_STATE_MODULE_STATUS_MAX_BYTES } from '../../constant.js';

function extractProjectStateModuleStatus(projectState: string): string {
  const moduleHeading = /^##\s+Module Status\s*$/m;
  const headingMatch = moduleHeading.exec(projectState);
  if (!headingMatch) return '';

  const sectionStart = headingMatch.index;
  const afterHeading = sectionStart + headingMatch[0].length;
  const nextSectionMatch = /^##\s+\S.*$/m.exec(projectState.slice(afterHeading));
  const sectionEnd = nextSectionMatch
    ? afterHeading + nextSectionMatch.index
    : projectState.length;
  return projectState.slice(sectionStart, sectionEnd).trim();
}

/** Advisory diagnostics only: neither hooks nor this report rewrite memory. */
export function memoryMaintenanceNotice(guardrails: string, projectState: string): string {
  const notices: string[] = [];
  const guardrailsBytes = Buffer.byteLength(guardrails, 'utf8');
  const statusBytes = Buffer.byteLength(extractProjectStateModuleStatus(projectState), 'utf8');
  if (guardrailsBytes > GUARDRAILS_MAX_BYTES) {
    notices.push(`- guardrails.md: ${guardrailsBytes} UTF-8 bytes; advisory limit: ${GUARDRAILS_MAX_BYTES} bytes.`);
  }
  if (statusBytes > PROJECT_STATE_MODULE_STATUS_MAX_BYTES) {
    notices.push(`- project-state.md Module Status: ${statusBytes} UTF-8 bytes; advisory limit: ${PROJECT_STATE_MODULE_STATUS_MAX_BYTES} bytes.`);
  }
  if (guardrails.includes('[STALE]')) {
    notices.push('- guardrails.md contains legacy [STALE] markers. A source edit alone does not establish that a rule is obsolete.');
  }
  if (notices.length === 0) return '';
  return [
    '[MEMORY MAINTENANCE NOTICE]', ...notices,
    'Optional maintenance: run `anchor maintain` to review. These notices do not require action during the current task; preserve rules until their validity is explicitly reviewed.',
  ].join('\n');
}

export function readMemoryMaintenanceNotice(workdir: string): string {
  const read = (file: string): string => {
    try {
      return fs.readFileSync(path.join(workdir, '.memoryanchor', file), 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  };
  return memoryMaintenanceNotice(read('guardrails.md'), read('project-state.md'));
}
