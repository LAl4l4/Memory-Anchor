import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { IGNORED_DIR_NAMES, IGNORED_FILE_NAMES } from '../constant.js';
import type { DirectoryTreeRegistryNode } from '../chartBuild/partition/directoryTree.js';

export const ANCHOR_IGNORE_FILE = '.memoryanchorignore';
const IGNORE_STATE_FILE = 'ignore-state.json';

interface IgnoreState {
    version: 1;
    files: Record<string, string | null>;
}

function readRules(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
    }
}

/** One scan's cached rules. Anchor exclusions supplement Git exclusions. */
export class IgnorePolicy {
    private readonly root: string;
    private readonly gitRules = new Map<string, Ignore>();
    private readonly directories = new Map<string, boolean>();
    private readonly files: Record<string, string | null> = Object.create(null);
    private readonly anchorRules: Ignore;

    constructor(projectRoot: string) {
        this.root = path.resolve(projectRoot);
        this.anchorRules = ignore().add(this.read(ANCHOR_IGNORE_FILE) ?? '');
        this.rulesFor('.');
    }

    private read(relativeFile: string): string | null {
        const content = readRules(path.join(this.root, relativeFile));
        if (content !== null || !relativeFile.includes('/')) this.files[relativeFile] = content;
        return content;
    }

    private rulesFor(directory: string): Ignore {
        let rules = this.gitRules.get(directory);
        if (!rules) {
            rules = ignore().add(this.read(path.posix.join(directory, '.gitignore')) ?? '');
            this.gitRules.set(directory, rules);
        }
        return rules;
    }

    isIgnored(file: string, directory = false): boolean {
        const relative = path.relative(this.root, path.resolve(this.root, file))
            .split(path.sep).join('/');
        if (!relative) return false;
        if (relative === '..' || relative.startsWith('../')) return true;
        const segments = relative.split('/');
        if (segments.some(segment => IGNORED_DIR_NAMES.has(segment))
            || IGNORED_FILE_NAMES.has(segments[segments.length - 1])) return true;

        const candidate = directory ? `${relative}/` : relative;
        if (this.anchorRules.ignores(candidate)) return true;
        if (directory && this.directories.has(relative)) return this.directories.get(relative)!;

        const parent = path.posix.dirname(relative);
        // Rules inside an excluded directory cannot re-include its children.
        if (parent !== '.' && this.isIgnored(parent, true)) return true;
        const ancestors = ['.'];
        for (let index = 1; index < segments.length; index++) {
            ancestors.push(segments.slice(0, index).join('/'));
        }
        let excluded = false;
        for (const ancestor of ancestors) {
            const local = path.posix.relative(ancestor, relative) + (directory ? '/' : '');
            const result = this.rulesFor(ancestor).test(local);
            if (result.ignored || result.unignored) excluded = result.ignored;
        }
        if (directory) this.directories.set(relative, excluded);
        return excluded;
    }

    snapshot(): IgnoreState {
        return { version: 1, files: Object.fromEntries(
            Object.entries(this.files).sort(([left], [right]) => left.localeCompare(right))
        ) };
    }
}

function statePath(projectRoot: string): string {
    return path.join(projectRoot, '.memoryanchor', IGNORE_STATE_FILE);
}

/** Advance only after all charts and the dependency graph were written. */
export function persistIgnoreState(projectRoot: string, state: IgnoreState): void {
    fs.writeFileSync(statePath(projectRoot), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Known rules are also checked when Git hides them or a change was committed. */
export function getIgnorePolicyChanges(projectRoot: string, changedFiles: readonly string[] = []): string[] {
    let state: IgnoreState;
    try {
        state = JSON.parse(fs.readFileSync(statePath(projectRoot), 'utf8')) as IgnoreState;
        if (state.version !== 1 || !state.files || typeof state.files !== 'object'
            || Array.isArray(state.files)
            || !Object.hasOwn(state.files, '.gitignore')
            || !Object.hasOwn(state.files, ANCHOR_IGNORE_FILE)
            || Object.entries(state.files).some(([file, value]) =>
                path.isAbsolute(file) || file.split('/').includes('..')
                || (value !== null && typeof value !== 'string')
                || (file !== ANCHOR_IGNORE_FILE && path.posix.basename(file) !== '.gitignore')
            )) throw new Error('Invalid ignore state');
    } catch {
        // Older initialized workspaces migrate on their next refresh.
        try {
            const tree = JSON.parse(fs.readFileSync(
                path.join(projectRoot, '.memoryanchor', 'dirTree.json'), 'utf8'
            )) as Partial<DirectoryTreeRegistryNode>;
            return tree.directory === '.' && Array.isArray(tree.children) ? [ANCHOR_IGNORE_FILE] : [];
        } catch {
            return [];
        }
    }
    const candidates = new Set(Object.keys(state.files));
    // Probe the existing physical directory registry, without walking source
    // trees. This catches new rules that hide themselves from Git status.
    try {
        const pending: DirectoryTreeRegistryNode[] = [JSON.parse(fs.readFileSync(
            path.join(projectRoot, '.memoryanchor', 'dirTree.json'), 'utf8'
        ))];
        while (pending.length > 0) {
            const node = pending.pop()!;
            if (typeof node.directory !== 'string' || path.isAbsolute(node.directory)
                || node.directory.split('/').includes('..') || !Array.isArray(node.children)) break;
            candidates.add(path.posix.join(node.directory, '.gitignore'));
            pending.push(...node.children);
        }
    } catch {
        // Topology validation and its full-build fallback belong to the updater.
    }
    for (const file of changedFiles) {
        const relative = path.relative(projectRoot, path.resolve(projectRoot, file)).split(path.sep).join('/');
        if (relative === '..' || relative.startsWith('../')) continue;
        if (path.posix.basename(relative) === '.gitignore') candidates.add(relative);
        let directory = path.posix.dirname(relative);
        while (directory !== '.') {
            candidates.add(path.posix.join(directory, '.gitignore'));
            directory = path.posix.dirname(directory);
        }
    }
    return [...candidates].filter(file => readRules(path.join(projectRoot, file)) !== (state.files[file] ?? null));
}
