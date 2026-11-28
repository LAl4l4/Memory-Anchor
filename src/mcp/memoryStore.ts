import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ANCHOR_DIR_NAME, DECISIONS_FILE_NAME, GUARDRAILS_MANAGED_RULE_SET, GUARDRAILS_SPECIFIC_TITLE,
  PROJECT_STATE_FILE_NAME,
} from '../constant.js';
import { normalizeLine } from '../hooks/public/guardrailMaintenance.js';
import { memoryMaintenanceNotice } from '../hooks/public/memoryMaintenance.js';
import { projectStateLayout } from './memoryCatalog.js';

export const MEMORY_KINDS = ['guardrails', 'decisions', 'project_state'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const PROJECT_STATE_FIELDS = ['functionality', 'status', 'dependencies', 'known_issues', 'notes'] as const;
export type ProjectStateField = typeof PROJECT_STATE_FIELDS[number];
export type ProjectStateFields = Partial<Record<ProjectStateField, string>>;

export interface WriteMemoryInput {
  kind: MemoryKind;
  op: 'add' | 'update' | 'remove';
  /** Required for update/remove; for project_state it is the module name (also for add). */
  id?: string;
  content?: string;
  fields?: ProjectStateFields;
  /** Optional project_state module version from get_memory; a mismatch rejects the write. */
  version?: string;
  /** Add even when similar entries exist. */
  force?: boolean;
}

const FILES: Record<MemoryKind, string> = {
  guardrails: path.posix.join(ANCHOR_DIR_NAME, 'guardrails.md'),
  decisions: path.posix.join(ANCHOR_DIR_NAME, DECISIONS_FILE_NAME),
  project_state: path.posix.join(ANCHOR_DIR_NAME, PROJECT_STATE_FILE_NAME),
};
const MAX_MEMORY_BYTES = 2 * 1024 * 1024;
const SIMILARITY_THRESHOLD = 0.5;
const LOCK_TIMEOUT_MS = 5000;
const STALE_LOCK_MS = 30000;
const STOP_WORDS = new Set(['the', 'and', 'or', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'with', 'by', 'as', 'is',
  'are', 'be', 'it', 'its', 'this', 'that', 'from', 'at', 'not', 'only', 'must', 'should', 'when', 'use', 'keep']);

interface Entry { id: string; content: string; start: number; end: number }
interface Doc { lines: string[]; eol: string; exists: boolean; modifiedAt: string | null }

const collapse = (text: string): string => text.trim().replace(/\s+/g, ' ');
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);
const entryId = (kind: 'guardrails' | 'decisions', content: string): string =>
  `${kind === 'guardrails' ? 'g' : 'd'}-${digest(collapse(content))}`;

/** Ids are derived from content, so a hand edit invalidates them instead of pointing at the wrong entry. */
export function inferMemoryKind(id: string): MemoryKind {
  if (/^g-[0-9a-f]{8}$/.test(id)) return 'guardrails';
  if (/^d-[0-9a-f]{8}$/.test(id)) return 'decisions';
  return 'project_state';
}

function tokens(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = (lower.match(/[a-z0-9_]+/g) ?? []).filter(word => word.length > 1 && !STOP_WORDS.has(word));
  const cjk = [...lower.matchAll(/[㐀-鿿]+/g)].flatMap(([run]) =>
    run.length === 1 ? [run] : [...run].slice(1).map((char, index) => run[index] + char));
  return new Set([...words, ...cjk]);
}

export function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

function guardrailEntries(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  lines.forEach((line, index) => {
    const normalized = normalizeLine(line);
    if (normalized === null || normalized.startsWith('#') || GUARDRAILS_MANAGED_RULE_SET.has(normalized)) return;
    const content = normalized.replace(/^- \[( |x)\]\s+/, '');
    entries.push({ id: entryId('guardrails', content), content, start: index, end: index + 1 });
  });
  return entries;
}

/** Top-level bullets; continuation lines and sub-bullets belong to the preceding decision. */
function decisionEntries(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  let fence = '';
  let current: { start: number } | undefined;
  const flush = (end: number) => {
    if (!current) return;
    let last = end;
    while (last > current.start && !lines[last - 1].trim()) last--;
    const body = lines.slice(current.start, last).map((line, index) =>
      index === 0 ? line.replace(/^[-*]\s+/, '') : line.replace(/^ {1,2}/, ''));
    const content = body.join('\n').trim();
    entries.push({ id: entryId('decisions', content), content, start: current.start, end: last });
    current = undefined;
  };
  lines.forEach((line, index) => {
    // A blank line followed by unindented text ends the decision, even when that text is a fence.
    if (!fence && current && /^\S/.test(line) && index > 0 && !lines[index - 1].trim()) flush(index);
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      return;
    }
    if (fence) return;
    if (line.startsWith('#')) flush(index);
    else if (/^[-*]\s+\S/.test(line)) { flush(index); current = { start: index }; }
  });
  flush(lines.length);
  return entries;
}

