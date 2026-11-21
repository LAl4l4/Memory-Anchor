import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

function listFiles(root, rel = '') {
  if (!existsSync(path.join(root, rel))) return [];
  const out = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else out.push(child);
  }
  return out;
}

function runShell(command, cwd, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, CI: '1' } });
    let output = '';
    let timedOut = false;
    const append = (c) => {
      output += c;
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, ms: Date.now() - started, tail: output.slice(-4000) });
    });
  });
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Parse surefire TEST-*.xml reports into { "pkg.Class#method": passed|failed|error|skipped }. */
export function parseSurefireReports(reportsDir) {
  const results = {};
  if (!existsSync(reportsDir)) return results;
  for (const file of readdirSync(reportsDir).filter((f) => f.startsWith('TEST-') && f.endsWith('.xml'))) {
    const xml = readFileSync(path.join(reportsDir, file), 'utf8');
    const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = m[1];
      const name = unescapeXml((attrs.match(/\bname="([^"]*)"/) ?? [])[1] ?? '').replace(/\(.*\)$/, '');
      const cls = unescapeXml((attrs.match(/\bclassname="([^"]*)"/) ?? [])[1] ?? '');
      const body = m[3] ?? '';
      const status = /<failure\b/.test(body) ? 'failed' : /<error\b/.test(body) ? 'error' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
      results[`${cls}#${name}`] = status;
    }
  }
  return results;
}

function summarize(ids, results) {
  const failing = ids.filter((id) => results[id] !== 'passed');
  return { total: ids.length, passed: ids.length - failing.length, failing: failing.map((id) => `${id} (${results[id] ?? 'missing'})`) };
}

/** True when every line of `before` survives, in order, in `after` (the edit only inserted lines). */
function onlyAdditions(before, after) {
  const want = before.split('\n');
  let i = 0;
  for (const line of after.split('\n')) if (i < want.length && line === want[i]) i += 1;
  return i === want.length;
}

/**
 * Grade a workspace after the agent ran:
 *   detect edits to original tests → restore them (incl. hidden ones) → add hidden task tests → run the suite.
 * resolved = task tests pass; intact = resolved + every original test + every invariant test pass.
 * Edits to original tests are recorded but not penalised: the originals are restored before the run,
 * so an edit cannot change the grade, and adding tests to an existing class is good practice.
 */
export async function gradeWorkspace({ suite, task, ws, meta }) {
  const info = JSON.parse(readFileSync(path.join(meta, 'prepare.json'), 'utf8'));
  const originalRoot = path.join(meta, 'original-tests');
  const testRoot = path.join(ws, suite.testSourceRoot);
  const hidden = new Set(task.hide.map((h) => path.relative(suite.testSourceRoot, h).split(path.sep).join('/')));

  const tampered = [];
  for (const rel of listFiles(originalRoot)) {
    if (hidden.has(rel)) continue;
    const current = path.join(testRoot, rel);
    if (!existsSync(current)) tampered.push(`${rel} (deleted)`);
    else {
      const before = readFileSync(path.join(originalRoot, rel), 'utf8');
      const after = readFileSync(current, 'utf8');
      if (before !== after) tampered.push(`${rel} (${onlyAdditions(before, after) ? 'tests added' : 'modified'})`);
    }
  }
  cpSync(originalRoot, testRoot, { recursive: true });

  const hiddenDir = path.join(ws, suite.hiddenTestDir);
  rmSync(hiddenDir, { recursive: true, force: true });
  mkdirSync(hiddenDir, { recursive: true });
  cpSync(task.testsDir, hiddenDir, { recursive: true });

  const reportsDir = path.join(ws, suite.reportsDir);
  rmSync(reportsDir, { recursive: true, force: true });
  const testRun = await runShell(suite.testCommand, ws, suite.testTimeoutMs ?? 900_000);
  const results = parseSurefireReports(reportsDir);

  const originalClasses = new Set(info.originalTestClasses);
  const p2pIds = Object.keys(results).filter((id) => originalClasses.has(id.split('#')[0]) && results[id] !== 'skipped');
  const f2p = summarize(task.f2p, results);
  const invariants = Object.fromEntries(Object.entries(task.invariants).map(([rule, ids]) => [rule, summarize(ids, results)]));
  const p2p = summarize(p2pIds, results);
  const invTotal = Object.values(invariants).reduce((n, r) => n + r.total, 0);
  const invFailed = Object.values(invariants).reduce((n, r) => n + (r.total - r.passed), 0);

  const buildOk = Object.keys(results).length > 0;
  const resolved = buildOk && f2p.total > 0 && f2p.passed === f2p.total;
  const regressed = !buildOk || p2p.passed < p2p.total;
  return {
    buildOk,
    testExitCode: testRun.exitCode,
    testTimedOut: testRun.timedOut,
    testMs: testRun.ms,
    ...(buildOk ? {} : { testOutputTail: testRun.tail }),
    tampered,
    f2p,
    invariants,
    p2p,
    resolved,
    regressed,
    invariantBreakRate: invTotal ? invFailed / invTotal : 0,
    invariantsIntact: buildOk && invFailed === 0,
    intact: resolved && !regressed && invFailed === 0,
  };
}
