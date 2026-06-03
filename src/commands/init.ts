/**
 * @file init.ts — Command entry point
 *
 * The `init` command runs the common init (initPublic) plus both Copilot
 * and Claude specific setups in a single invocation.
 *
 * Standalone commands for each platform:
 *   `init-copilot` — Copilot-only setup
 *   `init-claude`  — Claude-only setup
 */

import { CAC } from 'cac';
import type { CommandContext } from '../core/context.js';
import { initPublic } from './initHelper/initPublic.js';
import { copilotSetup } from './initHelper/initCopilot.js';
import { claudeSetup } from './initHelper/initClaude.js';
import { initCopilotCommand } from './initHelper/initCopilot.js';
import { initClaudeCommand } from './initHelper/initClaude.js';

export function initCommand(cli: CAC, context: CommandContext): void {
  // Combined init — runs public + Copilot + Claude
  cli.command('init', 'Initialize Memory Anchor (Copilot + Claude)').action(async () => {
    const cwd = process.cwd();

    const common = await initPublic(cwd);
    const copilot = await copilotSetup(cwd);
    const claude = await claudeSetup(cwd);

    const anythingUpdated =
      common.gitignoreUpdated ||
      common.anchorFilesCreated ||
      common.agentsCreated ||
      copilot.hooksUpdated ||
      copilot.instructionsUpdated ||
      claude.settingsUpdated ||
      claude.claudeMdUpdated;

    if (anythingUpdated) {
      context.logger.info('Memory anchor initialized for Copilot and Claude');
    } else {
      context.logger.info('Memory anchor already exists for Copilot and Claude');
    }
  });

  // Standalone commands for individual platforms
  initCopilotCommand(cli, context);
  initClaudeCommand(cli, context);
}
