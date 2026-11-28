import { HumanMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { resolveProviderConfig } from '../config.mjs';
import { buildResult, MAX_NUDGES, preparePrompts, resolveWorkspace } from '../core.mjs';
import { startMemoryAnchor } from '../memoryAnchor.mjs';
import { builtinTools } from '../tools/builtin.mjs';
import { RunRecorder } from '../trace.mjs';
import { buildGraph, toLangChainTools } from './agent.mjs';
import { createChatModel } from './models.mjs';

/**
 * Multi-agent LangGraph engine: a fixed planner → coder → reviewer pipeline. Each role is the
 * single-agent graph from agent.mjs run as a subgraph with its own system prompt, tool subset and
 * turn budget; the parent graph moves the plan, the coder's summary and review feedback between them.
 *
 *   START → planner → coder → reviewer ─┬─ coder   (VERDICT: CHANGES, up to maxReviewRounds)
 *                                        └─ END
 *
 * agent.maxTurns caps model calls across all roles together, so a run costs no more turns than a
 * single-agent run with the same config. The coder keeps its conversation across review rounds;
 * planner and reviewer start fresh each time they run.
 */

export const ROLES = ['planner', 'coder', 'reviewer'];

const ROLE_PROMPTS = {
  planner: `# Your role: planner

You are the planner in a planner → coder → reviewer team. You can only read the repository: you have no
edit or command tools, and the instructions above about editing and running checks are for the coder.
Investigate the task: find the relevant files, the code paths involved and any constraints stated in project
instructions or memory that the change must preserve. Then stop calling tools and reply with a concise plan:
the files to change, the exact changes, risks or invariants to keep, and how to verify. Do not write the code.`,
  coder: `# Your role: coder

You are the coder in a planner → coder → reviewer team. You receive the task and the planner's plan. Treat the
plan as a starting point, not as truth: confirm it against the code before editing. Implement the change, run
the relevant checks, then stop calling tools and reply with a short summary of what you changed and why.
A reviewer will check your work and may send feedback; when it does, address it and reply with an updated summary.`,
  reviewer: `# Your role: reviewer

You are the reviewer in a planner → coder → reviewer team. You can read files and run commands, but do not
edit files or change the repository state; the instructions above about editing are for the coder. Check the
coder's change against the task and the project's constraints: inspect the diff (e.g. \`git diff\`), read the
touched code and run the relevant tests. Then stop calling tools and reply with concrete findings, ending with
exactly one line: \`VERDICT: APPROVE\` when the change is correct and complete, or \`VERDICT: CHANGES\` when the
coder must fix something (list what above that line).`,
};

const READ_KINDS = new Set(['search', 'read']);
const isReadOnly = (t) => READ_KINDS.has(t.kind) || (t.kind === 'mcp' && t.name !== 'write_memory');

/** Which tools each role may call. The coder gets everything. */
function toolsForRole(role, tools) {
  if (role === 'planner') return tools.filter(isReadOnly);
  if (role === 'reviewer') return tools.filter((t) => isReadOnly(t) || t.kind === 'exec');
  return tools;
}

export function parseVerdict(text) {
  const matches = [...String(text ?? '').matchAll(/VERDICT:\s*\**\s*(APPROVE|CHANGES)\b/gi)];
  if (!matches.length) return 'none';
  return matches.at(-1)[1].toUpperCase() === 'APPROVE' ? 'approve' : 'changes';
}

const keep = (_, next) => next;
const PipelineState = Annotation.Root({
  task: Annotation({ reducer: keep, default: () => '' }),
  plan: Annotation({ reducer: keep, default: () => '' }),
  coderMessages: Annotation({ reducer: keep, default: () => [] }),
  summary: Annotation({ reducer: keep, default: () => '' }),
  review: Annotation({ reducer: keep, default: () => '' }),
  verdict: Annotation({ reducer: keep, default: () => 'none' }),
  reviewRounds: Annotation({ reducer: keep, default: () => 0 }),
  /** Run status so far; `stop` ends the pipeline early (refusal, error, total turn budget used up). */
  status: Annotation({ reducer: keep, default: () => 'error' }),
  stop: Annotation({ reducer: keep, default: () => false }),
});

const clipText = (s, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n[... ${s.length - n} characters omitted ...]` : s);

/** Recorder view for one role: events carry `agent`, and the role's own turn and tool counts are kept. */
function roleRecorder(recorder, role, stats) {
  return {
    emit: (event) => recorder.emit({ ...event, agent: role }),
    recordTurn(turn) {
      stats.turns += 1;
      recorder.recordTurn(turn);
    },
    recordTool(...args) {
      stats.toolCalls += 1;
      recorder.recordTool(...args);
    },
    get turns() {
      return recorder.turns;
    },
    get toolCalls() {
      return recorder.toolCalls;
    },
  };
}

export async function runMultiAgent({ config, workspace, task, traceFile, onEvent }) {
  const root = resolveWorkspace(workspace, task);
  const chat = createChatModel(resolveProviderConfig(config));
  const recorder = new RunRecorder({ traceFile, onEvent });
  const emit = (event) => recorder.emit(event);
  const settings = config.agent.multiAgent;
  const maxTurns = config.agent.maxTurns;
  const caps = { planner: settings.plannerMaxTurns, coder: Infinity, reviewer: settings.reviewerMaxTurns };
  const stats = Object.fromEntries(ROLES.map((r) => [r, { runs: 0, turns: 0, toolCalls: 0, lastStatus: null }]));

  let ma = null;
  let status = 'error';
  let finalText = '';
  let errorMessage;
  let final = null;

  try {
    if (config.memoryAnchor.enabled) ma = await startMemoryAnchor({ settings: config.memoryAnchor, workspace: root, emit });

    const tools = [...builtinTools(config), ...(ma?.tools ?? [])];
    const { system, userText } = preparePrompts({ config, root, task, ma });
    const roleTools = Object.fromEntries(ROLES.map((r) => [r, toolsForRole(r, tools)]));

    emit({
      type: 'run_start',
      engine: 'langgraph-multi',
      provider: chat.name,
      model: chat.model,
      workspace: root,
      memoryAnchor: Boolean(ma),
      tools: tools.map((t) => t.name),
      roles: Object.fromEntries(ROLES.map((r) => [r, roleTools[r].map((t) => t.name)])),
      systemChars: system.length,
      task: task.trim(),
    });

    // One compiled subgraph per role. `current` holds the turn count when the role's latest run began.
    const current = {};
    const subgraphs = Object.fromEntries(
      ROLES.map((role) => {
        const subset = roleTools[role];
        const graph = buildGraph({
          model: { runnable: chat.bind(toLangChainTools(subset)), toTurn: chat.toTurn },
          toolMap: new Map(subset.map((t) => [t.name, t])),
          root,
          config,
          recorder: roleRecorder(recorder, role, stats[role]),
          system: `${system}\n\n${ROLE_PROMPTS[role]}`,
          budget: () => {
            const used = recorder.turns - current[role];
            return { turns: used, maxTurns: Math.min(caps[role], used + (maxTurns - recorder.turns)) };
          },
        });
        return [role, graph];
      }),
    );

    /** Run one role to the end of its own loop. Returns its final subgraph state. */
    async function runRole(role, messages) {
      current[role] = recorder.turns;
      stats[role].runs += 1;
      emit({ type: 'agent_start', agent: role, run: stats[role].runs, turnsLeft: maxTurns - recorder.turns });
      const limit = Math.min(caps[role], maxTurns - recorder.turns);
      const out = await subgraphs[role].invoke({ messages }, { recursionLimit: 2 * (limit + MAX_NUDGES) + 5 });
      stats[role].lastStatus = out.status;
      emit({ type: 'agent_end', agent: role, run: stats[role].runs, status: out.status, turns: recorder.turns - current[role] });
      return out;
    }

    /** Pipeline-level reaction to a role's status: refusals and the total budget end the run. */
    function stopFor(out) {
      if (out.status === 'refused') return { status: 'refused', stop: true };
      if (recorder.turns >= maxTurns) return { status: 'max_turns', stop: true };
      return null;
    }
    const budgetLeft = () => recorder.turns < maxTurns;

    async function plannerNode(state) {
      if (!budgetLeft()) return { status: 'max_turns', stop: true };
      const out = await runRole('planner', [new HumanMessage(state.task)]);
      return { plan: out.finalText || '(The planner returned no plan; investigate the task yourself.)', ...stopFor(out) };
    }

    async function coderNode(state) {
      if (!budgetLeft()) return { status: 'max_turns', stop: true };
      const messages = state.coderMessages.length
        ? [
            ...state.coderMessages,
            new HumanMessage(
              `The reviewer requested changes (review round ${state.reviewRounds}):\n\n${state.review}\n\n` +
                'Address them, run the relevant checks again, then reply with an updated summary.',
            ),
          ]
        : [new HumanMessage(`${state.task}\n\n# Plan from the planner\n\n${state.plan}`)];
      const out = await runRole('coder', messages);
      return { coderMessages: out.messages, summary: out.finalText || state.summary, status: out.status, ...stopFor(out) };
    }

    async function reviewerNode(state) {
      if (!budgetLeft()) return { status: 'max_turns', stop: true };
      const brief =
        `${state.task}\n\n# Plan from the planner\n\n${state.plan}\n\n` +
        `# Coder's summary of the change\n\n${state.summary || '(no summary)'}\n\n` +
        'Review the change now in the workspace.';
      const out = await runRole('reviewer', [new HumanMessage(brief)]);
      const verdict = parseVerdict(out.finalText);
      if (out.status === 'refused') return { review: out.finalText, verdict, status: 'refused', stop: true };
      // A reviewer that used up the total budget ends the run, but the coder's status stands.
      return { review: out.finalText, verdict, ...(budgetLeft() ? {} : { stop: true }) };
    }

    function afterReview(state) {
      if (state.stop) return END;
      if (state.verdict === 'changes' && state.reviewRounds < settings.maxReviewRounds) return 'feedback';
      return END;
    }

    const pipeline = new StateGraph(PipelineState)
      .addNode('planner', plannerNode)
      .addNode('coder', coderNode)
      .addNode('reviewer', reviewerNode)
      .addNode('feedback', (state) => ({ reviewRounds: state.reviewRounds + 1 }))
      .addEdge(START, 'planner')
      .addConditionalEdges('planner', (s) => (s.stop ? END : 'coder'), { coder: 'coder', [END]: END })
      // A coder that ended on its own (or was cut off) still goes to review; only a hard stop skips it.
      .addConditionalEdges('coder', (s) => (s.stop ? END : 'reviewer'), { reviewer: 'reviewer', [END]: END })
      .addConditionalEdges('reviewer', afterReview, { feedback: 'feedback', [END]: END })
      .addEdge('feedback', 'coder')
      .compile();

    final = await pipeline.invoke({ task: userText }, { recursionLimit: 4 * (settings.maxReviewRounds + 2) + 5 });
    status = final.status;
    finalText = final.summary;
  } catch (error) {
    status = 'error';
    errorMessage = error.message;
    emit({ type: 'error', message: error.message, stack: error.stack });
  } finally {
    if (ma) {
      await ma.stop().catch((error) => emit({ type: 'error', message: `Stop hook failed: ${error.message}` }));
      await ma.close();
    }
  }

  const result = {
    ...buildResult({ status, errorMessage, finalText, engine: 'langgraph-multi', provider: chat.name, model: chat.model, root, ma, recorder }),
    multiAgent: {
      roles: stats,
      reviewRounds: final?.reviewRounds ?? 0,
      verdict: final?.verdict ?? 'none',
      plan: clipText(final?.plan ?? ''),
      lastReview: clipText(final?.review ?? ''),
    },
  };
  emit({ type: 'run_end', status, durationMs: result.durationMs, turns: result.turns, usage: result.usage, verdict: result.multiAgent.verdict });
  return result;
}
