import { registry } from "./registry.js";
import type { ToolRunResult } from "./registry.js";
import type { DevinProvider } from "widevin";
import type { AgentEvent } from "../agent/events.js";
import { IterationBudget } from "../agent/iterationBudget.js";
import { runTurn } from "../agent/turn.js";
import { DEFAULT_TOOLSETS } from "./toolsets.js";

const CHILD_SYSTEM_PROMPT: readonly string[] = [
  "You are a focused subagent. Complete the task described below, then give a concise summary of what you did and found. Do not ask clarifying questions — work with what you have.",
];

const MAX_SPAWN_DEPTH = 2;
const MAX_CONCURRENT_CHILDREN = 3;
const CHILD_ITERATION_BUDGET = 50;

const LEAF_TOOLSETS: readonly string[] = DEFAULT_TOOLSETS;
const ORCHESTRATOR_TOOLSETS: readonly string[] = [...LEAF_TOOLSETS, "delegation"];

interface TaskSpec {
  goal: string;
  context?: string;
  role?: "leaf" | "orchestrator";
}

async function runOneChild(
  devin: DevinProvider,
  model: string,
  contextWindow: number,
  goal: string,
  childContext: string | undefined,
  role: "leaf" | "orchestrator",
  parentDepth: number,
  parentSignal: AbortSignal,
): Promise<string> {
  const childDepth = parentDepth + 1;

  const enabledToolsets = role === "orchestrator" && childDepth < MAX_SPAWN_DEPTH
    ? ORCHESTRATOR_TOOLSETS
    : LEAF_TOOLSETS;

  const userText = childContext ? `${goal}\n\nContext:\n${childContext}` : goal;
  const childBudget = IterationBudget.create(CHILD_ITERATION_BUDGET);
  const childController = new AbortController();

  const onParentAbort = (): void => childController.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", onParentAbort, { once: true });

  try {
    const outcome = await runTurn(
      devin, model, contextWindow, CHILD_SYSTEM_PROMPT,
      [],
      userText,
      childBudget,
      /* confirmShellCommand */ async () => true, // subagents run under parent's trust boundary; no interactive prompts
      undefined,
      {
        signal: childController.signal,
        commandApprovalMode: "off",
        sessionApprovals: new Set<string>(),
        enabledToolsets,
        model,
        contextWindow,
        delegationDepth: childDepth,
      },
    );

    if (!outcome.ok) {
      if ("aborted" in outcome) return `[subagent aborted] ${outcome.assistantText}`;
      return `[subagent error] ${String(outcome.error)}`;
    }
    return outcome.assistantText;
  } finally {
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

async function runBatched(
  jobs: TaskSpec[],
  devin: DevinProvider,
  model: string,
  contextWindow: number,
  parentDepth: number,
  parentSignal: AbortSignal,
  emit: ((event: AgentEvent) => Promise<void>) | undefined,
): Promise<string[]> {
  const results: string[] = new Array(jobs.length);
  const count = jobs.length;

  for (let batchStart = 0; batchStart < jobs.length; batchStart += MAX_CONCURRENT_CHILDREN) {
    const batch = jobs.slice(batchStart, batchStart + MAX_CONCURRENT_CHILDREN);
    await Promise.all(
      batch.map(async (job, batchIndex) => {
        const globalIndex = batchStart + batchIndex;
        await emit?.({ type: "subagent_start", goal: job.goal, index: globalIndex, count });
        const result = await runOneChild(
          devin, model, contextWindow,
          job.goal, job.context,
          job.role ?? "leaf",
          parentDepth,
          parentSignal,
        );
        await emit?.({ type: "subagent_end", goal: job.goal, index: globalIndex, result });
        results[globalIndex] = result;
      }),
    );
  }

  return results;
}

registry.register({
  name: "delegate_task",
  toolset: "delegation",
  verb: "Delegating",
  previewArgKey: "goal",
  schema: {
    name: "delegate_task",
    description:
      "Spawn one or more independent subagents to work on focused sub-tasks concurrently. " +
      "Each subagent runs a full agent loop with its own iteration budget. " +
      "Use 'goal' for a single task or 'tasks' for multiple concurrent tasks. " +
      "Leaf subagents (default) cannot delegate further; orchestrators can (up to depth limit).",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "Single task goal (for one subagent). Mutually exclusive with 'tasks'.",
        },
        context: {
          type: "string",
          description: "Background info the subagent needs (used with 'goal').",
        },
        tasks: {
          type: "array",
          description: "Multiple independent tasks to run concurrently. Mutually exclusive with 'goal'.",
          items: {
            type: "object",
            properties: {
              goal: { type: "string" },
              context: { type: "string" },
              role: { type: "string", enum: ["leaf", "orchestrator"] },
            },
            required: ["goal"],
          },
        },
        role: {
          type: "string",
          enum: ["leaf", "orchestrator"],
          description: "Default 'leaf': child cannot delegate further. 'orchestrator': child may delegate (below depth cap).",
        },
      },
    },
  },
  handler: async (args, context): Promise<ToolRunResult> => {
    const a = args as Record<string, unknown>;

    // Validate mutual exclusivity
    const hasGoal = typeof a.goal === "string" && a.goal.trim().length > 0;
    const hasTasks = Array.isArray(a.tasks) && (a.tasks as unknown[]).length > 0;
    if (!hasGoal && !hasTasks) {
      return { content: "Error: delegate_task requires either 'goal' (string) or 'tasks' (non-empty array).", isError: true };
    }
    if (hasGoal && hasTasks) {
      return { content: "Error: delegate_task accepts either 'goal' or 'tasks', not both.", isError: true };
    }

    // Depth check
    const parentDepth = context.delegationDepth;
    if (parentDepth === undefined || parentDepth >= MAX_SPAWN_DEPTH) {
      return { content: `Error: Maximum delegation depth reached (max depth: ${MAX_SPAWN_DEPTH}).`, isError: true };
    }

    // Required context fields
    if (context.devin === undefined) {
      return { content: "Error: delegate_task requires a DevinProvider in context (not available in this context).", isError: true };
    }
    if (context.model === undefined || context.contextWindow === undefined) {
      return { content: "Error: delegate_task requires model and contextWindow in context.", isError: true };
    }

    const { devin, model, contextWindow } = context;
    const parentSignal = context.signal;

    // Normalize to task list
    const jobs: TaskSpec[] = hasGoal
      ? [{ goal: a.goal as string, ...(typeof a.context === "string" ? { context: a.context as string } : {}), role: a.role === "orchestrator" ? "orchestrator" : "leaf" }]
      : (a.tasks as TaskSpec[]).map(t => ({
          goal: t.goal,
          ...(t.context !== undefined ? { context: t.context } : {}),
          role: t.role === "orchestrator" ? "orchestrator" : "leaf",
        }));

    const results = await runBatched(
      jobs, devin, model, contextWindow, parentDepth, parentSignal, context.emit,
    );

    const payload = jobs.map((job, i) => ({ task: job.goal, result: results[i] }));
    return { content: JSON.stringify(payload), isError: false };
  },
});
