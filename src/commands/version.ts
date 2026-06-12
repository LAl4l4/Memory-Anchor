import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CAC } from 'cac';
import type { CommandContext } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getVersion(): string {
  const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return String(pkg.version);
}

export function versionCommand(cli: CAC, context: CommandContext): void {
  cli.command('version', 'Show version').action(() => {
    context.logger.info(`v${getVersion()}`);
  });
}