function moduleEntries(lines: string[]) {
  return projectStateLayout(lines).modules.map(module => {
    const content = lines.slice(module.start, module.end).join('\n').trim();
    const statusLine = lines.slice(module.start + 1, module.end).find(line => /^- status:/.test(line));
    return { ...module, id: module.name, content, version: digest(content),
      status: statusLine?.replace(/^- status:\s*/, '') };
  });
}

/** Callers write plain language; collapse it onto one line and drop markdown markers the store adds itself. */
function plain(value: string | undefined, label: string): string {
  const text = collapse(value ?? '').replace(/^#+\s*/, '').replace(/^(?:[-*]|\d+\.)\s+/, '')
    .replace(/^\[[ x]?\]\s*/, '').trim();
  if (!text) throw new Error(`${label} must be non-empty.`);
  return text;
}

function requireId(input: WriteMemoryInput): string {
  if (!input.id?.trim()) throw new Error(`${input.op} requires id; call get_memory({kind: "${input.kind}"}) for ids.`);
  return input.id.trim();
}

function notFound(kind: MemoryKind, id: string): Error {
  return new Error(`No ${kind} entry ${JSON.stringify(id)}; it may have been edited or removed. Call get_memory({kind: "${kind}"}) and retry with a current id.`);
}

/** Remove a range, collapsing only the blank-line pair it leaves; other formatting is untouched. */
function removeLines(lines: string[], start: number, end: number): void {
  lines.splice(start, end - start);
  if (start > 0 && !lines[start - 1].trim() && (start >= lines.length || !lines[start].trim())) lines.splice(start - 1, 1);
}

/** Replace or delete every copy of an entry from the bottom up so earlier ranges stay valid. */
function replaceCopies(lines: string[], copies: Entry[], target: Entry, rendered: string[]): void {
  for (const item of [...copies].sort((a, b) => b.start - a.start)) {
    if (item === target) lines.splice(item.start, item.end - item.start, ...rendered);
    else removeLines(lines, item.start, item.end);
  }
}

const unique = <T extends { id: string }>(items: T[]): T[] =>
  items.filter((item, index) => items.findIndex(other => other.id === item.id) === index);

/** Last non-blank line inside [start, end), or start - 1 when the range is blank. */
function lastContent(lines: string[], start: number, end: number): number {
  let index = end - 1;
  while (index >= start && !lines[index].trim()) index--;
  return index;
}

function writeFields(lines: string[], start: number, end: number, fields: ProjectStateFields): void {
  for (const field of PROJECT_STATE_FIELDS) {
    if (fields[field] === undefined) continue;
    const value = `- ${field}: ${plain(fields[field], `fields.${field}`)}`;
    const at = lines.findIndex((line, index) => index > start && index < end && line.startsWith(`- ${field}:`));
    if (at >= 0) {
      let stop = at + 1;
      while (stop < end && /^\s+\S/.test(lines[stop])) stop++;
      lines.splice(at, stop - at, value);
      end -= stop - at - 1;
    } else {
      const insert = lastContent(lines, start, end) + 1;
      lines.splice(insert, 0, value);
      end++;
    }
  }
}

export class MemoryStore {
  private constructor(readonly root: string, private readonly anchor: string) {}

  static async create(workspace: string): Promise<MemoryStore> {
    const root = await fs.realpath(path.resolve(workspace));
    let anchor: string;
    try { anchor = await fs.realpath(path.join(root, ANCHOR_DIR_NAME)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('No Memory Anchor workspace at the server startup directory. Initialize it with anchor init, or configure --workspace.');
      }
      throw error;
    }
    const rel = path.relative(root, anchor);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path must stay inside the configured workspace.');
    if (!(await fs.stat(anchor)).isDirectory()) throw new Error('Initialize this workspace with anchor init first.');
    return new MemoryStore(root, anchor);
  }

  private file(kind: MemoryKind): string {
    return path.join(this.anchor, path.posix.basename(FILES[kind]));
  }

  private async read(kind: MemoryKind): Promise<Doc> {
    const file = this.file(kind);
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], eol: '\n', exists: false, modifiedAt: null };
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${FILES[kind]} must be a regular file.`);
    if (stat.size > MAX_MEMORY_BYTES) throw new Error(`${FILES[kind]} exceeds the 2 MiB limit.`);
    const content = await fs.readFile(file, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    return { lines, eol: content.includes('\r\n') ? '\r\n' : '\n', exists: true, modifiedAt: stat.mtime.toISOString() };
  }

  private async save(kind: MemoryKind, doc: Doc, lines: string[]): Promise<void> {
    const file = this.file(kind);
    const temp = path.join(this.anchor, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.writeFile(temp, lines.join(doc.eol) + doc.eol, 'utf8');
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  /** Serialize writers across MCP processes; a crashed writer's lock expires. */
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = path.join(this.anchor, '.memory.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.stat(lock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) { await fs.rm(lock, { force: true }); continue; }
        if (Date.now() > deadline) throw new Error('Memory files are locked by another writer; retry shortly.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try { return await operation(); }
    finally { await fs.rm(lock, { force: true }); }
  }

  private entries(kind: 'guardrails' | 'decisions', lines: string[]): Entry[] {
    return kind === 'guardrails' ? guardrailEntries(lines) : decisionEntries(lines);
  }

  async get(kind?: MemoryKind, id?: string) {
    if (id !== undefined) return this.getOne(kind ?? inferMemoryKind(id), id);
    if (kind === undefined) {
      const [guardrails, decisions, state] = await Promise.all(MEMORY_KINDS.map(item => this.read(item)));
      return {
        guardrails: { path: FILES.guardrails, entries: unique(guardrailEntries(guardrails.lines)).map(({ id: key, content }) => ({ id: key, content })) },
        decisions: { path: FILES.decisions, entries: unique(decisionEntries(decisions.lines)).map(({ id: key, content }) =>
          ({ id: key, summary: content.length > 160 ? `${collapse(content).slice(0, 157)}...` : collapse(content) })) },
        project_state: { path: FILES.project_state, modules: moduleEntries(state.lines).map(({ id: key, version, status }) => ({ id: key, version, status })) },
      };
    }
    const doc = await this.read(kind);
    const base = { kind, path: FILES[kind], modifiedAt: doc.modifiedAt };
    if (kind === 'project_state') {
      return { ...base, modules: moduleEntries(doc.lines).map(({ id: key, version, status }) => ({ id: key, version, status })) };
    }
    return { ...base, entries: unique(this.entries(kind, doc.lines)).map(({ id: key, content }) => ({ id: key, content })) };
  }

  private async getOne(kind: MemoryKind, id: string) {
    const doc = await this.read(kind);
    const base = { kind, path: FILES[kind], modifiedAt: doc.modifiedAt };
    if (kind === 'project_state') {
      const matches = moduleEntries(doc.lines).filter(module => module.id === id);
      if (!matches.length) throw notFound(kind, id);
      if (matches.length > 1) throw new Error('Duplicate module headings; use unique names in project-state.md.');
      return { ...base, entry: { id, version: matches[0].version, content: matches[0].content } };
    }
    const entry = this.entries(kind, doc.lines).find(item => item.id === id);
    if (!entry) throw notFound(kind, id);
    return { ...base, entry: { id, content: entry.content } };
  }

  async write(input: WriteMemoryInput) {
    if (!MEMORY_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${MEMORY_KINDS.join(', ')}.`);
    return this.locked(async () => {
      const doc = await this.read(input.kind);
      const lines = [...doc.lines];
      const outcome = input.kind === 'project_state'
        ? this.writeModule(input, lines)
        : this.writeEntry(input, lines);
      if (!outcome.written) return { kind: input.kind, op: input.op, path: FILES[input.kind], ...outcome };
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      await this.save(input.kind, doc, lines);
      const notice = await this.notice();
      return { written: true, kind: input.kind, op: input.op, path: FILES[input.kind], id: outcome.id,
        ...(notice ? { warning: notice } : {}) };
    });
  }

  private writeEntry(input: WriteMemoryInput, lines: string[]):
    { written: true; id: string } | { written: false; [key: string]: unknown } {
    const kind = input.kind as 'guardrails' | 'decisions';
    if (input.fields !== undefined) throw new Error('fields apply only to project_state; use content.');
    const entries = this.entries(kind, lines);
    let target: Entry | undefined;
    if (input.op !== 'add') {
      const id = requireId(input);
      target = entries.find(item => item.id === id);
      if (!target) throw notFound(kind, id);
    }
    if (input.op === 'remove') {
      for (const item of entries.filter(entry => entry.id === target!.id).reverse()) removeLines(lines, item.start, item.end);
      return { written: true, id: target!.id };
    }
    const content = kind === 'guardrails'
      ? plain(input.content, 'content')
      : (input.content ?? '').trim().replace(/^#+\s*/, '').replace(/^(?:[-*]|\d+\.)\s+/, '');
    if (!content) throw new Error('content must be non-empty.');
    const id = entryId(kind, content);
    const existing = entries.find(item => item.id === id);
    if (existing && existing !== target) return { written: false, reason: 'duplicate', id, hint: 'An identical entry already exists.' };
    if (input.op === 'add' && !input.force) {
      const similar = entries.map(item => ({ id: item.id, content: item.content, similarity: Number(similarity(content, item.content).toFixed(2)) }))
        .filter(item => item.similarity >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity).slice(0, 3);
      if (similar.length) {
        return { written: false, reason: 'similar_entries', similar,
          hint: 'Merge into an existing entry with op "update", or retry with force: true when the new entry is distinct.' };
      }
    }
    const rendered = kind === 'guardrails'
      ? [`- [ ] ${content}`]
      : content.split(/\r?\n/).map((line, index) => index === 0 ? `- ${line}` : line.trim() ? `  ${line}` : '');
    if (target) {
      replaceCopies(lines, entries.filter(entry => entry.id === target!.id), target, rendered);
    } else if (kind === 'guardrails') {
      if (!lines.some(line => line.trim())) lines.splice(0, lines.length, GUARDRAILS_SPECIFIC_TITLE);
      lines.splice(lastContent(lines, 0, lines.length) + 1, 0, ...rendered);
    } else {
      if (!lines.some(line => line.trim())) lines.splice(0, lines.length, '# Key Decisions');
      lines.splice(lastContent(lines, 0, lines.length) + 1, 0, '', ...rendered);
    }
    return { written: true, id };
  }

  private writeModule(input: WriteMemoryInput, lines: string[]):
    { written: true; id: string } | { written: false; [key: string]: unknown } {
    if (input.content !== undefined) throw new Error('project_state uses fields, not content.');
    const name = plain(input.id, 'id (module name)');
    const modules = moduleEntries(lines);
    const matches = modules.filter(module => module.id === name);
    if (matches.length > 1) throw new Error('Duplicate module headings; use unique names in project-state.md.');
    const target = matches[0];
    if (input.op === 'add') {
      const clash = modules.find(module => module.id.toLowerCase() === name.toLowerCase());
      if (clash) return { written: false, reason: 'duplicate', id: clash.id, version: clash.version, hint: 'The module exists; use op "update".' };
      const fields = input.fields ?? {};
      if (!PROJECT_STATE_FIELDS.some(field => fields[field] !== undefined)) throw new Error('add requires at least one field.');
      const block = [`### ${name}`];
      writeFields(block, 0, 1, fields);
      const layout = projectStateLayout(lines);
      if (layout.status) {
        const at = lastContent(lines, layout.status.start, layout.status.end) + 1;
        lines.splice(at, 0, '', ...block, ...(at < lines.length && lines[at].trim() ? [''] : []));
      } else {
        lines.push(...(lines.some(line => line.trim()) ? [''] : []), '## Module Status', '', ...block);
      }
      return { written: true, id: name };
    }
    if (!target) throw notFound('project_state', name);
    if (input.version !== undefined && input.version !== target.version) {
      throw new Error(`Module ${JSON.stringify(name)} changed since version ${input.version} (now ${target.version}); call get_memory again and reapply the change.`);
    }
    if (input.op === 'remove') {
      removeLines(lines, target.start, target.end);
      return { written: true, id: name };
    }
    if (!input.fields || !PROJECT_STATE_FIELDS.some(field => input.fields![field] !== undefined)) {
      throw new Error('update requires at least one field.');
    }
    writeFields(lines, target.start, target.end, input.fields);
    return { written: true, id: name };
  }

  private async notice(): Promise<string> {
    const read = async (kind: MemoryKind) => (await this.read(kind)).lines.join('\n');
    const guardrails = guardrailEntries((await read('guardrails')).split('\n')).map(entry => `- [ ] ${entry.content}`).join('\n');
    return memoryMaintenanceNotice(guardrails, await read('project_state'));
  }
}
