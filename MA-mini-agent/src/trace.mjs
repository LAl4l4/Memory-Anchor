import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Collects everything the bench needs from one run: an append-only JSONL event log plus
 * aggregated counters (tokens, tool usage, which files were inspected / changed and in what order).
 */
export class RunRecorder {
  constructor({ traceFile, onEvent }) {
    this.traceFile = traceFile;
    this.onEvent = onEvent ?? (() => {});
    if (traceFile) mkdirSync(path.dirname(traceFile), { recursive: true });
    this.startedAt = Date.now();
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.turns = 0;
    this.toolCalls = 0;
    this.toolCounts = {};
    this.toolErrors = 0;
    this.servedBy = new Set();
    this.files = { read: new Set(), written: new Set(), matched: new Set(), listed: new Set(), maFiles: new Set(), maCharts: new Set() };
    this.commands = [];
    /** Ordered first-time inspections: which file was looked at, by which tool, at which tool-call index. */
    this.inspections = [];
    this.inspected = new Set();
  }

  emit(event) {
    const record = { t: Date.now() - this.startedAt, ...event };
    if (this.traceFile) appendFileSync(this.traceFile, `${JSON.stringify(record)}\n`);
    this.onEvent(record);
  }

  recordTurn(turn) {
    this.turns += 1;
    for (const key of Object.keys(this.usage)) this.usage[key] += turn.usage?.[key] ?? 0;
    if (turn.servedBy) this.servedBy.add(turn.servedBy);
  }

  recordTool(name, isError, meta = {}) {
    this.toolCalls += 1;
    this.toolCounts[name] = (this.toolCounts[name] ?? 0) + 1;
    if (isError) this.toolErrors += 1;
    for (const [key, values] of Object.entries(meta)) {
      if (key === 'commands') {
        this.commands.push(...values);
        continue;
      }
      const bucket = this.files[key];
      if (bucket) for (const v of values) bucket.add(v);
    }
    for (const file of [...(meta.read ?? []), ...(meta.maFiles ?? [])]) {
      if (this.inspected.has(file)) continue;
      this.inspected.add(file);
      this.inspections.push({ step: this.toolCalls, tool: name, path: file });
    }
  }

  summary() {
    const files = Object.fromEntries(Object.entries(this.files).map(([k, v]) => [k, [...v].sort()]));
    return {
      durationMs: Date.now() - this.startedAt,
      turns: this.turns,
      toolCalls: this.toolCalls,
      toolErrors: this.toolErrors,
      toolCounts: this.toolCounts,
      usage: this.usage,
      servedBy: [...this.servedBy],
      files,
      inspections: this.inspections,
      commands: this.commands,
    };
  }
}
