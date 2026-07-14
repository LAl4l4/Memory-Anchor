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
  | 'plugin-module';

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

export type ClaudeEventName = 'SessionStart' | 'Stop' | 'SessionEnd';
export type CodexEventName = ClaudeEventName;
export type CodebuddyEventName = ClaudeEventName;
export type QodercnEventName = ClaudeEventName;

export type CopilotEventName = 'sessionStart' | 'agentStop' | 'sessionEnd';

export type OpencodeEventName =
  | 'session.created'
  | 'session.idle'
  | 'session.deleted'
  | 'experimental.chat.system.transform';

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
    | 'opencode';
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
  /** Event names the pre / stop / post hooks subscribe to on this platform. */
  readonly eventNames: {
    readonly pre: E | null;
    readonly stop: E | null;
    readonly post: E | null;
  };
  /**
   * For `output-mutation` platforms only — the event name where the
   * plugin mutates `output.system` (or equivalent) to inject context.
   * `null` for platforms that don't use mutation.
   */
  readonly contextInjectionEvent: E | null;
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
      stop: 'Stop' as ClaudeEventName,
      post: 'SessionEnd' as ClaudeEventName,
    },
    contextInjectionEvent: null,
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
      stop: 'Stop' as CodexEventName,
      post: 'SessionEnd' as CodexEventName,
    },
    contextInjectionEvent: null,
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
      stop: 'Stop' as CodebuddyEventName,
      post: 'SessionEnd' as CodebuddyEventName,
    },
    contextInjectionEvent: null,
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
      stop: 'Stop' as QodercnEventName,
      post: 'SessionEnd' as QodercnEventName,
    },
    contextInjectionEvent: null,
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
      stop: 'agentStop' as CopilotEventName,
      post: 'sessionEnd' as CopilotEventName,
    },
    contextInjectionEvent: null,
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
      // opencode has no "pre" event; context is injected via
      // `experimental.chat.system.transform` (see contextInjectionEvent).
      pre: null,
      stop: 'session.idle' as OpencodeEventName,
      post: 'session.deleted' as OpencodeEventName,
    },
    contextInjectionEvent: 'experimental.chat.system.transform' as OpencodeEventName,
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
  Stop extends E | null,
  Post extends E | null,
  Inj extends E | null,
> = [Pre, Stop, Post, Inj];

// Enforce per-platform typing without runtime cost.
type _ClaudeGuard = EnforceEventNameMatch<
  ClaudeEventName,
  typeof HOOK_PROTOCOLS.claude.eventNames.pre,
  typeof HOOK_PROTOCOLS.claude.eventNames.stop,
  typeof HOOK_PROTOCOLS.claude.eventNames.post,
  typeof HOOK_PROTOCOLS.claude.contextInjectionEvent
>;
type _CodexGuard = EnforceEventNameMatch<
  CodexEventName,
  typeof HOOK_PROTOCOLS.codex.eventNames.pre,
  typeof HOOK_PROTOCOLS.codex.eventNames.stop,
  typeof HOOK_PROTOCOLS.codex.eventNames.post,
  typeof HOOK_PROTOCOLS.codex.contextInjectionEvent
>;
type _CodebuddyGuard = EnforceEventNameMatch<
  CodebuddyEventName,
  typeof HOOK_PROTOCOLS.codebuddy.eventNames.pre,
  typeof HOOK_PROTOCOLS.codebuddy.eventNames.stop,
  typeof HOOK_PROTOCOLS.codebuddy.eventNames.post,
  typeof HOOK_PROTOCOLS.codebuddy.contextInjectionEvent
>;
type _QodercnGuard = EnforceEventNameMatch<
  QodercnEventName,
  typeof HOOK_PROTOCOLS.qodercn.eventNames.pre,
  typeof HOOK_PROTOCOLS.qodercn.eventNames.stop,
  typeof HOOK_PROTOCOLS.qodercn.eventNames.post,
  typeof HOOK_PROTOCOLS.qodercn.contextInjectionEvent
>;
type _CopilotGuard = EnforceEventNameMatch<
  CopilotEventName,
  typeof HOOK_PROTOCOLS.copilot.eventNames.pre,
  typeof HOOK_PROTOCOLS.copilot.eventNames.stop,
  typeof HOOK_PROTOCOLS.copilot.eventNames.post,
  typeof HOOK_PROTOCOLS.copilot.contextInjectionEvent
>;
type _OpencodeGuard = EnforceEventNameMatch<
  OpencodeEventName,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.eventNames.pre>,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.eventNames.stop>,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.eventNames.post>,
  NonNullable<typeof HOOK_PROTOCOLS.opencode.contextInjectionEvent>
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
  return m === 'stdout-plain-text' || m === 'stdout-json-protocol';
}
