/**
 * Hook Protocol Registry — single source of truth for how each AI agent
 * platform expects MemoryAnchor to wire its hooks.
 *
 * Why this file exists
 * --------------------
 * The original opencode plugin silently did nothing because it assumed
 * opencode worked the same way Claude / Codex / Copilot do:
 *   - It used the event name "session.start"     → opencode has no such event.
 *   - It spawned a subprocess and expected the agent to capture stdout
 *     and inject it as system prompt                    → opencode plugins
 *     communicate by mutating an `output` argument, never via stdout.
 *   - It imported `$` from `bun` top-level         → not part of the plugin
 *     contract; the BunShell is provided via the PluginInput ctx.
 *
 * Each agent platform is different along four orthogonal axes. This module
 * captures those axes as a literal-typed registry so the compiler refuses
 * any future "session.start"-style mistake: an init helper can only ask for
 * an event name that is statically declared here for its platform.
 *
 * Axes
 * ----
 *   1. eventNameStyle      — how event identifiers are cased / namespaced.
 *   2. injectionMechanism  — how the (pre) hook delivers ballast+manifest
 *                            to the agent's prompt.
 *   3. hookConfig          — the on-disk shape of a hook registration.
 *   4. needsContextMd      — whether a `<AGENT>.md` anchor file is required
 *                            for the agent to pick up AGENTS.md-style rules.
 */

// =============================================================================
// Axis 1: Event-name style
// =============================================================================

export type EventNameStyle =
  /** PascalCase events: `SessionStart`, `Stop`, `SessionEnd`. */
  | 'pascal-case'
  /** camelCase events: `sessionStart`, `agentStop`, `sessionEnd`. */
  | 'camel-case'
  /**
   * snake_case events: `on_session_start`, `pre_llm_call`.
   * Used by: hermes.
   */
  | 'snake-case'
  /**
   * Dotted events, including experimental hooks:
   * `session.created`, `session.idle`, `experimental.chat.system.transform`.
   */
  | 'dotted-event';

// =============================================================================
// Axis 2: Injection mechanism (how pre-hook output reaches the prompt)
// =============================================================================

export type InjectionMechanism =
  /**
   * Subprocess stdout is read as plain text and concatenated into the
   * system prompt by the agent itself.
   * Used by: claude, codex, codebuddy, qodercn.
   */
  | 'stdout-plain-text'
  /**
   * Subprocess stdout must be a single JSON object, conventionally
   * `{ "additionalContext": "<string>" }`. The agent parses the JSON and
   * uses the named field as injected context.
   * Used by: copilot.
   */
  | 'stdout-json-protocol'
  /**
   * Subprocess stdout must be a single JSON object with a `context` key
   * (or a plain non-empty string); Hermes appends it to the current turn's
   * user message to preserve the system-prompt cache.
   * Used by: hermes (`pre_llm_call`).
   */
  | 'stdout-json-context'
  /**
   * No subprocess — the plugin reads .memoryanchor files directly inside
   * the agent's runtime and mutates an `output` object provided by the
   * platform (e.g. `output.system.push(...)`).
   * Used by: opencode (via `experimental.chat.system.transform`).
   *
   * Important: platforms using this mechanism have NO stdout→prompt
   * pathway. A plugin that spawns a subprocess and writes to stdout will
   * be silently ignored — this is exactly the v1 opencode bug.
   */
  | 'output-mutation'
  /**
   * No runtime hook is registered; context is delivered by listing a
   * static file in the agent's config (e.g. opencode `instructions`
   * array). Used as a marker for agents that fully rely on file injection.
   */
  | 'static-file';

// =============================================================================
// Axis 3: Hook config shape (how a hook is persisted on disk)
// =============================================================================

