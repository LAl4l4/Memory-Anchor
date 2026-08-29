import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { PersistentDependencyGraph } from '../../dist/chartBuild/shared/CBHTypes.js';

type JsonValue = boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

export type ArtifactSnapshot = Record<string, string> & {
  'dependencyGraph.json': PersistentDependencyGraph;
};

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function canonicalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalizeJson(value[key])])
    );
  }
  return value;
}

async function snapshotDirectory(
  directory: string,
  relativeDirectory = ''
): Promise<ArtifactSnapshot> {
  const snapshot: Record<string, string | JsonValue> = {};
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await snapshotDirectory(absolutePath, relativePath));
      continue;
    }
    const content = await readFile(absolutePath, 'utf8');
    snapshot[relativePath] = relativePath.endsWith('.json')
      ? canonicalizeJson(JSON.parse(content) as JsonValue)
      : content;
  }
  return snapshot as ArtifactSnapshot;
}

export { snapshotDirectory };
