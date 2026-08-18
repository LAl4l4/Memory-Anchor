import { CAC } from 'cac';
import path from 'node:path';
import type { CommandContext } from '../types.js';
import { INDEX_FILE_NAME, type PromptHookAgent } from '../constant.js';
import { claudeSetup } from './initHelper/initClaude.js';
import { codebuddySetup } from './initHelper/initCodebuddy.js';
import { codexSetup } from './initHelper/initCodex.js';
import { copilotSetup } from './initHelper/initCopilot.js';
import { initPublic, fileExists } from './initHelper/initPublic.js';
import { opencodeSetup } from './initHelper/initOpencode.js';
import { qodercnSetup } from './initHelper/initQodercn.js';
import { hasHermesHooks, hermesSetup } from './initHelper/initHermes.js';
import {
  allPromptHookAgents,
  ensurePromptHookConfig,
  getPromptHookAgentName,
  readPromptHookAgents,
  writePromptHookAgents,
} from './initHelper/promptHookConfig.js';

const PROMPT_HOOK_FILES: Record<PromptHookAgent, string | null> = {
  claude: '.claude/settings.json',
  codex: '.codex/hooks.json',
  codebuddy: '.codebuddy/settings.json',
  qodercn: '.qoder/settings.json',
  copilot: '.github/hooks/memory-anchor.json',
  opencode: '.opencode/plugins/memory-anchor.js',
  // Hermes hooks live in the global $HERMES_HOME/config.yaml; existence is
  // resolved through hasHermesHooks() instead of a cwd-relative path.
  hermes: null,
};

interface PromptHookOptions {
  off?: boolean;
}

function getRequestedAgents(values: string[]): PromptHookAgent[] {
  const invalid = values.filter((value) => getPromptHookAgentName(value) === null);
  if (invalid.length > 0) {
    const supported = allPromptHookAgents().join(', ');
    throw new Error(`Unknown prompt-hook agent(s): ${invalid.join(', ')}. Supported: ${supported}`);
  }

  return values.flatMap((value) => {
    const agent = getPromptHookAgentName(value);
    return agent ? [agent] : [];
  });
}

async function reconcilePlatformHooks(cwd: string, enabled: Set<PromptHookAgent>): Promise<void> {
  const setup = {
    claude: claudeSetup,
    codex: codexSetup,
    codebuddy: codebuddySetup,
    qodercn: qodercnSetup,
    copilot: copilotSetup,
    opencode: opencodeSetup,
    hermes: hermesSetup,
  } satisfies Record<PromptHookAgent, (workspace: string) => Promise<unknown>>;

  await Promise.all(
    allPromptHookAgents().map(async (agent) => {
      const targetPath = PROMPT_HOOK_FILES[agent];
      const targetExists =
        targetPath === null
          ? await hasHermesHooks()
          : await fileExists(path.join(cwd, targetPath));
      if (enabled.has(agent) || targetExists) {
        await setup[agent](cwd);
      }
    }),
  );
}

export function promptHookCommand(cli: CAC, context: CommandContext): void {
  cli
    .command('prompt-hook [...agents]', 'Enable or disable Memory Anchor UserPrompt hooks')
    .option('--off', 'Disable the selected UserPrompt hooks instead of enabling them')
    .action(async (agents: string[] = [], options: PromptHookOptions = {}) => {
      const cwd = process.cwd();
      const indexPath = path.join(cwd, '.memoryanchor', INDEX_FILE_NAME);

      if (!(await fileExists(indexPath))) {
        await initPublic(cwd);
      } else {
        await ensurePromptHookConfig(path.join(cwd, '.memoryanchor'));
      }

      const requested = getRequestedAgents(agents);
      const current = await readPromptHookAgents(cwd);
      const next = options.off
        ? current.filter((agent) => !requested.includes(agent))
        : requested.length > 0
          ? requested
          : allPromptHookAgents();

      await writePromptHookAgents(cwd, next);
      await reconcilePlatformHooks(cwd, new Set(next));

      if (options.off) {
        context.logger.info(
          requested.length > 0
            ? `Memory Anchor UserPrompt hooks disabled for: ${requested.join(', ')}`
            : 'Memory Anchor UserPrompt hooks disabled for all agents',
        );
      } else {
        context.logger.info(`Memory Anchor UserPrompt hooks enabled for: ${next.join(', ')}`);
      }
    });
}