export type HookConfigShape =
  /**
   * `{ matcher: string, hooks: [{ type: "command", command: string,
   *   timeout: number }] }` registered under a PascalCase event key.
   * Used by: claude, codex, codebuddy, qodercn.
   */
  | 'matcher-plus-hooks-array'
  /**
   * `{ type: "command", bash: string, powershell: string, timeoutSec: number }`
   * registered under a camelCase event key, array-of-commands per event.
   * Used by: copilot.
   */
  | 'flat-hook-command-array'
  /**
   * A JS/TS plugin module exporting `MemoryAnchorPlugin` that returns a
   * hooks object whose keys are dotted event names (including
   * `experimental.*`). No on-disk hook entries; everything is in code.
   * Used by: opencode.
   */
  | 'plugin-module'
  /**
   * YAML `hooks:` block in the user's Hermes config mapping snake_case
   * event names to arrays of `{ matcher?, command, timeout? }` entries.
   * Used by: hermes.
   */
  | 'yaml-hook-array';

// =============================================================================
// Axis 4: Context markdown file
// =============================================================================

export type ContextMdStrategy =
  /** Agent reads AGENTS.md natively; no per-agent md file needed. */
  | 'none'
  /** Agent needs `<NAME>.md` (e.g. CLAUDE.md, CODEBUDDY.md) with an anchor line pointing to AGENTS.md. */
  | 'agent-md-anchor-line'
  /** Copilot: `.github/copilot-instructions.md`. */
  | 'github-instructions-md'
  /** OpenCode: routes static context through `opencode.json` `instructions`. */
  | 'opencode-instructions';

// =============================================================================
// Event name registry (literal unions per platform)
// =============================================================================
//
// These unions are intentionally platform-scoped. An init helper that
// takes one of these strings must receive one that belongs to its own
// platform — you can't pass `ClaudeEventName` where `OpencodeEventName`
// is expected. This is what makes the next "session.start"-class bug a
// compile error instead of a silent failure.

export type ClaudeEventName = 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'SessionEnd';
export type CodexEventName = 'SessionStart' | 'UserPromptSubmit' | 'Stop';
export type CodebuddyEventName = ClaudeEventName;
export type QodercnEventName = ClaudeEventName;

export type CopilotEventName =
  | 'sessionStart'
  | 'userPromptTransformed'
  | 'agentStop'
  | 'sessionEnd';

export type OpencodeEventName =
  | 'session.created'
  | 'session.idle'
  | 'session.deleted'
  | 'experimental.chat.messages.transform'
  | 'experimental.chat.system.transform';

export type HermesEventName = 'pre_llm_call' | 'on_session_end' | 'on_session_finalize';

// =============================================================================
// Full protocol spec per platform
// =============================================================================

export interface AgentHookProtocol<E extends string = string> {
  /** Pascal-case identifier matching the init helper / constant.ts key. */
  readonly agentId:
    | 'claude'
    | 'codex'
    | 'codebuddy'
    | 'qodercn'
    | 'copilot'
    | 'opencode'
    | 'hermes';
  /** Human-readable label, used in logs and errors. */
  readonly label: string;
  /** Casing / namespacing convention for this platform's event names. */
  readonly eventNameStyle: EventNameStyle;
  /** How the pre hook delivers ballast+manifest to the agent's prompt. */
  readonly injectionMechanism: InjectionMechanism;
  /** On-disk shape of a hook registration. */
  readonly hookConfigShape: HookConfigShape;
  /** Strategy for the agent-specific context markdown file, if any. */
  readonly contextMdStrategy: ContextMdStrategy;
  /** Path (relative to cwd) of the file hooks are registered in. */
  readonly hookConfigPath: string;
  /** Path (relative to cwd) of the agent-specific markdown, or null. */
  readonly contextMdPath: string | null;
  /** Event names the pre / user-prompt / stop / post hooks subscribe to. */
  readonly eventNames: {
    readonly pre: E | null;
    readonly prompt: E | null;
    readonly stop: E | null;
    readonly post: E | null;
  };
  /**
   * For `output-mutation` platforms only — the event name where the
   * plugin mutates `output.system` (or equivalent) to inject context.
   * `null` for platforms that don't use mutation.
   */
  readonly contextInjectionEvent: E | null;
  /** Whether this platform permits a user-prompt hook to block submission. */
  readonly canBlockUserPrompt: boolean;
  /** Whether this platform's user-prompt hook can rewrite the prompt itself. */
  readonly canRewriteUserPrompt: boolean;
}

