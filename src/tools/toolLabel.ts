import { registry } from "./registry.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readField = (args: unknown, key: string): unknown => (isRecord(args) ? args[key] : undefined);

const oneLine = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");

const truncate = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}...` : text);

const formatLabel = (text: string): string => truncate(oneLine(text));

export const buildToolLabel = (name: string, args: unknown, phase: "start" | "complete"): string => {
  if (name === "__batch__") {
    const count = readField(args, "count");
    const total = typeof count === "number" ? count : 0;
    return phase === "start" ? `Running ${total} tools concurrently` : `${total}/${total} tools completed`;
  }

  const tool = registry.get(name);
  const previewValue =
    tool?.verb !== undefined && tool.previewArgKey !== undefined ? readField(args, tool.previewArgKey) : undefined;

  if (tool?.verb !== undefined && typeof previewValue === "string") {
    return formatLabel(`${tool.verb} ${previewValue}`);
  }

  return formatLabel(`${name} ${JSON.stringify(args)}`);
};
