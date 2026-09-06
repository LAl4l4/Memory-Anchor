import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acknowledgeRefresh, selectChangesSinceRefresh } from './refreshCheckpoint.js';
import { ANCHOR_DIR_NAME, UNTRACKED_FILE_WATCH_FILE_NAME } from '../constant.js';

interface GitChange {
    status: 'M' | 'A' | '??' | string;
    file: string;
}

interface UntrackedFileWatch {
    version: 1;
    files: string[];
}

function normalizeRelativePath(file: string): string {
    // Git already uses '/' separators, even on Windows. A backslash may be
    // part of a real POSIX filename and must not be rewritten.
    return file.replace(/^\.\//, '');
}

function isAnchorInternalPath(file: string): boolean {
    const normalized = normalizeRelativePath(file);
    return normalized === ANCHOR_DIR_NAME || normalized.startsWith(`${ANCHOR_DIR_NAME}/`);
}

function getUntrackedWatchPath(workdir: string): string {
    return path.join(workdir, ANCHOR_DIR_NAME, UNTRACKED_FILE_WATCH_FILE_NAME);
}

function loadUntrackedWatch(workdir: string): Set<string> {
    try {
        const parsed = JSON.parse(
            fs.readFileSync(getUntrackedWatchPath(workdir), 'utf-8')
        ) as Partial<UntrackedFileWatch>;
        if (parsed.version !== 1 || !Array.isArray(parsed.files)) return new Set();
        return new Set(parsed.files
            .filter((file): file is string => typeof file === 'string')
            .map(normalizeRelativePath)
            .filter(file => !isAnchorInternalPath(file))
        );
    } catch {
        return new Set();
    }
}

function persistUntrackedWatch(workdir: string, files: ReadonlySet<string>): void {
    const watchPath = getUntrackedWatchPath(workdir);
    if (files.size === 0) {
        fs.rmSync(watchPath, { force: true });
        return;
    }

    fs.mkdirSync(path.dirname(watchPath), { recursive: true });
    const watch: UntrackedFileWatch = {
        version: 1,
        files: [...files].sort((left, right) => left.localeCompare(right)),
    };
    fs.writeFileSync(watchPath, `${JSON.stringify(watch, null, 2)}\n`, 'utf-8');
}

/**
 * Keep untracked paths visible long enough to report a later deletion that
 * Git cannot describe after a never-tracked file disappears.
 */
function reconcileUntrackedWatch(
    changes: GitChange[],
    workdir: string
): GitChange[] {
    const watchedFiles = loadUntrackedWatch(workdir);
    for (const change of changes) {
        const file = normalizeRelativePath(change.file);
        if (change.status === '??' && !isAnchorInternalPath(file)) {
            watchedFiles.add(file);
        }
    }

    // One Git process for the whole watch set, instead of one per file.
    const trackedFiles = watchedFiles.size > 0
        ? new Set(execFileSync('git', ['ls-files', '-z'], {
            cwd: workdir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        }).split('\0'))
        : new Set<string>();
    const reportedPaths = new Set(changes.map(change => normalizeRelativePath(change.file)));
    for (const file of watchedFiles) {
        // A staged or committed path no longer needs repeated existence scans.
        if (trackedFiles.has(file)) {
            watchedFiles.delete(file);
            continue;
        }

        if (!fs.existsSync(path.resolve(workdir, file))) {
            if (!reportedPaths.has(file)) {
                changes.push({ status: 'D', file });
                reportedPaths.add(file);
            }
        }
    }

    persistUntrackedWatch(workdir, watchedFiles);
    return changes;
}

/** Confirm deletions only after the corresponding chart refresh succeeds. */
function acknowledgeGitChanges(changes: readonly GitChange[], workdir = process.cwd()): void {
    acknowledgeRefresh(changes, workdir);
    const watchedFiles = loadUntrackedWatch(workdir);
    let updated = false;
    for (const change of changes) {
        const file = normalizeRelativePath(change.file);
        if (change.status === 'D' && !fs.existsSync(path.resolve(workdir, file))) {
            updated = watchedFiles.delete(file) || updated;
        }
    }
    if (updated) persistUntrackedWatch(workdir, watchedFiles);
}

function captureGitChanges(): GitChange[] | null {
    try {
        const gitStatus = execFileSync(
            'git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
            { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
        );

        const records = gitStatus.split('\0');
        const parsed: GitChange[] = [];
        for (let index = 0; index < records.length; index++) {
            const record = records[index];
            if (!record) continue;
            const status = record.slice(0, 2);
            parsed.push({ status: status.trim(), file: record.slice(3) });
            // In -z format the destination comes first, followed by a separate
            // source record. Copies retain their source; renames remove it.
            if (/[RC]/.test(status)) {
                const source = records[++index];
                if (!source) throw new Error('Missing Git rename/copy source path');
                if (status.includes('R')) parsed.push({ status: 'D', file: source });
            }
        }
        const changes = parsed.filter(change => !isAnchorInternalPath(change.file));

        const reconciled = reconcileUntrackedWatch(changes, process.cwd());
        return selectChangesSinceRefresh(reconciled, process.cwd());
    } catch (e) {
        return null;
    }
}

export { captureGitChanges, acknowledgeGitChanges, GitChange };