// =============================================================================
// Registry
// =============================================================================

export const HOOK_PROTOCOLS = {
  claude: {
    agentId: 'claude',
    label: 'Claude',
    eventNameStyle: 'pascal-case',
    injectionMechanism: 'stdout-plain-text',
    hookConfigShape: 'matcher-plus-hooks-array',
    contextMdStrategy: 'agent-md-anchor-line',
    hookConfigPath: '.claude/settings.json',
    contextMdPath: 'CLAUDE.md',
    eventNames: {
      pre: 'SessionStart' as ClaudeEventName,
      prompt: 'UserPromptSubmit' as ClaudeEventName,
      stop: 'Stop' as ClaudeEventName,
      post: 'SessionEnd' as ClaudeEventName,
    },
    contextInjectionEvent: null,
    canBlockUserPrompt: true,
    canRewriteUserPrompt: false,
  },
  codex: {
    agentId: 'codex',
    label: 'Codex CLI',
    eventNameStyle: 'pascal-case',
    injectionMechanism: 'stdout-plain-text',
    hookConfigShape: 'matcher-plus-hooks-array',
    contextMdStrategy: 'none',
    hookConfigPath: '.codex/hooks.json',
    contextMdPath: null,
    eventNames: {
      pre: 'SessionStart' as CodexEventName,
      prompt: 'UserPromptSubmit' as CodexEventName,
      stop: 'Stop' as CodexEventName,
      post: null,
    },
    contextInjectionEvent: null,
    canBlockUserPrompt: true,
    canRewriteUserPrompt: false,
  },
  codebuddy: {
    agentId: 'codebuddy',
    label: 'CodeBuddy',
    eventNameStyle: 'pascal-case',
    injectionMechanism: 'stdout-plain-text',
    hookConfigShape: 'matcher-plus-hooks-array',
    contextMdStrategy: 'agent-md-anchor-line',
    hookConfigPath: '.codebuddy/settings.json',
    contextMdPath: 'CODEBUDDY.md',
    eventNames: {
      pre: 'SessionStart' as CodebuddyEventName,
      prompt: 'UserPromptSubmit' as CodebuddyEventName,
      stop: 'Stop' as CodebuddyEventName,
      post: 'SessionEnd' as CodebuddyEventName,
    },
    contextInjectionEvent: null,
    canBlockUserPrompt: true,
    canRewriteUserPrompt: false,
  },
  qodercn: {
    agentId: 'qodercn',
    label: 'QoderCLI CN',
    eventNameStyle: 'pascal-case',
    injectionMechanism: 'stdout-plain-text',
    hookConfigShape: 'matcher-plus-hooks-array',
    contextMdStrategy: 'none',
    hookConfigPath: '.qoder/settings.json',
    contextMdPath: null,
    eventNames: {
      pre: 'SessionStart' as QodercnEventName,
      prompt: 'UserPromptSubmit' as QodercnEventName,
      stop: 'Stop' as QodercnEventName,
      post: 'SessionEnd' as QodercnEventName,
    },
    contextInjectionEvent: null,
    canBlockUserPrompt: true,
    canRewriteUserPrompt: false,
  },
  copilot: {
    agentId: 'copilot',
    label: 'Copilot',
    eventNameStyle: 'camel-case',
    injectionMechanism: 'stdout-json-protocol',
    hookConfigShape: 'flat-hook-command-array',
    contextMdStrategy: 'github-instructions-md',
    hookConfigPath: '.github/hooks/memory-anchor.json',
    contextMdPath: '.github/copilot-instructions.md',
    eventNames: {
      pre: 'sessionStart' as CopilotEventName,
      prompt: 'userPromptTransformed' as CopilotEventName,
      stop: 'agentStop' as CopilotEventName,
      post: 'sessionEnd' as CopilotEventName,
    },
    contextInjectionEvent: null,
    canBlockUserPrompt: false,
    canRewriteUserPrompt: true,
  },
  opencode: {
    agentId: 'opencode',
    label: 'OpenCode',
    eventNameStyle: 'dotted-event',
    injectionMechanism: 'output-mutation',
    hookConfigShape: 'plugin-module',
    contextMdStrategy: 'opencode-instructions',
    hookConfigPath: '.opencode/plugins/memory-anchor.js',
    contextMdPath: null,
    eventNames: {
      // OpenCode has no native UserPromptSubmit event; the per-turn reminder
      // is applied to the outbound message copy by the experimental transform.
      pre: null,
      prompt: 'experimental.chat.messages.transform' as OpencodeEventName,
      stop: 'session.idle' as OpencodeEventName,
      post: 'session.deleted' as OpencodeEventName,
    },
    contextInjectionEvent: 'experimental.chat.system.transform' as OpencodeEventName,
    canBlockUserPrompt: false,
    canRewriteUserPrompt: true,
  },
  hermes: {
    agentId: 'hermes',
    label: 'Hermes Agent',
    eventNameStyle: 'snake-case',
    injectionMechanism: 'stdout-json-context',
    hookConfigShape: 'yaml-hook-array',
    contextMdStrategy: 'none',
    // Hermes config is global, not project-scoped: $HERMES_HOME/config.yaml
    // (default ~/.hermes/config.yaml).
    hookConfigPath: '~/.hermes/config.yaml',
    contextMdPath: null,
    eventNames: {
      // pre_llm_call fires once per turn before the tool loop and appends
      // `{"context": ...}` to the user message; Hermes has no separate
      // SessionStart event, so context and the optional prompt appendix
      // are delivered through two pre_llm_call entries.
      pre: 'pre_llm_call' as HermesEventName,
      prompt: 'pre_llm_call' as HermesEventName,
      // on_session_end fires at the end of every run_conversation() call
      // (per-turn equivalent of Claude's Stop).
      stop: 'on_session_end' as HermesEventName,
      // on_session_finalize fires at CLI/TUI/gateway teardown (session end).
      post: 'on_session_finalize' as HermesEventName,
    },
    contextInjectionEvent: 'pre_llm_call' as HermesEventName,
    canBlockUserPrompt: false,
    canRewriteUserPrompt: false,
  },
} as const;

