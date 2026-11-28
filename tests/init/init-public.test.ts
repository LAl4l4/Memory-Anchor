import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANCHOR_DIR_NAME,
  DECISIONS_FILE_NAME,
  GITIGNORE_ENTRY,
  GUARDRAILS_FILE_NAME,
  LEGACY_GUARDRAILS_RULES,
  PROJECT_STATE_DEFAULT_CONTENT,
  PROJECT_STATE_FILE_NAME,
} from '../../dist/constant.js';
import { dedentLegacyProjectState, structureLegacyProjectState } from '../../dist/commands/initHelper/initProjectState.js';
import { MemoryStore } from '../../dist/mcp/memoryStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const originalCwd = process.cwd();

let tempDir = '';

function runInitPublic(cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [cliPath, 'init-public'], { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'memory-anchor-public-'));
  process.chdir(tempDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creates .memoryanchor directory', async () => {
  await runInitPublic(tempDir);

  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  const stat = await import('node:fs/promises').then((fs) => fs.stat(anchorDir));
  expect(stat.isDirectory()).toBe(true);
});

test('creates .gitignore with .memoryanchor entry', async () => {
  await runInitPublic(tempDir);

  const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
  expect(gitignore).toContain(ANCHOR_DIR_NAME);
});

test('creates only repository guardrails', async () => {
  await runInitPublic(tempDir);
  const guardrails = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, GUARDRAILS_FILE_NAME), 'utf8');
  expect(guardrails.trim()).toBe('# Repository-specific Guardrails (maintain as the repository evolves)');
});

test('drops retired default rules instead of keeping them as repository-specific', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then((fs) => fs.mkdir(anchorDir, { recursive: true }));
  await writeFile(
    path.join(anchorDir, GUARDRAILS_FILE_NAME),
    `# Default Guardrails (do not modify)\n${LEGACY_GUARDRAILS_RULES.join('\n')}\n`,
  );

  await runInitPublic(tempDir);

  const guardrails = await readFile(path.join(anchorDir, GUARDRAILS_FILE_NAME), 'utf8');
  for (const rule of LEGACY_GUARDRAILS_RULES) {
    expect(guardrails).not.toContain(rule);
  }
});

test('creates separate project-state.md and decisions.md files', async () => {
  await runInitPublic(tempDir);

  const projectState = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, PROJECT_STATE_FILE_NAME), 'utf8');
  const decisions = await readFile(path.join(tempDir, ANCHOR_DIR_NAME, DECISIONS_FILE_NAME), 'utf8');
  expect(projectState).toContain('## Module Status');
  expect(projectState).not.toContain('Key Decisions');
  expect(decisions).toContain('# Key Decisions');
});

test('migrates legacy ballast and manifest files without losing their content', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then((fs) => fs.mkdir(anchorDir, { recursive: true }));
  await writeFile(
    path.join(anchorDir, 'ballast.md'),
    '- [ ] Preserve this repository-specific rule.\n',
  );
  await writeFile(
    path.join(anchorDir, 'manifest.md'),
    '## Module Status\n### migrated\n- status: Stable\n\n## Key Decisions\n- first decision\n- second decision\n',
  );

  await runInitPublic(tempDir);

  await expect(readFile(path.join(anchorDir, 'ballast.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(anchorDir, 'manifest.md'), 'utf8'))
    .rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(anchorDir, GUARDRAILS_FILE_NAME), 'utf8'))
    .resolves.toContain('Preserve this repository-specific rule.');
  const projectState = await readFile(path.join(anchorDir, PROJECT_STATE_FILE_NAME), 'utf8');
  const decisions = await readFile(path.join(anchorDir, DECISIONS_FILE_NAME), 'utf8');
  expect(projectState).toContain('### migrated');
  expect(projectState).not.toContain('Key Decisions');
  expect(decisions).toContain('- first decision\n\n- second decision');
});

