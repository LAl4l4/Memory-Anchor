import * as fs from 'fs';
import * as path from 'path';

const ANCHOR_INDEX_PATH = path.join(process.cwd(), '.memoryanchor', 'index.md');

/**
 * Hermes registers shell hooks in the global $HERMES_HOME/config.yaml, so
 * they fire in every project the agent runs in. Outside a Memory Anchor
 * workspace the hooks must no-op instead of injecting placeholder context
 * or running incremental updates.
 */
export function isMemoryAnchorWorkspace(): boolean {
  return fs.existsSync(ANCHOR_INDEX_PATH);
}