import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { createDependencyPaths, renderChartContent } from './chartContentBuilder.js';
import type { FileNode } from './symbolExtractor.js';

interface ChartWorkerData {
    dependencyFiles: string[];
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
}

export interface ChartRenderResult {
    chartPath?: string;
    contentLength: number;
}

const { dependencyFiles } = workerData as ChartWorkerData;

parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', (task: ChartRenderTask) => {
    try {
        const content = renderChartContent(
            new Map(task.dirGroups),
            task.fileNodes,
            task.chartHeading,
            task.dependencyPaths
                ? new Set(task.dependencyPaths)
                : createDependencyPaths(dependencyFiles, task.sourceDirectory)
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
