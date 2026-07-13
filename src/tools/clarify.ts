import { registry } from "./registry.js";
import { runBoundedOperation } from "../asyncOperation.js";

const extractQuestion = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const question = (args as Record<string, unknown>).question;
  return typeof question === "string" ? question : undefined;
};

const extractChoices = (args: unknown): string[] | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const choices = (args as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return undefined;
  const strings = choices.filter((c): c is string => typeof c === "string");
  return strings.length > 0 ? strings.slice(0, 4) : undefined;
};

registry.register({
  name: "clarify",
  toolset: "clarify",
  verb: "Asking",
  previewArgKey: "question",
  schema: {
    name: "clarify",
    description:
      "Ask the user a clarifying question before continuing. " +
      "Use this when you are missing information you cannot safely guess. " +
      "Offer up to 4 short choices when it makes sense.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user." },
        choices: {
          type: "array",
          items: { type: "string" },
          maxItems: 4,
          description: "Up to 4 short choices. Optional — omit for open-ended questions.",
        },
      },
      required: ["question"],
    },
  },
  handler: async (args, context) => {
    const question = extractQuestion(args);
    if (question === undefined) {
      return { content: 'Error: clarify requires a string "question" argument', isError: true };
    }
    if (!context.clarifyCallback) {
      return { content: "Error: clarify is not available in this context", isError: true };
    }
    const choices = extractChoices(args);
    const answer = await runBoundedOperation(context.signal, undefined, "Clarification prompt", () => context.clarifyCallback!(question, choices));
    return {
      content: JSON.stringify({ question, answer }),
      isError: false,
    };
  },
});
