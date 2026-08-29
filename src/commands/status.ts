import { access } from 'node:fs/promises';
import path from 'node:path';
import type { CAC } from 'cac';
import type { CommandContext } from '../types.js';
import { getVersion } from './version.js';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function statusCommand(cli: CAC, context: CommandContext): void {
  cli.command('status', 'Show MemoryAnchor status').action(async () => {
    const cwd = process.cwd();
    const { config, logger } = context;

    const version = getVersion();
    const dataDir = path.resolve(cwd, config.dataDir);
    const files = ['index.md', 'guardrails.md', 'project-state.md'];

    const exists = await Promise.all(
      files.map((f) => fileExists(path.join(dataDir, f))),
    );

    const allExist = exists.every(Boolean);
    const anyExist = exists.some(Boolean);

    const anchorStatus = allExist
      ? 'Active'
      : anyExist
        ? 'Partial'
        : 'Not initialized';

    logger.info(`MemoryAnchor v${version}`);
    logger.info('');
    logger.info('  Status:     ' + anchorStatus);
    logger.info('  CWD:        ' + cwd);
    logger.info('  Data Dir:   ' + config.dataDir);
    logger.info('  Index Dir:  ' + config.indexDir);
    logger.info('');
    logger.info('  Anchor files:');

    for (const [i, f] of files.entries()) {
      const statusIcon = exists[i] ? '✓' : '✗';
      logger.info('    ' + f + '  ' + statusIcon);
    }

    logger.info('');
    logger.info('Run `anchor init` to initialize or repair missing files.');
  });
}
