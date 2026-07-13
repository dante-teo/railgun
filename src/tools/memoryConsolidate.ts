import { registry } from "./registry.js";

type ConsolidateAction = "merge" | "delete" | "update";
type ConsolidateCategory = "preference" | "fact" | "project";

interface ConsolidateOperation {
  action: ConsolidateAction;
  ids: readonly string[];
  newContent?: string;
  category?: ConsolidateCategory;
  reason: string;
}

const VALID_CATEGORIES: readonly ConsolidateCategory[] = ["preference", "fact", "project"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isConsolidateCategory = (value: unknown): value is ConsolidateCategory =>
  VALID_CATEGORIES.some(category => category === value);

const isConsolidateOperation = (value: unknown): value is ConsolidateOperation => {
  if (!isObject(value)) return false;

  const action = value["action"];
  if (action !== "merge" && action !== "delete" && action !== "update") return false;

  const ids = value["ids"];
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) return false;

  const reason = value["reason"];
  if (typeof reason !== "string") return false;

  const newContent = value["newContent"];
  if (newContent !== undefined && typeof newContent !== "string") return false;

  const category = value["category"];
  if (category !== undefined && !isConsolidateCategory(category)) return false;

  return true;
};

const parseOperations = (args: unknown): ConsolidateOperation[] | null => {
  if (!isObject(args)) return null;
  const ops = args["operations"];
  if (!Array.isArray(ops) || !ops.every(isConsolidateOperation)) return null;
  return ops;
};

registry.register({
  name: "memory_consolidate",
  toolset: "dream",
  verb: "Consolidating memories",
  schema: {
    name: "memory_consolidate",
    description:
      "Batch consolidate memories: merge duplicates, delete stale entries, update wording. " +
      "Each operation acts on memory IDs from the list you were given.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["merge", "delete", "update"] },
              ids: { type: "array", items: { type: "string" }, description: "Memory IDs to act on" },
              newContent: { type: "string", description: "Merged/updated content (required for merge and update)" },
              category: {
                type: "string",
                enum: ["preference", "fact", "project"],
                description: "Category for the merged/updated memory",
              },
              reason: { type: "string", description: "Why this consolidation is needed" },
            },
            required: ["action", "ids", "reason"],
          },
        },
      },
      required: ["operations"],
    },
  },
  handler: async (args, context) => {
    if (!context.memoryStore) {
      return { content: "Error: memory is not available in this context", isError: true };
    }
    const operations = parseOperations(args);
    if (!operations) {
      return { content: 'Error: memory_consolidate requires an "operations" array', isError: true };
    }
    if (operations.length === 0) {
      return { content: "No operations provided.", isError: false };
    }

    const { memoryStore } = context;
    const results: string[] = [];

    memoryStore.runInTransaction(() => {
      for (const op of operations) {
        const { action, ids, newContent, category, reason } = op;
        if (action === "delete") {
          let deleted = 0;
          for (const id of ids) {
            if (memoryStore.delete(id)) deleted++;
          }
          results.push(`Deleted ${deleted} memories (reason: ${reason})`);
        } else if (action === "merge") {
          if (ids.length < 2) {
            results.push(`Error: merge requires at least 2 ids (got ${ids.length})`);
            continue;
          }
          if (!newContent || !category) {
            results.push(`Error: merge requires newContent and category`);
            continue;
          }
          for (const id of ids) {
            memoryStore.delete(id);
          }
          memoryStore.save(newContent, category);
          results.push(`Merged ${ids.length} memories into 1 (reason: ${reason})`);
        } else if (action === "update") {
          if (ids.length !== 1) {
            results.push(`Error: update requires exactly 1 id (got ${ids.length})`);
            continue;
          }
          if (!newContent) {
            results.push(`Error: update requires newContent`);
            continue;
          }
          const cat = category ?? "fact";
          const updated = memoryStore.update(ids[0]!, newContent, cat);
          if (updated === null) {
            results.push(`Error: memory ${ids[0]} not found`);
          } else {
            results.push(`Updated memory (reason: ${reason})`);
          }
        } else {
          const exhaustive: never = action;
          results.push(`Error: unknown action "${String(exhaustive)}"`);
        }
      }
    });

    return { content: results.join("\n"), isError: false };
  },
});
