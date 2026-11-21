import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { glob, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_GREP_FILE_BYTES = 1_000_000;
const DEFAULT_READ_LINES = 400;

export class ToolError extends Error {}

/** Resolve a model-supplied path and refuse anything outside the workspace. */
export function resolveInWorkspace(workspace, p = '.') {
  const abs = path.resolve(workspace, String(p));
  const rel = path.relative(workspace, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError(`Path escapes the workspace: ${p}`);
  return { abs, rel: rel === '' ? '.' : rel.split(path.sep).join('/') };
}

async function isBinary(abs) {
  const handle = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function* walkFiles(root, relBase = '') {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(abs, rel);
    else if (entry.isFile()) yield { abs, rel };
  }
}

const listDir = {
  name: 'list_dir',
  kind: 'search',
  description: 'List files and directories under a workspace path (directories end with "/"). Skips .git and node_modules.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory, default "."' },
      depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Levels to descend, default 2' },
    },
    additionalProperties: false,
  },
  async run({ path: p = '.', depth = 2 }, ctx) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    if (!existsSync(abs)) throw new ToolError(`No such directory: ${rel}`);
    const lines = [];
    const limit = 500;
    const visit = async (dir, prefix, level) => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= limit) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const isDir = entry.isDirectory();
        lines.push(`${prefix}${entry.name}${isDir ? '/' : ''}`);
        if (isDir && level < depth) await visit(path.join(dir, entry.name), `${prefix}  `, level + 1);
      }
    };
    await visit(abs, '', 1);
    if (lines.length >= limit) lines.push(`[truncated at ${limit} entries; list a subdirectory]`);
    return { output: lines.join('\n') || '(empty directory)', meta: { listed: [rel] } };
  },
};

const readFileTool = {
  name: 'read_file',
  kind: 'read',
  description: `Read a text file with line numbers. Returns up to ${DEFAULT_READ_LINES} lines per call; use start_line/end_line for more.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run({ path: p, start_line: start = 1, end_line: end }, ctx) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    if (!existsSync(abs)) throw new ToolError(`No such file: ${rel}`);
    if ((await stat(abs)).isDirectory()) throw new ToolError(`${rel} is a directory; use list_dir.`);
    if (await isBinary(abs)) throw new ToolError(`${rel} looks binary.`);
    const all = (await readFile(abs, 'utf8')).split('\n');
    const last = Math.min(all.length, end ?? start + DEFAULT_READ_LINES - 1);
    const width = String(last).length;
    const body = all.slice(start - 1, last).map((line, i) => `${String(start + i).padStart(width)}\t${line}`).join('\n');
    const more = last < all.length ? `\n[... ${all.length - last} more lines; continue with start_line=${last + 1}]` : '';
    return { output: (body || '(empty range)') + more, meta: { read: [rel] } };
  },
};

const grepTool = {
  name: 'grep',
  kind: 'search',
  description: 'Search file contents with a JavaScript regular expression. Returns "path:line: text" matches (max 200).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regex source' },
      path: { type: 'string', description: 'Directory or file to search, default "."' },
      glob: { type: 'string', description: 'Only search files whose workspace-relative path matches, e.g. "src/**/*.ts"' },
      ignore_case: { type: 'boolean' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run({ pattern, path: p = '.', glob: fileGlob, ignore_case: ignoreCase = false }, ctx) {
    let regex;
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (error) {
      throw new ToolError(`Invalid regex: ${error.message}`);
    }
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    if (!existsSync(abs)) throw new ToolError(`No such path: ${rel}`);
    const files = (await stat(abs)).isFile()
      ? [{ abs, rel }]
      : walkFiles(abs, rel === '.' ? '' : rel);
    const matches = [];
    const matchedFiles = new Set();
    const limit = 200;
    for await (const file of files) {
      if (fileGlob && !path.matchesGlob(file.rel, fileGlob)) continue;
      const info = await stat(file.abs);
      if (info.size > MAX_GREP_FILE_BYTES || (await isBinary(file.abs))) continue;
      const lines = (await readFile(file.abs, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!regex.test(lines[i])) continue;
        matchedFiles.add(file.rel);
        matches.push(`${file.rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        if (matches.length >= limit) break;
      }
      if (matches.length >= limit) break;
    }
    const suffix = matches.length >= limit ? `\n[stopped at ${limit} matches; narrow the pattern or path]` : '';
    return { output: matches.length ? matches.join('\n') + suffix : 'No matches.', meta: { matched: [...matchedFiles] } };
  },
};