export type AgentId = keyof typeof HOOK_PROTOCOLS;

// =============================================================================
// Compile-time guard: the registry entry's event-name tuple must match the
// platform's EventName union. This enforces "you can't put a Copilot event
// name into the opencode spec" at the type level.
// =============================================================================

type EnforceEventNameMatch<
  E extends string,
  Pre extends E | null,
  Prompt extends E | null,
  Stop extends E | null,
  Post extends E | null,
  Inj extends E | null,
> = [Pre, Prompt, Stop, Post, Inj];

// Enforce per-platform typing without runtime cost.
type _ClaudeGuard = EnforceEventNameMatch<
  ClaudeEventName,
  typeof HOOK_PROTOCOLS.claude.eventNames.pre,
  typeof HOOK_PROTOCOLS.claude.eventNames.prompt,
  typeof HOOK_PROTOCOLS.claude.eventNames.stop,
  typeof HOOK_PROTOCOLS.claude.eventNames.post,
  typeof HOOK_PROTOCOLS.claude.contextInjectionEvent
>;
type _CodexGuard = EnforceEventNameMatch<
  CodexEventName,
  typeof HOOK_PROTOCOLS.codex.eventNames.pre,
  typeof HOOK_PROTOCOLS.codex.eventNames.prompt,
  typeof HOOK_PROTOCOLS.codex.eventNames.stop,
  typeof HOOK_PROTOCOLS.codex.eventNames.post,
  typeof HOOK_PROTOCOLS.codex.contextInjectionEvent
