import os from 'node:os';
import path from 'node:path';

export function getHermesHome(): string {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
}
