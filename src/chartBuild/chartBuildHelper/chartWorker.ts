import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { createDependencyPaths, renderChartContent } from './chartContentBuilder.js';
import type { GlobalDependencyRegistry } from './dependencyGraph.js';
import type { FileNode } from './symbolExtractor.js';

interface ChartWorkerData {
    dependencyFiles: string[];
    /** Paths relative to the shared source directory for this worker batch. */
    defaultDependencyPaths?: string[];
    globalDependencyRegistry?: GlobalDependencyRegistry;
}

export interface ChartRenderTask {
    chartPath?: string;
    sourceDirectory: string;
    dirGroups: [string, string[]][];
    fileNodes: FileNode[];
    chartHeading: string;
    childChartsSection: string;
    writeOutput: boolean;
    dependencyPaths?: string[];
    /** Project-relative directory containing this chart's local paths. */
    chartDirectory?: string;
}

export interface ChartRenderResult {
    chartPath?: string;
    contentLength: number;
}

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
        const content = renderChartContent(
            new Map(task.dirGroups),
            task.fileNodes,
            task.chartHeading,
            getDependencyPaths(task),
            globalDependencyRegistry,
            task.chartDirectory
        );
        const chartContent = task.childChartsSection
            ? `${content.trimEnd()}\n\n${task.childChartsSection}\n`
            : content;
        if (task.writeOutput) {
            if (!task.chartPath) throw new Error('Chart output path is required');
            fs.mkdirSync(path.dirname(task.chartPath), { recursive: true });
            fs.writeFileSync(task.chartPath, chartContent, 'utf-8');
        }
        parentPort!.postMessage({
            chartPath: task.chartPath,
            contentLength: chartContent.length,
        } satisfies ChartRenderResult);
    } catch (error) {
        parentPort!.postMessage({
            type: 'error',
            chartPath: task.chartPath ?? '<in-memory chart>',
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
