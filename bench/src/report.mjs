import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GROUPS } from './suite.mjs';

export function readResults(runDir) {
  return readFileSync(path.join(runDir, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
const signedPct = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${Math.round(x * 100)}` : '—');
// Recomputed instead of read from grade.intact so older results (which also penalised test edits) grade the same way.
const isIntact = (r) => r.grade.resolved && !r.grade.regressed && r.grade.invariantsIntact;
const tokens = (r) => (r.agent?.usage ? r.agent.usage.input + r.agent.usage.output : 0);

/** Deterministic PRNG so reports are reproducible. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired bootstrap over tasks: mean of per-task (a − b) with a 95% percentile interval. */
export function pairedBootstrap(diffs, iterations = 10_000, seed = 7) {
  if (!diffs.length) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const rand = mulberry32(seed);
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    for (let j = 0; j < diffs.length; j += 1) total += diffs[Math.floor(rand() * diffs.length)];
    means.push(total / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { mean: mean(diffs), lo: means[Math.floor(iterations * 0.025)], hi: means[Math.floor(iterations * 0.975)], n: diffs.length };
}

function groupMetrics(rows) {
  const byTask = new Map();
  for (const r of rows) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r);
  }
  const intactCount = rows.filter((r) => isIntact(r)).length;
  return {
    runs: rows.length,
    intact: mean(rows.map((r) => (isIntact(r) ? 1 : 0))),
    // Only runs that completed the task can break an invariant; idle runs would look falsely safe.
    breakRate: mean(rows.filter((r) => r.grade.resolved).map((r) => r.grade.invariantBreakRate)),
    resolved: mean(rows.map((r) => (r.grade.resolved ? 1 : 0))),
    regressed: mean(rows.map((r) => (r.grade.regressed ? 1 : 0))),
    passAll: mean([...byTask.values()].map((rs) => (rs.every((r) => isIntact(r)) ? 1 : 0))),
    tokens: mean(rows.map(tokens)),
    tokensPerIntact: intactCount ? rows.reduce((n, r) => n + tokens(r), 0) / intactCount : NaN,
    turns: mean(rows.map((r) => r.agent?.turns ?? 0)),
    errors: rows.filter((r) => r.agent?.status === 'error').length,
  };
}

function perTaskRate(rows, task, group, key, onlyResolved = false) {
  const rs = rows.filter((r) => r.task === task && r.group === group && (!onlyResolved || r.grade.resolved));
  return rs.length ? mean(rs.map(key)) : NaN;
}

export function buildReport(results, { title = 'MemoryAnchor bench' } = {}) {
  const groups = GROUPS.filter((g) => results.some((r) => r.group === g));
  const tasks = [...new Set(results.map((r) => r.task))].sort();
  const trials = Math.max(...results.map((r) => r.trial));
  const lines = [`# ${title}`, '', `${tasks.length} tasks × ${groups.length} groups × ${trials} trials = ${results.length} runs`, ''];

  lines.push('| group | intact resolve | invariant break (resolved runs) | task resolved | regression | pass^k | tokens/run | tokens/intact | turns | agent errors |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const g of groups) {
    const m = groupMetrics(results.filter((r) => r.group === g));
    lines.push(`| ${g} | ${pct(m.intact)} | ${pct(m.breakRate)} | ${pct(m.resolved)} | ${pct(m.regressed)} | ${pct(m.passAll)} | ${Math.round(m.tokens / 1000)}k | ${Number.isFinite(m.tokensPerIntact) ? `${Math.round(m.tokensPerIntact / 1000)}k` : '—'} | ${m.turns.toFixed(1)} | ${m.errors} |`);
  }

  const comparisons = [['ma', 'scattered'], ['ma', 'off'], ['scattered', 'off'], ['ma', 'doc'], ['doc', 'scattered']].filter(([a, b]) => groups.includes(a) && groups.includes(b));
  if (comparisons.length) {
    lines.push('', '**Paired differences over tasks (percentage points, 95% bootstrap CI)**', '');
    lines.push('| comparison | intact resolve | invariant break | task resolved |', '|---|---|---|---|');
    for (const [a, b] of comparisons) {
      const cell = (key, onlyResolved = false) => {
        const diffs = tasks
          .map((t) => perTaskRate(results, t, a, key, onlyResolved) - perTaskRate(results, t, b, key, onlyResolved))
          .filter(Number.isFinite);
        const s = pairedBootstrap(diffs);
        const sig = s.n > 1 && (s.lo > 0 || s.hi < 0) ? ' *' : '';
        return `${signedPct(s.mean)} [${signedPct(s.lo)}, ${signedPct(s.hi)}]${sig}`;
      };
      lines.push(`| ${a} − ${b} | ${cell((r) => (isIntact(r) ? 1 : 0))} | ${cell((r) => r.grade.invariantBreakRate, true)} | ${cell((r) => (r.grade.resolved ? 1 : 0))} |`);
    }
    lines.push('', '`*` = interval excludes 0. With few tasks the interval is wide; treat it as a pilot signal only.');
  }

  lines.push('', '**Per task (intact / resolved / invariant break among resolved)**', '');
  lines.push(`| task | ${groups.join(' | ')} |`, `|---|${groups.map(() => '---').join('|')}|`);
  for (const t of tasks) {
    const cells = groups.map((g) => {
      const intact = perTaskRate(results, t, g, (r) => (isIntact(r) ? 1 : 0));
      const resolved = perTaskRate(results, t, g, (r) => (r.grade.resolved ? 1 : 0));
      const brk = perTaskRate(results, t, g, (r) => r.grade.invariantBreakRate, true);
      return `${pct(intact)} / ${pct(resolved)} / ${pct(brk)}`;
    });
    lines.push(`| ${t} | ${cells.join(' | ')} |`);
  }

  const failures = results.filter((r) => !isIntact(r));
  if (failures.length) {
    lines.push('', '**Non-intact runs**', '');
    for (const r of failures) {
      const why = [];
      if (r.agent?.status && r.agent.status !== 'completed') why.push(`agent ${r.agent.status}`);
      if (!r.grade.buildOk) why.push('build/tests did not run');
      if (r.grade.f2p.failing.length) why.push(`task tests failing: ${r.grade.f2p.failing.length}/${r.grade.f2p.total}`);
      for (const [rule, s] of Object.entries(r.grade.invariants)) if (s.failing.length) why.push(`broke ${rule}`);
      if (r.grade.p2p.failing.length) why.push(`regressions: ${r.grade.p2p.failing.slice(0, 3).join(', ')}`);
      lines.push(`- ${r.task} / ${r.group} / t${r.trial}: ${why.join('; ') || 'unknown'}`);
    }
  }
  const edits = results.filter((r) => r.grade.tampered?.length);
  if (edits.length) {
    lines.push('', '**Edits to original tests** (restored before grading, not penalised)', '');
    for (const r of edits) lines.push(`- ${r.task} / ${r.group} / t${r.trial}: ${r.grade.tampered.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeReport(runDir) {
  const report = buildReport(readResults(runDir), { title: `MemoryAnchor bench — ${path.basename(runDir)}` });
  writeFileSync(path.join(runDir, 'report.md'), report);
  return report;
}