test('re-running splits embedded Key Decisions and preserves their spacing', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then((fs) => fs.mkdir(anchorDir, { recursive: true }));
  const projectStatePath = path.join(anchorDir, PROJECT_STATE_FILE_NAME);
  await writeFile(
    projectStatePath,
    '## Module Status\n### core\n- status: Stable\n\n## Key Decisions\n- first decision\n- second decision\n- third decision\n',
  );

  await runInitPublic(tempDir);

  await expect(readFile(projectStatePath, 'utf8')).resolves.not.toContain('Key Decisions');
  await expect(readFile(path.join(anchorDir, DECISIONS_FILE_NAME), 'utf8')).resolves.toContain(
    '- first decision\n\n- second decision\n\n- third decision',
  );
});

test('re-running an interrupted decision migration does not duplicate decisions', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then((fs) => fs.mkdir(anchorDir, { recursive: true }));
  await writeFile(
    path.join(anchorDir, PROJECT_STATE_FILE_NAME),
    '## Module Status\n### core\n- status: Stable\n\n## Key Decisions\n- keep this decision\n',
  );
  await writeFile(
    path.join(anchorDir, DECISIONS_FILE_NAME),
    '# Key Decisions\n\n- keep this decision\n',
  );

  await runInitPublic(tempDir);

  const decisions = await readFile(path.join(anchorDir, DECISIONS_FILE_NAME), 'utf8');
  expect(decisions.match(/- keep this decision/g)).toHaveLength(1);
});

test('moves module-less project state verbatim into one module that memory tools read, once', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then((fs) => fs.mkdir(anchorDir, { recursive: true }));
  const statePath = path.join(anchorDir, PROJECT_STATE_FILE_NAME);
  await writeFile(statePath, '## Todo:\n- [ ] Ship recall\n\n```md\n### not a module\n```\n## Done:\n- [x] Parser pools\n\n## Key Decisions\n- Use BM25 first.\n');

  await runInitPublic(tempDir);

  const migrated = await readFile(statePath, 'utf8');
  expect(migrated).toBe([
    '## Module Status', '', '### Legacy project state',
    '- status: Migrated by anchor init from a project-state.md without modules; move each item below into its own module, then remove this one.',
    '- notes: Original content, kept verbatim:',
    '    ## Todo:', '    - [ ] Ship recall', '', '    ```md', '    ### not a module', '    ```', '    ## Done:', '    - [x] Parser pools', '',
  ].join('\n'));
  await expect(readFile(path.join(anchorDir, DECISIONS_FILE_NAME), 'utf8')).resolves.toContain('- Use BM25 first.');
  const store = await MemoryStore.create(tempDir);
  expect((await store.get('project_state') as any).modules.map((module: any) => module.id)).toEqual(['Legacy project state']);
  expect(await store.get('project_state', 'Legacy project state')).toMatchObject({ entry: { content: expect.stringContaining('- [x] Parser pools') } });
  expect((await store.recall({ query: 'parser pools' }) as any).results[0].id).toBe('Legacy project state');

  await runInitPublic(tempDir);
  await expect(readFile(statePath, 'utf8')).resolves.toBe(migrated);
});

test('dedents the indented Module Status manifest template and splits its decisions', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then((fs) => fs.mkdir(anchorDir, { recursive: true }));
  await writeFile(path.join(anchorDir, 'manifest.md'), '\n    ## Module Status\n\n    ### core\n    - status: Stable\n      wrapped note\n\n    ## Key Decisions\n    - keep tree-sitter\n');

  await runInitPublic(tempDir);

  await expect(readFile(path.join(anchorDir, PROJECT_STATE_FILE_NAME), 'utf8'))
    .resolves.toBe('\n## Module Status\n\n### core\n- status: Stable\n  wrapped note\n');
  await expect(readFile(path.join(anchorDir, DECISIONS_FILE_NAME), 'utf8')).resolves.toContain('- keep tree-sitter');
});

test('legacy project-state helpers leave structured, heading-only and unrelated content alone', () => {
  const structured = '## Module Status\r\n### core\r\n- status: Stable\r\n';
  expect(structureLegacyProjectState(structured)).toBe(structured);
  expect(structureLegacyProjectState('## Module Status\n')).toBe('## Module Status\n');
  expect(structureLegacyProjectState('## Todo:\n\n## Done:\n')).toBe(PROJECT_STATE_DEFAULT_CONTENT);
  expect(structureLegacyProjectState('notes\r\n')).toContain('\r\n    notes\r\n');
  expect(dedentLegacyProjectState('  indented prose\n  ## Other\n')).toBe('  indented prose\n  ## Other\n');
  expect(dedentLegacyProjectState('## Module Status\n### core\n')).toBe('## Module Status\n### core\n');
});

