import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
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
    return file.split(/[\\/]/).join('/').replace(/^\.\//, '');
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

function isTrackedFile(workdir: string, file: string): boolean {
    try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', file], {
            cwd: workdir,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
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

    const reportedPaths = new Set(changes.map(change => normalizeRelativePath(change.file)));
    for (const file of watchedFiles) {
        // A staged or committed path no longer needs repeated existence scans.
        if (isTrackedFile(workdir, file)) {
            watchedFiles.delete(file);
            continue;
        }

        if (!fs.existsSync(path.resolve(workdir, file))) {
            watchedFiles.delete(file);
            if (!reportedPaths.has(file)) {
                changes.push({ status: 'D', file });
                reportedPaths.add(file);
            }
        }
    }

    persistUntrackedWatch(workdir, watchedFiles);
    return changes;
}

function captureGitChanges(): GitChange[] | null {
    try {
        const gitStatus = execSync(
            'git status --porcelain --untracked-files=all',
            { encoding: 'utf-8' }
        ).trim();

        const changes = gitStatus ? gitStatus.split('\n').map((line): GitChange => {
            const trimmed = line.trim();
            const parts = trimmed.split(/\s+/);
            return {
                status: parts[0],
                file: parts[1]
            };
        }).filter(change => !isAnchorInternalPath(change.file)) : [];

        const reconciled = reconcileUntrackedWatch(changes, process.cwd());
        return reconciled.length > 0 ? reconciled : null;
    } catch (e) {
        return null;
    }
}

export { captureGitChanges, GitChange };
