import { normalizeTodoState } from "../tools/todo.js";
import type { TodoState, TodoStatus } from "../tools/todo.js";

const CHECKBOX_LINE = /^(\s*)[-*+]\s+\[([ xX~])\]\s+(.+?)\s*$/;

interface ParsedLine {
  depth: number;
  item: {
    id: string;
    content: string;
    status: TodoStatus;
    children?: ParsedLine["item"][];
  };
}

const checkboxStatus = (value: string): TodoStatus => {
  if (value === "x" || value === "X") return "completed";
  if (value === "~") return "in_progress";
  return "pending";
};

const slug = (content: string): string => {
  const normalized = content
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized === "" ? "todo" : normalized.slice(0, 48);
};

const parseLine = (line: string, index: number): ParsedLine | null => {
  const match = CHECKBOX_LINE.exec(line);
  if (!match) return null;
  const [, indent = "", marker = " ", rawContent = ""] = match;
  const content = rawContent.trim();
  if (content === "") return null;
  return {
    depth: Math.floor(indent.replace(/\t/g, "  ").length / 2),
    item: {
      id: `md-${index + 1}-${slug(content)}`,
      content,
      status: checkboxStatus(marker)
    }
  };
};

const attachLine = (roots: ParsedLine["item"][], stack: ParsedLine[], line: ParsedLine): readonly [ParsedLine["item"][], ParsedLine[]] => {
  const parent = [...stack].reverse().find(candidate => candidate.depth < line.depth);
  if (!parent) return [[...roots, line.item], [line]];
  const children = parent.item.children ?? [];
  parent.item.children = [...children, line.item];
  return [roots, [...stack.filter(candidate => candidate.depth < line.depth), line]];
};

export const extractMarkdownTodos = (text: string): TodoState => {
  const [roots] = text
    .split(/\r?\n/)
    .map(parseLine)
    .filter((line): line is ParsedLine => line !== null)
    .reduce<readonly [ParsedLine["item"][], ParsedLine[]]>(
      ([items, stack], line) => attachLine(items, stack, line),
      [[], []]
    );
  return normalizeTodoState(roots);
};

export const stripMarkdownTodoLines = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter(line => !CHECKBOX_LINE.test(line))
    .join("\n")
    .trim();
