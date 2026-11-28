import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../utils/memoryFiles.js';
import {
  DECISIONS_DEFAULT_CONTENT,
  PROJECT_STATE_DEFAULT_CONTENT,
} from '../../constant.js';
import { isUnstructuredProjectState } from '../../mcp/memoryCatalog.js';

export const LEGACY_PROJECT_STATE_MODULE = 'Legacy project state';
/** manifest.md default before Module Status existed; it holds no state. */
const LEGACY_MANIFEST_DEFAULT = /^\s*## Todo:\s*## Done:\s*$/;
const eolOf = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n');

/** The Module Status manifest template was indented inside its template literal; dedent it when that exposes its headings. */
export function dedentLegacyProjectState(content: string): string {
  const lines = content.split(/\r?\n/);
  const indentOf = (line: string): number => /^ */.exec(line)![0].length;
  const indents = lines.filter((line) => line.trim()).map(indentOf);
  const indent = indents.length ? Math.min(...indents) : 0;
  if (!indent) return content;
  const dedented = lines.map((line) => line.slice(Math.min(indent, indentOf(line))));
  return dedented.some((line) => /^##\s+(Module Status|Key Decisions)\s*$/.test(line))
    ? dedented.join(eolOf(content))
    : content;
}

/**
 * Memory tools read project state only as modules, so a file without any moves verbatim into one
 * module. Four-space indentation keeps its headings and fences from being parsed as structure.
 */
export function structureLegacyProjectState(content: string): string {
  if (LEGACY_MANIFEST_DEFAULT.test(content)) return PROJECT_STATE_DEFAULT_CONTENT;
  if (!isUnstructuredProjectState(content)) return content;
  const lines = content.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return [
    '## Module Status',
    '',
    `### ${LEGACY_PROJECT_STATE_MODULE}`,
    '- status: Migrated by anchor init from a project-state.md without modules; move each item below into its own module, then remove this one.',
    '- notes: Original content, kept verbatim:',
    ...lines.slice(start, end).map((line) => (line.trim() ? `    ${line}` : '')),
    '',
  ].join(eolOf(content));
}

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

/** Create the two state files and migrate embedded Key Decisions and module-less state without loss. Call under withMemoryLock. */
export async function ensureProjectMemoryFiles(
  projectStatePath: string,
  decisionsPath: string,
): Promise<boolean> {
  const currentProjectState = await readOptionalFile(projectStatePath);
  const split = splitProjectStateDecisions(
    dedentLegacyProjectState(currentProjectState ?? PROJECT_STATE_DEFAULT_CONTENT),
  );
  const nextProjectState = structureLegacyProjectState(split.projectState);
  let changed = false;

  const currentDecisions = await readOptionalFile(decisionsPath);
  if (currentDecisions === null) {
    await writeFileAtomic(decisionsPath, split.decisions ?? DECISIONS_DEFAULT_CONTENT);
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
      await writeFileAtomic(decisionsPath, nextDecisions);
      changed = true;
    }
  }

  if (currentProjectState === null || nextProjectState !== currentProjectState) {
    await writeFileAtomic(projectStatePath, nextProjectState);
    changed = true;
  }

  return changed;
}