>;
type _CodebuddyGuard = EnforceEventNameMatch<
  CodebuddyEventName,
  typeof HOOK_PROTOCOLS.codebuddy.eventNames.pre,
  typeof HOOK_PROTOCOLS.codebuddy.eventNames.prompt,
  typeof HOOK_PROTOCOLS.codebuddy.eventNames.stop,
  typeof HOOK_PROTOCOLS.codebuddy.eventNames.post,
  typeof HOOK_PROTOCOLS.codebuddy.contextInjectionEvent
>;
type _QodercnGuard = EnforceEventNameMatch<
  QodercnEventName,
  typeof HOOK_PROTOCOLS.qodercn.eventNames.pre,
  typeof HOOK_PROTOCOLS.qodercn.eventNames.prompt,
  typeof HOOK_PROTOCOLS.qodercn.eventNames.stop,
  typeof HOOK_PROTOCOLS.qodercn.eventNames.post,
  typeof HOOK_PROTOCOLS.qodercn.contextInjectionEvent
>;
type _CopilotGuard = EnforceEventNameMatch<
  CopilotEventName,
  typeof HOOK_PROTOCOLS.copilot.eventNames.pre,
  typeof HOOK_PROTOCOLS.copilot.eventNames.prompt,
  typeof HOOK_PROTOCOLS.copilot.eventNames.stop,
  typeof HOOK_PROTOCOLS.copilot.eventNames.post,
  typeof HOOK_PROTOCOLS.copilot.contextInjectionEvent
>;
type _OpencodeGuard = EnforceEventNameMatch<
  OpencodeEventName,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.eventNames.pre>,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.eventNames.prompt>,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.eventNames.stop>,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.eventNames.post>,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.contextInjectionEvent>
>;
type _HermesGuard = EnforceEventNameMatch<
  HermesEventName,
  NonNullable<typeof HOOK_PROTOCOLS.hermes.eventNames.pre>,
  NonNullable<typeof HOOK_PROTOCOLS.hermes.eventNames.prompt>,
  NonNullable<typeof HOOK_PROTOCOLS.hermes.eventNames.stop>,
  NonNullable<typeof HOOK_PROTOCOLS.hermes.eventNames.post>,
  NonNullable<typeof HOOK_PROTOCOLS.hermes.contextInjectionEvent>
>;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the protocol spec for an agent. Throws (at runtime, as a last-ditch
 * safety net) if `id` is not in the registry — the TS signature already
 * prevents this when `id` is statically known.
 */
export function getHookProtocol(id: AgentId): AgentHookProtocol {
  return HOOK_PROTOCOLS[id] as AgentHookProtocol;
}

/**
 * Returns true if the given event name is a valid event for the platform.
 * Useful for init helpers to validate user-supplied or template-derived
 * event names before writing them into config / plugin files.
 */
export function isValidEventName(id: AgentId, eventName: string): boolean {
  const spec = HOOK_PROTOCOLS[id];
  return (
    spec.eventNames.pre === eventName ||
    spec.eventNames.prompt === eventName ||
    spec.eventNames.stop === eventName ||
    spec.eventNames.post === eventName ||
    spec.contextInjectionEvent === eventName
  );
}

/**
 * Returns true if the platform delivers context via a subprocess whose
 * stdout is consumed by the agent (either as plain text or as a JSON
 * object). Plugins on such platforms may legitimately use "spawn a CLI
 * bin and write to stdout".
 */
export function usesStdoutInjection(id: AgentId): boolean {
  const m = HOOK_PROTOCOLS[id].injectionMechanism;
  return (
    m === 'stdout-plain-text' ||
    m === 'stdout-json-protocol' ||
    m === 'stdout-json-context'
  );
}
