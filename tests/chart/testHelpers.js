import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

function canonicalizeJson(value) {
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

async function snapshotDirectory(directory, relativeDirectory = '') {
  const snapshot = {};
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
      ? canonicalizeJson(JSON.parse(content))
      : content;
  }
  return snapshot;
}

export { snapshotDirectory };
