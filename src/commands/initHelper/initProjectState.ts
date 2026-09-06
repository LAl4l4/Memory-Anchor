import { readFile, writeFile } from 'node:fs/promises';
import {
  DECISIONS_DEFAULT_CONTENT,
  PROJECT_STATE_DEFAULT_CONTENT,
} from '../../constant.js';

/**
 * Preserve decision content while ensuring top-level decision bullets remain
 * visually separated. Existing blank lines are retained; only missing spacing
 * between adjacent decisions is inserted.
 */
export function preserveKeyDecisionSpacing(content: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let insideKeyDecisions = false;
  let seenDecision = false;

  for (const line of lines) {
    if (/^#{1,2}\s+Key Decisions\s*$/.test(line)) {
      insideKeyDecisions = true;
      seenDecision = false;
      output.push(line);
      continue;
    }

    if (insideKeyDecisions && /^#{1,2}\s+/.test(line)) {
      insideKeyDecisions = false;
      seenDecision = false;
    }

    if (insideKeyDecisions && /^-\s+\S/.test(line)) {
      if (seenDecision && output.at(-1)?.trim() !== '') output.push('');
      seenDecision = true;
    }

    output.push(line);
  }

  return output.join(newline);
}

interface SplitProjectState {
  projectState: string;
  decisions: string | null;
}

/** Remove the legacy Key Decisions section without disturbing other state sections. */
export function splitProjectStateDecisions(content: string): SplitProjectState {
  const heading = /^##\s+Key Decisions\s*$/m.exec(content);
  if (!heading) return { projectState: content, decisions: null };

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const bodyStart = heading.index + heading[0].length;
  const remaining = content.slice(bodyStart);
  const nextHeading = /^##\s+\S.*$/m.exec(remaining);
  const sectionEnd = nextHeading ? bodyStart + nextHeading.index : content.length;
  const decisionBody = content.slice(bodyStart, sectionEnd).trim();
  const before = content.slice(0, heading.index).trimEnd();
  const after = content.slice(sectionEnd).trimStart();
  const projectState = [before, after]
    .filter((part) => part.length > 0)
    .join(`${newline}${newline}`);
  const decisions = preserveKeyDecisionSpacing(
    `# Key Decisions${newline}${decisionBody ? `${newline}${decisionBody}` : ''}${newline}`,
  );

  return {
    projectState: projectState ? `${projectState.trimEnd()}${newline}` : PROJECT_STATE_DEFAULT_CONTENT,
    decisions,
  };
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

/** Create the two state files and migrate embedded Key Decisions without loss. */
export async function ensureProjectMemoryFiles(
  projectStatePath: string,
  decisionsPath: string,
): Promise<boolean> {
  const currentProjectState = await readOptionalFile(projectStatePath);
  const split = splitProjectStateDecisions(
    currentProjectState ?? PROJECT_STATE_DEFAULT_CONTENT,
  );
  let changed = false;

  const currentDecisions = await readOptionalFile(decisionsPath);
  if (currentDecisions === null) {
    await writeFile(decisionsPath, split.decisions ?? DECISIONS_DEFAULT_CONTENT);
    changed = true;
  } else {
    let nextDecisions = preserveKeyDecisionSpacing(currentDecisions);
    if (split.decisions) {
      const migratedBody = split.decisions.replace(/^#\s+Key Decisions\s*/m, '').trim();
      if (migratedBody && !nextDecisions.includes(migratedBody)) {
        nextDecisions = `${nextDecisions.trimEnd()}\n\n${migratedBody}\n`;
      }
    }
    if (nextDecisions !== currentDecisions) {
      await writeFile(decisionsPath, nextDecisions);
      changed = true;
    }
  }

  if (currentProjectState === null || split.projectState !== currentProjectState) {
    await writeFile(projectStatePath, split.projectState);
    changed = true;
  }

  return changed;
}
