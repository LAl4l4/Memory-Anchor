import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitChange } from './captureGitChanges.js';

interface RefreshCheckpoint {
    version: 1;
    artifacts: string;
    files: Record<string, string>;
}

interface CapturedRefresh {
    workdir: string;
    files: Record<string, string>;
}

// Keep metadata out of the public GitChange shape. Only a successful caller
// holding this exact captured batch may advance the checkpoint.
const captured = new WeakMap<readonly GitChange[], CapturedRefresh>();

function checkpointPath(workdir: string): string {
    return path.join(workdir, '.memoryanchor', 'refresh-checkpoint.json');
}

function fingerprint(file: string): string {
    try {
        const stat = fs.statSync(file, { bigint: true });
        return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
        throw error;
    }
}

function artifactFingerprint(workdir: string): string {
    return ['dirTree.json', 'dependencyGraph.json', 'index.md']
        .map(file => fingerprint(path.join(workdir, '.memoryanchor', file))).join('|');
}

function loadCheckpoint(workdir: string): Record<string, string> {
    try {
        const state = JSON.parse(fs.readFileSync(checkpointPath(workdir), 'utf8')) as RefreshCheckpoint;
        if (state.version !== 1 || state.artifacts !== artifactFingerprint(workdir)
            || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) return {};
        return Object.fromEntries(Object.entries(state.files).filter(([file, value]) =>
            typeof value === 'string' && !path.isAbsolute(file)
            && !file.split('/').includes('..') && !file.startsWith('.memoryanchor/')));
    } catch {
        return {};
    }
}

export function selectChangesSinceRefresh(changes: GitChange[], workdir: string): GitChange[] | null {
    const previous = loadCheckpoint(workdir);
    const candidates = new Map(changes.map(change => [change.file, change]));
    // A reverted or committed path can disappear from git status while its
    // on-disk contents differ from the last chart. Check previously seen paths.
    for (const file of Object.keys(previous)) {
        if (!candidates.has(file)) candidates.set(file, { status: 'M', file });
    }
    const files: Record<string, string> = Object.create(null);
    const selected: GitChange[] = [];
    const dirtyPaths = new Set(changes.map(change => change.file));
    for (const [file, change] of candidates) {
        const current = fingerprint(path.resolve(workdir, file));
        const pending = previous[file]?.startsWith('pending:') ?? false;
        if (pending || previous[file] !== current) {
            selected.push({ ...change, status: current === 'missing' ? 'D' : change.status });
        }
        // Retain paths until a later capture sees them clean and unchanged.
        if (dirtyPaths.has(file) || previous[file] !== current) files[file] = current;
    }
    if (selected.length === 0) return null;
    captured.set(selected, { workdir, files });
    return selected;
}

export function acknowledgeRefresh(changes: readonly GitChange[], workdir: string): void {
    const batch = captured.get(changes);
    if (!batch || batch.workdir !== workdir) return;
    const target = checkpointPath(workdir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const state: RefreshCheckpoint = {
        version: 1, artifacts: artifactFingerprint(workdir),
        // Keep a pending marker for edits during rendering, including a revert
        // that has already disappeared from Git status by acknowledgement time.
        files: Object.fromEntries(Object.entries(batch.files).map(([file, value]) => {
            const current = fingerprint(path.resolve(workdir, file));
            return [file, current === value ? current : `pending:${current}`];
        })),
    };
    const temporary = `${target}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        fs.renameSync(temporary, target);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
    captured.delete(changes);
}
