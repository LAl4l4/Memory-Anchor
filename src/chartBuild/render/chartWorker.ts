import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { createDependencyPaths, renderChartContent } from './chartContentBuilder.js';
import type { ChartRenderResult, ChartRenderTask, ChartWorkerData } from '../shared/CBHTypes.js';

export type { ChartRenderResult, ChartRenderTask } from '../shared/CBHTypes.js';

const { dependencyFiles, defaultDependencyPaths, globalDependencyRegistry } = workerData as ChartWorkerData;
const sharedDependencyPaths = defaultDependencyPaths
    ? new Set(defaultDependencyPaths)
    : undefined;
const dependencyPathsBySourceDirectory = new Map<string, ReadonlySet<string>>();

function getDependencyPaths(task: ChartRenderTask): ReadonlySet<string> {
    if (task.dependencyPaths) return new Set(task.dependencyPaths);
    if (sharedDependencyPaths) return sharedDependencyPaths;

    const cached = dependencyPathsBySourceDirectory.get(task.sourceDirectory);
    if (cached) return cached;

    const dependencyPaths = createDependencyPaths(dependencyFiles, task.sourceDirectory);
    dependencyPathsBySourceDirectory.set(task.sourceDirectory, dependencyPaths);
    return dependencyPaths;
}

parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (task: ChartRenderTask) => {
    try {
        const timing = {
            dependencyMs: 0,
            skeletonMs: 0,
            nodesMs: 0,
            assemblyMs: 0,
            writeMs: 0,
        };
        const content = renderChartContent(
            new Map(task.dirGroups),
            task.fileNodes,
            task.chartHeading,
            getDependencyPaths(task),
            globalDependencyRegistry,
            task.chartDirectory,
            timing,
            task.chartMetadata
        );
        const assemblyStartedAt = process.hrtime.bigint();
        const chartContent = task.childChartsSection
            ? `${content.trimEnd()}\n\n${task.childChartsSection}\n`
            : content;
        timing.assemblyMs += Number(process.hrtime.bigint() - assemblyStartedAt) / 1_000_000;
        if (task.writeOutput) {
            if (!task.chartPath) throw new Error('Chart output path is required');
            const writeStartedAt = process.hrtime.bigint();
            fs.mkdirSync(path.dirname(task.chartPath), { recursive: true });
            fs.writeFileSync(task.chartPath, chartContent, 'utf-8');
            timing.writeMs = Number(process.hrtime.bigint() - writeStartedAt) / 1_000_000;
        }
        parentPort!.postMessage({
            chartPath: task.chartPath,
            contentLength: chartContent.length,
            timing,
        } satisfies ChartRenderResult);
    } catch (error) {
        parentPort!.postMessage({
            type: 'error',
            chartPath: task.chartPath ?? '<in-memory chart>',
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
