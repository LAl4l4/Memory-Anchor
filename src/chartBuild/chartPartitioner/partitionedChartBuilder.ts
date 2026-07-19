import * as fs from 'node:fs';
import * as path from 'node:path';
import { destroyPool } from '../chartBuildHelper/ASTParser.js';
import { buildChartContent, ChartParseCache } from '../chartBuildHelper/chartContentBuilder.js';
import { listProjectFiles, resolveWorkspacePaths } from '../chartBuildHelper/utils.js';
import {
    buildDirectoryTreeRegistry,
    BuildDirectoryTreeRegistryOptions,
    getDirectoriesToScan,
} from './partitioner.js';
import { DirectoryTreeNode } from './directoryTree.js';

export const PARTITIONED_CHART_DIRECTORY_NAME = 'chart';
export const PARTITIONED_CHART_INDEX_NAME = 'index.md';

export interface CreatePartitionedChartsOptions {
    projectRoot?: string;
    parseCache?: ChartParseCache;
}

export interface PartitionedChartsDebugResult {
    directories: string[];
    chartPaths: string[];
    indexPath: string;
}

export type PartitionedChartsBuildResult = PartitionedChartsDebugResult;

function resolveSourceDirectory(projectRoot: string, directory: string): string {
    return directory === '.' ? projectRoot : path.join(projectRoot, directory);
}

function resolveChartDirectory(outputRoot: string, directory: string): string {
    return directory === '.' ? outputRoot : path.join(outputRoot, directory);
}

function validateDirectory(directory: string): void {
    const normalized = path.normalize(directory);
    if (
        directory.length === 0 ||
        path.isAbsolute(directory) ||
        normalized === '..' ||
        normalized.startsWith(`..${path.sep}`)
    ) {
        throw new Error(`Cannot build partitioned chart for invalid directory '${directory}'`);
    }
}

enum ScopeState {
    Classify,
    Frontend,
    Backend,
    Crawler,
    Tests,
    Assets,
    Parser,
    Source,
    Root,
    Generic,
    Complete,
}

function classifyScopeState(directory: string): ScopeState {
    if (directory === '.') return ScopeState.Root;

    const normalized = directory.toLowerCase();
    if (/(^|\/)(frontend|client|ui|web)(\/|$)/.test(normalized)) return ScopeState.Frontend;
    if (/(^|\/)(backend|server)(\/|$)/.test(normalized)) return ScopeState.Backend;
    if (/(^|\/)(crawler|spider|scraper)(\/|$)/.test(normalized)) return ScopeState.Crawler;
    if (/(^|\/)(tests?|specs?)(\/|$)/.test(normalized)) return ScopeState.Tests;
    if (/(^|\/)(assets?|resources?|public)(\/|$)/.test(normalized)) return ScopeState.Assets;
    if (normalized.includes('parser') || normalized.includes('grammar')) return ScopeState.Parser;
    if (/(^|\/)src(\/|$)/.test(normalized)) return ScopeState.Source;
    return ScopeState.Generic;
}

/** Temporary state-machine scope inference; a dedicated scope builder comes later. */
export function inferPartitionScope(directory: string): string {
    let state = ScopeState.Classify;
    let scope = '';

    while (state !== ScopeState.Complete) {
        switch (state) {
            case ScopeState.Classify:
                state = classifyScopeState(directory);
                break;
            case ScopeState.Frontend:
                scope = 'UI, React components, client APIs, state management.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Backend:
                scope = 'Spring Boot controllers, services, entities, database.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Crawler:
                scope = 'Crawlers, scraping workflows, data extraction, ingestion.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Tests:
                scope = 'Automated tests, fixtures, and verification workflows.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Assets:
                scope = 'Static assets and project resources.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Parser:
                scope = 'Parser runtimes, language grammars, and syntax-analysis resources.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Source:
                scope = 'Core source code and application implementation.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Root:
                scope = 'Repository-wide architecture and project configuration.';
                state = ScopeState.Complete;
                break;
            case ScopeState.Generic:
                scope = 'Architecture and implementation for this directory.';
                state = ScopeState.Complete;
                break;
        }
    }

    return scope;
}

function buildIndexPartition(directory: string): string {
    const label = directory === '.' ? 'Root' : directory;
    const chartDirectory = directory === '.' ? '' : `${directory}/`;

    return `### ${label}

path:
.memoryanchor/chart/${chartDirectory}chart.md

scope:
${inferPartitionScope(directory)}`;
}

function getPartitionOutputRoot(projectRoot: string): string {
    return path.join(projectRoot, '.memoryanchor', PARTITIONED_CHART_DIRECTORY_NAME);
}