const globTool = {
  name: 'glob',
  kind: 'search',
  description: 'Find files by glob pattern relative to the workspace, e.g. "**/*.test.js". Max 500 results.',
  inputSchema: {
    type: 'object',
    properties: { pattern: { type: 'string' } },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run({ pattern }, ctx) {
    const results = [];
    for await (const entry of glob(pattern, {
      cwd: ctx.workspace,
      exclude: (name) => SKIP_DIRS.has(path.basename(String(name))),
    })) {
      const normalized = String(entry).split(path.sep).join('/');
      if (normalized.startsWith('..')) continue;
      results.push(normalized);
      if (results.length >= 500) break;
    }
    results.sort();
    return { output: results.length ? results.join('\n') : 'No files matched.', meta: { matched: results } };
  },
};

const writeFileTool = {
  name: 'write_file',
  kind: 'write',
  description: 'Create or overwrite a file with the given content. Prefer edit_file for changes to existing files.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run({ path: p, content }, ctx) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    const existed = existsSync(abs);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return {
      output: `${existed ? 'Overwrote' : 'Created'} ${rel} (${Buffer.byteLength(content, 'utf8')} bytes).`,
      meta: { written: [rel] },
    };
  },
};

const editFileTool = {
  name: 'edit_file',
  kind: 'write',
  description:
    'Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async run({ path: p, old_string: oldString, new_string: newString, replace_all: replaceAll = false }, ctx) {
    const { abs, rel } = resolveInWorkspace(ctx.workspace, p);
    if (!existsSync(abs)) throw new ToolError(`No such file: ${rel}. Use write_file to create it.`);
    if (oldString === newString) throw new ToolError('old_string and new_string are identical.');
    if (oldString === '') throw new ToolError('old_string must not be empty.');
    const text = await readFile(abs, 'utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) throw new ToolError(`old_string not found in ${rel}. Re-read the file and copy the text exactly.`);
    if (count > 1 && !replaceAll) {
      throw new ToolError(`old_string appears ${count} times in ${rel}; add surrounding context or set replace_all.`);
    }
    const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
    await writeFile(abs, updated, 'utf8');
    return { output: `Edited ${rel} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? 's' : ''}).`, meta: { written: [rel] } };
  },
};

function makeRunCommand(config) {
  const timeoutDefault = config.agent.commandTimeoutMs;
  // Never hand model API keys or other credentials to commands the model runs.
  const providers = Object.values(config.providers ?? {});
  const secretNames = new Set(providers.map((p) => p?.apiKeyEnv).filter(Boolean));
  const secretValues = new Set(providers.map((p) => p?.apiKey).filter(Boolean));
  const looksSecret = (key, value) =>
    secretNames.has(key) || secretValues.has(value) || /API_?KEY|AUTH_?TOKEN|SECRET|PASSWORD|ACCESS_?KEY/i.test(key);
  return {
    name: 'run_command',
    kind: 'exec',
    description: 'Run a shell command in the workspace root (e.g. tests, build). Returns exit code and combined stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    run({ command, timeout_ms: timeoutMs = timeoutDefault }, ctx) {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !looksSecret(key, value)));
      return new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', command], { cwd: ctx.workspace, env: { ...env, CI: '1' } });
        let output = '';
        let timedOut = false;
        const append = (chunk) => {
          if (output.length < 200_000) output += chunk.toString();
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          const status = timedOut ? `timed out after ${timeoutMs}ms` : `exit code ${code ?? signal}`;
          resolve({
            output: `[${status}]\n${output.trimEnd() || '(no output)'}`,
            isError: timedOut || code !== 0,
            meta: { commands: [command] },
          });
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ output: `Failed to start: ${error.message}`, isError: true, meta: { commands: [command] } });
        });
      });
    },
  };
}

/** Built-in tool set. run_command is omitted when agent.allowCommands is false. */
export function builtinTools(config) {
  const tools = [listDir, readFileTool, grepTool, globTool, writeFileTool, editFileTool];
  if (config.agent.allowCommands) tools.push(makeRunCommand(config));
  return tools;
}
