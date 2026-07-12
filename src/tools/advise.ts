import { registry } from "./registry.js";

const CONTENT_FREE: Record<string, true> = {
  "stop": true,
  "done": true,
  "complete": true,
  "no issue continue": true,
  "lgtm": true,
  "nothing to add": true,
};

const normalizeNote = (note: string): string =>
  note.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();

const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

registry.register({
  name: "advise",
  toolset: "advisory",
  schema: {
    name: "advise",
    description:
      "Surface ONE piece of advice about the primary agent's recent work. " +
      "Use 'nit' for low-risk cleanup, 'concern' for likely wrong direction, " +
      "'blocker' for clear waste/breakage. Call AT MOST ONCE per review. " +
      "If no concerns, call nothing.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string" },
        severity: { type: "string", enum: ["nit", "concern", "blocker"] },
      },
      required: ["note"],
    },
  },
  handler: async (args, context) => {
    const ctx = context.advisoryContext;
    if (ctx === undefined) {
      return { content: "Error: advise tool requires advisory context", isError: true };
    }

    const a = args as Record<string, unknown>;
    const rawNote = typeof a.note === "string" ? a.note : "";
    const severity: "nit" | "concern" | "blocker" =
      a.severity === "concern" || a.severity === "blocker" ? a.severity : "nit";

    const key = normalizeNote(rawNote);

    const silent =
      key in CONTENT_FREE ||
      ctx.dedupe.has(key) ||
      ctx.notesThisUpdate >= 1;

    if (silent) return { content: "Recorded.", isError: false };

    ctx.dedupe.add(key);
    ctx.notesThisUpdate++;

    const wrapped = `<advisory severity="${severity}" guidance="weigh, don't blindly obey">\n${escapeXml(rawNote)}\n</advisory>`;

    // Deliver every note through the turn's steer queue. Appending a nit after
    // the assistant has finished leaves history ending in a synthetic user
    // message, which is invalid for checkpoints and the next provider request.
    ctx.steer(wrapped);

    return { content: "Recorded.", isError: false };
  },
});