async function writePartitionedChart(
    directory: string,
    projectRoot: string,
    outputRoot: string,
    parseCache?: ChartParseCache
): Promise<string> {
    validateDirectory(directory);
    const sourceDirectory = resolveSourceDirectory(projectRoot, directory);
    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
        throw new Error(`Cannot build partitioned chart: directory '${directory}' does not exist`);
    }

    const dirGroups = listProjectFiles(sourceDirectory);
    const chartContent = await buildChartContent(dirGroups, sourceDirectory, parseCache);
    const chartDirectory = resolveChartDirectory(outputRoot, directory);
    const chartPath = path.join(chartDirectory, 'chart.md');
    fs.mkdirSync(chartDirectory, { recursive: true });
    fs.writeFileSync(chartPath, chartContent, 'utf-8');
    return chartPath;
}

function writePartitionIndex(projectRoot: string, directories: readonly string[]): string {
    const indexPath = path.join(projectRoot, '.memoryanchor', PARTITIONED_CHART_INDEX_NAME);
    fs.writeFileSync(indexPath, buildPartitionedChartIndex(directories), 'utf-8');
    return indexPath;
}

export function buildPartitionedChartIndex(directories: readonly string[]): string {
    const partitions = directories.map(buildIndexPartition).join('\n\n');

    return `# Project Chart Index

## Overview

Generated architecture map for this repository.
Charts are partitioned by directory boundaries.

## Root Partitions

${partitions}

## Usage

For a task involving a specific module, read the closest matching
directory chart instead of loading the whole project map.
`;
}

/**
 * Mirror selected project directories under .memoryanchor/chart and write one
 * recursively-scanned chart.md for each directory. Parser-pool lifecycle stays
 * with the caller so this can participate in the future automatic build flow.
 */
export async function createPartitionedCharts(
    directories: readonly string[],
    options: CreatePartitionedChartsOptions = {}
): Promise<string[]> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const outputRoot = getPartitionOutputRoot(projectRoot);
    const anchorDirectory = path.dirname(outputRoot);
    const legacyChartPath = path.join(anchorDirectory, 'chart.md');
    const selectedDirectories = [...new Set(directories)];

    for (const directory of selectedDirectories) validateDirectory(directory);

    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });

    const chartPaths: string[] = [];
    for (const directory of selectedDirectories) {
        chartPaths.push(await writePartitionedChart(
            directory,
            projectRoot,
            outputRoot,
            options.parseCache
        ));
    }

    fs.rmSync(legacyChartPath, { force: true });
    writePartitionIndex(projectRoot, selectedDirectories);

    return chartPaths;
}

/** Rebuild only the chart subtree whose split/merge state changed. */
export async function rebuildPartitionBoundary(
    root: DirectoryTreeNode,
    boundary: DirectoryTreeNode,
    options: CreatePartitionedChartsOptions = {}
): Promise<string[]> {
    const workspace = resolveWorkspacePaths();
    const projectRoot = path.resolve(options.projectRoot ?? workspace.projectRoot);
    const outputRoot = getPartitionOutputRoot(projectRoot);
    const affectedOutput = resolveChartDirectory(outputRoot, boundary.directory);

    fs.rmSync(affectedOutput, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });

    const localDirectories = getDirectoriesToScan(boundary);
    const chartPaths: string[] = [];
    for (const directory of localDirectories) {
        chartPaths.push(await writePartitionedChart(directory, projectRoot, outputRoot));
    }

    writePartitionIndex(projectRoot, getDirectoriesToScan(root));
    return chartPaths;
}

/**
 * End-to-end debug entry: build the registry, select the partition frontier,
 * emit mirrored charts, and always destroy the parser pool before returning.
 */
/** Automatic end-to-end entry. Keeps the parser pool alive for its caller. */
export async function buildPartitionedCharts(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<PartitionedChartsBuildResult> {
    const parseCache = options.parseCache ?? new Map();
    const root = await buildDirectoryTreeRegistry({ ...options, parseCache });
    const directories = getDirectoriesToScan(root);
    const chartPaths = await createPartitionedCharts(directories, {
        projectRoot: options.projectRoot,
        parseCache,
    });
    const projectRoot = path.resolve(options.projectRoot ?? resolveWorkspacePaths().projectRoot);
    const indexPath = path.join(
        projectRoot,
        '.memoryanchor',
        PARTITIONED_CHART_INDEX_NAME
    );

    return { directories, chartPaths, indexPath };
}

/** Debug end-to-end entry. Always destroys the parser pool before returning. */
export async function buildPartitionedChartsForDebug(
    options: BuildDirectoryTreeRegistryOptions = {}
): Promise<PartitionedChartsDebugResult> {
    try {
        return await buildPartitionedCharts(options);
    } finally {
        await destroyPool();
    }
}
