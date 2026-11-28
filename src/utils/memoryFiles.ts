import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Cross-process write lock and atomic replacement for the memory files in `.memoryanchor/`
 * (guardrails.md, decisions.md, project-state.md). Every writer — MCP write_memory, init migrations
 * and `anchor maintain --normalize` — goes through withMemoryLock + writeFileAtomic; readers take no
 * lock and rely on rename replacing a file in one step.
 *
 * Lock file `.memory.lock` holds {token, pid, host}. It is created with O_EXCL, its mtime is refreshed
 * while held, and it is released only by the token that owns it. A lock counts as stale when its owner
 * process is gone (same host) or its heartbeat stopped for STALE_LOCK_MS. Stale locks are broken under a
 * separate `.memory.lock.break` lock and only after re-checking that the same lock is still in place,
 * so two waiters can never both take over, and a lock that was renewed meanwhile is never removed.
 */

export const MEMORY_LOCK_FILE_NAME = '.memory.lock';

export interface MemoryLockOptions {
  /** How long to wait for another writer before giving up. */
  timeoutMs?: number;
  /** Heartbeat age after which a lock whose owner cannot be checked is treated as abandoned. */
  staleMs?: number;
  /** How often the holder refreshes the lock's mtime. */
  heartbeatMs?: number;
}

export interface MemoryLock {
  readonly token: string;
  /** Throws MemoryLockLostError when the lock file no longer carries this holder's token. */
  assertHeld(): Promise<void>;
}

export class MemoryLockLostError extends Error {}

const DEFAULTS = { timeoutMs: 10_000, staleMs: 30_000, heartbeatMs: 5_000 };
const RETRY_MS = 25;
/** The break lock is held for a few file operations; one older than this belongs to a crashed breaker. */
const BREAK_STALE_MS = 5_000;

interface LockOwner { token: string; pid: number; host: string }
interface LockSnapshot { owner: LockOwner | null; raw: string; mtimeMs: number }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

function newOwner(): LockOwner {
  return { token: `${process.pid}-${randomBytes(8).toString('hex')}`, pid: process.pid, host: os.hostname() };
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw);
    return typeof value?.token === 'string' && Number.isInteger(value.pid) && value.pid > 0 && typeof value.host === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Current lock file contents, or null when there is none. */
async function inspect(file: string): Promise<LockSnapshot | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { owner: parseOwner(raw), raw, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return errorCode(error) === 'EPERM';
  }
}

function isStale(lock: LockSnapshot, staleMs: number): boolean {
  if (lock.owner && lock.owner.host === os.hostname() && !processAlive(lock.owner.pid)) return true;
  // Other hosts, reused pids and half-written lock files: rely on the heartbeat having stopped.
  return Date.now() - lock.mtimeMs > staleMs;
}

const sameLock = (a: LockSnapshot, b: LockSnapshot) => (a.owner && b.owner ? a.owner.token === b.owner.token : a.raw === b.raw && a.mtimeMs === b.mtimeMs);

