/**
 * @file init.ts — Command entry point
 *
 * The `init` command runs the common init (initPublic) plus all platform
 * specific setups in a single invocation.
 *
 * Standalone commands for each platform:
 *   `init-copilot`   — Copilot-only setup
 *   `init-claude`    — Claude-only setup
 *   `init-codex`     — Codex CLI-only setup
 *   `init-codebuddy` — CodeBuddy Code-only setup
 *   `init-opencode`  — OpenCode-only setup
 *   `init-qodercn`   — QoderCLI CN-only setup
 */

import { CAC } from 'cac';
import type { CommandContext } from '../types.js';
import { initPublic } from './initHelper/initPublic.js';
import { copilotSetup } from './initHelper/initCopilot.js';
import { claudeSetup } from './initHelper/initClaude.js';
import { initCopilotCommand } from './initHelper/initCopilot.js';
import { initClaudeCommand } from './initHelper/initClaude.js';
import { codexSetup } from './initHelper/initCodex.js';
import { initCodexCommand } from './initHelper/initCodex.js';
import { codebuddySetup } from './initHelper/initCodebuddy.js';
import { initCodebuddyCommand } from './initHelper/initCodebuddy.js';
import { opencodeSetup } from './initHelper/initOpencode.js';
import { initOpencodeCommand } from './initHelper/initOpencode.js';
import { qodercnSetup } from './initHelper/initQodercn.js';
import { initQodercnCommand } from './initHelper/initQodercn.js';

export function initCommand(cli: CAC, context: CommandContext): void {
  // Combined init — runs public + Copilot + Claude + Codex CLI + CodeBuddy + OpenCode + QoderCLI CN
  cli.command('init', 'Initialize Memory Anchor (Copilot + Claude + Codex CLI + CodeBuddy + OpenCode + QoderCLI CN)').action(async () => {
    const cwd = process.cwd();

    const common = await initPublic(cwd);
    const copilot = await copilotSetup(cwd);
    const claude = await claudeSetup(cwd);
    const codex = await codexSetup(cwd);
    const codebuddy = await codebuddySetup(cwd);
    const opencode = await opencodeSetup(cwd);
    const qodercn = await qodercnSetup(cwd);

    const anythingUpdated =
      common.gitignoreUpdated ||
      common.anchorFilesCreated ||
      common.agentsCreated ||
      copilot.hooksUpdated ||
      copilot.instructionsUpdated ||
      claude.settingsUpdated ||
      claude.claudeMdUpdated ||
      codex.hooksUpdated ||
      codebuddy.settingsUpdated ||
      codebuddy.codebuddyMdUpdated ||
      opencode.pluginWritten ||
      opencode.configUpdated ||
      qodercn.settingsUpdated;

    if (anythingUpdated) {
      context.logger.info('Memory anchor initialized for Copilot, Claude, Codex CLI, CodeBuddy, OpenCode, and QoderCLI CN');
    } else {
      context.logger.info('Memory anchor already exists for Copilot, Claude, Codex CLI, CodeBuddy, OpenCode, and QoderCLI CN');
    }
  });

  // Standalone public init — runs only the common steps
  cli.command('init-public', 'Initialize Memory Anchor (public/common steps only)').action(async () => {
    const cwd = process.cwd();
    const common = await initPublic(cwd);

    if (common.gitignoreUpdated || common.anchorFilesCreated || common.agentsCreated) {
      context.logger.info('Memory anchor public files initialized');
    } else {
      context.logger.info('Memory anchor public files already exist');
    }
  });

  // Standalone commands for individual platforms
  initCopilotCommand(cli, context);
  initClaudeCommand(cli, context);
  initCodexCommand(cli, context);
  initCodebuddyCommand(cli, context);
  initOpencodeCommand(cli, context);
  initQodercnCommand(cli, context);
}