test('creates AGENTS.md with memory anchor rules', async () => {
  await runInitPublic(tempDir);

  const agents = await readFile(path.join(tempDir, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('## Memory Anchor Rules');
  expect(agents).toContain('## Memory Anchor Ends');
  expect(agents).toContain('get_chart({path}) reads the architecture chart covering a directory');
  expect(agents).toContain('write_memory applies the storage format');
  expect(agents).toContain('### Memory Kinds');
  expect(agents).toContain('Use get_chart on the task directory');
  expect(agents).toContain('If the agent has any uncertainty about the overall project structure');
  expect(agents).not.toContain('unavailable');
  expect(agents).not.toContain('guardrails.md format');
  expect(agents.trimEnd()).toMatch(/is undefined behaviour: it bypasses the write lock[^\n]*\n\n## Memory Anchor Ends$/);
  expect(agents).toContain('## Chart Relationship Notation');
  expect(agents).toContain("'+' marks an exported symbol; '-' marks the default/internal symbol");
  expect(agents).toContain("'->' lists parseable repository files referenced by a file, including targets in full repository.");
  expect(agents).toContain(
    "'<-' lists import-resolved cross-file callers (across charts in full builds), never same-file, member, or dynamic calls; it is attached only to symbols."
  );
});

test('upgrades the managed AGENTS.md block while preserving other instructions', async () => {
  const agentsPath = path.join(tempDir, 'AGENTS.md');
  await writeFile(agentsPath, `# Project Rules

Keep this custom instruction.

## Memory Anchor Rules
Old generated content.
- Always read ./.memoryanchor/chart.md before accessing any repository files. Only open repository files when chart.md is insufficient.
## Memory Anchor Ends

# Trailing Rules
Preserve this too.
`);

  await runInitPublic(tempDir);

  const agents = await readFile(agentsPath, 'utf8');
  expect(agents).toContain('Keep this custom instruction.');
  expect(agents).toContain('Preserve this too.');
  expect(agents).toContain('Use get_chart on the task directory');
  expect(agents).toContain('If the agent has any uncertainty about the overall project structure');
  expect(agents.match(/## Memory Anchor Rules/g)).toHaveLength(1);
});

test('initialization removes legacy index and preserves custom rules across repeated migrations', async () => {
  const anchorDir = path.join(tempDir, ANCHOR_DIR_NAME);
  await import('node:fs/promises').then(fs => fs.mkdir(anchorDir, { recursive: true }));
  await writeFile(path.join(anchorDir, 'index.md'), '# old index');
  await writeFile(path.join(anchorDir, GUARDRAILS_FILE_NAME),
    `# Default Guardrails (do not modify)\n${LEGACY_GUARDRAILS_RULES.join('\n')}\n- [ ] Custom rule in default section.\n\n# Repository-specific Guardrails (maintain as the repository evolves)\n- [ ] Keep this rule.\n`);
  await runInitPublic(tempDir);
  const first = await readFile(path.join(anchorDir, GUARDRAILS_FILE_NAME), 'utf8');
  await runInitPublic(tempDir);
  expect(await readFile(path.join(anchorDir, GUARDRAILS_FILE_NAME), 'utf8')).toBe(first);
  expect(first).toContain('Custom rule in default section.');
  expect(first).toContain('Keep this rule.');
  expect(first).not.toContain('Default Guardrails');
  await expect(readFile(path.join(anchorDir, 'index.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(path.join(anchorDir, 'dirTree.json'), 'utf8')).resolves.toContain('directory');
});

test('re-running does not duplicate .gitignore entries', async () => {
  await runInitPublic(tempDir);
  await runInitPublic(tempDir);

  const gitignore = await readFile(path.join(tempDir, '.gitignore'), 'utf8');
  GITIGNORE_ENTRY.forEach((entry) => {
    const lines = gitignore.split('\n').filter((l) => l.trim() === entry);
    expect(lines).toHaveLength(1);
  });
});
