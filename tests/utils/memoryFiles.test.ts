import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MEMORY_LOCK_FILE_NAME, MemoryLockLostError, renameReplacing, withMemoryLock, writeFileAtomic,
} from '../../dist/utils/memoryFiles.js';

let anchorDir: string;
const lockFile = () => path.join(anchorDir, MEMORY_LOCK_FILE_NAME);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const lockJson = (pid: number, host = os.hostname(), token = `t-${pid}`) => JSON.stringify({ token, pid, host });
/** A pid that belonged to a process which has exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const errno = (code: string) => Object.assign(new Error(code), { code });

beforeEach(async () => {
  anchorDir = path.join(await mkdtemp(path.join(os.tmpdir(), 'anchor-lock-')), '.memoryanchor');
  await mkdir(anchorDir);
});

afterEach(async () => { await rm(path.dirname(anchorDir), { recursive: true, force: true }); });

test('serializes holders and removes the lock afterwards', async () => {
  let inside = 0;
  let maxInside = 0;
  await Promise.all(Array.from({ length: 8 }, () => withMemoryLock(anchorDir, async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await sleep(10);
    inside -= 1;
  })));
  expect(maxInside).toBe(1);
  expect(await readdir(anchorDir)).toEqual([]);
});

test('takes over at once from a lock whose owner process has exited', async () => {
  await writeFile(lockFile(), lockJson(deadPid()));
  const started = Date.now();
  await withMemoryLock(anchorDir, async () => {}, { timeoutMs: 2000 });
  expect(Date.now() - started).toBeLessThan(1000);
});

test('takes over a lock from another host only after its heartbeat stopped', async () => {
  await writeFile(lockFile(), lockJson(12345, 'other-host'));
  await expect(withMemoryLock(anchorDir, async () => {}, { timeoutMs: 200 })).rejects.toThrow('pid 12345 on other-host');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockFile(), old, old);
  await expect(withMemoryLock(anchorDir, async () => 'ok', { timeoutMs: 2000 })).resolves.toBe('ok');
});

test('waits for a live holder instead of breaking its lock', async () => {
  await writeFile(lockFile(), lockJson(process.pid));
  await expect(withMemoryLock(anchorDir, async () => {}, { timeoutMs: 200 })).rejects.toThrow(`locked by pid ${process.pid}`);
  expect(JSON.parse(await readFile(lockFile(), 'utf8')).token).toBe(`t-${process.pid}`);
});

test('many waiters breaking the same stale lock still enter one at a time', async () => {
  await writeFile(lockFile(), lockJson(deadPid()));
  let inside = 0;
  let maxInside = 0;
  await Promise.all(Array.from({ length: 10 }, () => withMemoryLock(anchorDir, async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await sleep(5);
    inside -= 1;
  }, { timeoutMs: 5000 })));
  expect(maxInside).toBe(1);
  expect(await readdir(anchorDir)).toEqual([]);
});

test('separate processes racing over a stale lock lose no increments', async () => {
  await writeFile(lockFile(), lockJson(deadPid()));
  const counter = path.join(anchorDir, 'counter.txt');
  await writeFile(counter, '0');
  const moduleUrl = new URL('../../dist/utils/memoryFiles.js', import.meta.url).href;
  const script = `
    const { withMemoryLock, writeFileAtomic } = await import(${JSON.stringify(moduleUrl)});
    const { readFile } = await import('node:fs/promises');
    for (let i = 0; i < 10; i += 1) {
      await withMemoryLock(${JSON.stringify(anchorDir)}, async () => {
        const value = Number(await readFile(${JSON.stringify(counter)}, 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 2));
        await writeFileAtomic(${JSON.stringify(counter)}, String(value + 1));
      }, { timeoutMs: 20000 });
    }`;
  const codes = await Promise.all(Array.from({ length: 4 }, () => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
    child.on('close', resolve);
  })));
  expect(codes).toEqual([0, 0, 0, 0]);
  expect(await readFile(counter, 'utf8')).toBe('40');
}, 30000);

test('releases only its own lock and refuses to save after losing it', async () => {
  const target = path.join(anchorDir, 'guardrails.md');
  await writeFile(target, 'original\n');
  await withMemoryLock(anchorDir, async (lock) => {
    await lock.assertHeld();
    // Another writer takes the lock over, e.g. after this process was suspended past the stale limit.
    await writeFile(lockFile(), lockJson(process.pid, os.hostname(), 'someone-else'));
    await expect(lock.assertHeld()).rejects.toBeInstanceOf(MemoryLockLostError);
    await expect(writeFileAtomic(target, 'clobbered\n', { beforeRename: () => lock.assertHeld() }))
      .rejects.toBeInstanceOf(MemoryLockLostError);
  });
  expect(await readFile(target, 'utf8')).toBe('original\n');
  expect(JSON.parse(await readFile(lockFile(), 'utf8')).token).toBe('someone-else');
  expect((await readdir(anchorDir)).sort()).toEqual([MEMORY_LOCK_FILE_NAME, 'guardrails.md']);
});

test('the holder keeps its lock fresh with a heartbeat', async () => {
  await withMemoryLock(anchorDir, async () => {
    const before = (await stat(lockFile())).mtimeMs;
    await sleep(250);
    expect((await stat(lockFile())).mtimeMs).toBeGreaterThan(before);
  }, { heartbeatMs: 50 });
});

test('retries a rename Windows refuses while the target is open, and only there', async () => {
  const failing = (codes: string[]) => {
    const calls: string[] = [];
    const rename = async (from: unknown) => {
      calls.push(String(from));
      const code = codes.shift();
      if (code) throw errno(code);
    };
    return { calls, rename: rename as any };
  };
  const win = failing(['EPERM', 'EBUSY']);
  await renameReplacing('a', 'b', { rename: win.rename, platform: 'win32', delaysMs: [1, 1, 1] });
  expect(win.calls).toHaveLength(3);

  const posix = failing(['EPERM']);
  await expect(renameReplacing('a', 'b', { rename: posix.rename, platform: 'darwin', delaysMs: [1] })).rejects.toThrow('EPERM');
  expect(posix.calls).toHaveLength(1);

  const other = failing(['ENOENT']);
  await expect(renameReplacing('a', 'b', { rename: other.rename, platform: 'win32', delaysMs: [1] })).rejects.toThrow('ENOENT');
  expect(other.calls).toHaveLength(1);

  const stuck = failing(['EBUSY', 'EBUSY', 'EBUSY']);
  await expect(renameReplacing('a', 'b', { rename: stuck.rename, platform: 'win32', delaysMs: [1, 1] })).rejects.toThrow('EBUSY');
  expect(stuck.calls).toHaveLength(3);
});

test('init migration waits for the memory lock held by a writer', async () => {
  // Run init's memory-file step in its own process, as `anchor init` would.
  const moduleUrl = new URL('../../dist/commands/initHelper/initPublic.js', import.meta.url).href;
  const script = `const { ensureAnchorFiles } = await import(${JSON.stringify(moduleUrl)});
    await ensureAnchorFiles(${JSON.stringify(anchorDir)}); process.stdout.write(String(Date.now()));`;
  let output = '';
  let released = 0;
  let exited: Promise<number | null> = Promise.resolve(null);
  await withMemoryLock(anchorDir, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    exited = new Promise(resolve => child.on('close', resolve));
    await sleep(500);
    expect(output).toBe('');
    released = Date.now();
  });
  expect(await exited).toBe(0);
  expect(Number(output)).toBeGreaterThanOrEqual(released);
  expect(await readFile(path.join(anchorDir, 'guardrails.md'), 'utf8')).toContain('Guardrails');
  expect((await readdir(anchorDir)).filter(name => name.includes('lock') || name.endsWith('.tmp'))).toEqual([]);
}, 20000);