async function createExclusive(file: string, owner: LockOwner): Promise<boolean> {
  try {
    await fs.writeFile(file, JSON.stringify(owner), { flag: 'wx' });
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Remove `lockFile` if it is still the stale lock `seen`. Returns true when the caller should retry
 * acquisition at once (lock removed or changed), false when it should wait.
 */
async function breakStaleLock(lockFile: string, seen: LockSnapshot, staleMs: number): Promise<boolean> {
  const breakFile = `${lockFile}.break`;
  const breaker = newOwner();
  if (!(await createExclusive(breakFile, breaker))) {
    const other = await inspect(breakFile);
    if (other && isStale(other, BREAK_STALE_MS)) await fs.rm(breakFile, { force: true });
    return false;
  }
  try {
    const current = await inspect(lockFile);
    if (!current) return true;
    if (!sameLock(seen, current) || !isStale(current, staleMs)) return !sameLock(seen, current);
    // Move the stale lock aside and confirm it is the one we judged before deleting it.
    const grave = `${lockFile}.stale-${breaker.token}`;
    try {
      await fs.rename(lockFile, grave);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      throw error;
    }
    const moved = await inspect(grave);
    if (moved && !sameLock(seen, moved)) {
      // Not the lock we judged stale: put it back untouched (link fails if a new lock appeared meanwhile).
      await fs.link(grave, lockFile).catch(() => {});
    }
    await fs.rm(grave, { force: true });
    return true;
  } finally {
    const mine = await inspect(breakFile).catch(() => null);
    if (mine?.owner?.token === breaker.token) await fs.rm(breakFile, { force: true });
  }
}

function describeHolder(lock: LockSnapshot | null): string {
  if (!lock?.owner) return 'another writer';
  return `pid ${lock.owner.pid}${lock.owner.host === os.hostname() ? '' : ` on ${lock.owner.host}`}`;
}

/** Run `operation` while holding the memory write lock of `anchorDir` (the `.memoryanchor` directory). */
export async function withMemoryLock<T>(
  anchorDir: string,
  operation: (lock: MemoryLock) => Promise<T>,
  options: MemoryLockOptions = {},
): Promise<T> {
  const { timeoutMs, staleMs, heartbeatMs } = { ...DEFAULTS, ...options };
  const lockFile = path.join(anchorDir, MEMORY_LOCK_FILE_NAME);
  const owner = newOwner();
  const deadline = Date.now() + timeoutMs;

  while (!(await createExclusive(lockFile, owner))) {
    const seen = await inspect(lockFile);
    if (!seen) continue;
    if (isStale(seen, staleMs) && (await breakStaleLock(lockFile, seen, staleMs))) continue;
    if (Date.now() > deadline) {
      throw new Error(`Memory files are locked by ${describeHolder(seen)}; retry shortly.`);
    }
    await sleep(RETRY_MS);
  }

  const held = async () => (await inspect(lockFile).catch(() => null))?.owner?.token === owner.token;
  const heartbeat = setInterval(() => {
    void (async () => {
      if (await held()) {
        const now = new Date();
        await fs.utimes(lockFile, now, now).catch(() => {});
      }
    })();
  }, heartbeatMs);
  heartbeat.unref();

  const lock: MemoryLock = {
    token: owner.token,
    async assertHeld() {
      if (!(await held())) {
        throw new MemoryLockLostError('Lost the memory write lock before saving (another writer took it over); nothing was written. Retry.');
      }
    },
  };

  try {
    return await operation(lock);
  } finally {
    clearInterval(heartbeat);
    // Release only our own lock; one taken over by another writer stays theirs.
    if (await held()) await fs.rm(lockFile, { force: true });
  }
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800];

/**
 * fs.rename that tolerates Windows' transient refusals: replacing a file another process has open
 * (an editor, an indexer, antivirus) fails with EPERM/EBUSY/EACCES until that handle closes. On other
 * platforms those codes are permanent, so they fail at once.
 */
export async function renameReplacing(
  from: string,
  to: string,
  deps: { rename?: typeof fs.rename; platform?: NodeJS.Platform; delaysMs?: number[] } = {},
): Promise<void> {
  const rename = deps.rename ?? fs.rename;
  const delays = (deps.platform ?? process.platform) === 'win32' ? (deps.delaysMs ?? RENAME_RETRY_DELAYS_MS) : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= delays.length || !RETRYABLE_RENAME_CODES.has(errorCode(error) ?? '')) throw error;
      await sleep(delays[attempt]);
    }
  }
}

/**
 * Replace `file` in one step: write a sibling temp file, then rename it over the target, so readers
 * see either the old or the new complete content. `beforeRename` runs between the two (e.g. to check
 * the write lock is still held).
 */
export async function writeFileAtomic(
  file: string,
  content: string,
  options: { beforeRename?: () => Promise<void> } = {},
): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temp, content, 'utf8');
    await options.beforeRename?.();
    await renameReplacing(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
