import { describe, expect, it } from "vitest";
import type React from "react";
import { StatusBar } from "./StatusBar.js";

// Recursively collect all string text from a React element tree.
const flatText = (node: unknown): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node === null || node === undefined || node === false || node === true) return "";
  if (Array.isArray(node)) return node.map(flatText).join("");
  const el = node as React.ReactElement<{ children?: unknown }>;
  if (el.props) return flatText(el.props.children);
  return "";
};

// Return first element in tree matching predicate, depth-first.
const findEl = (node: unknown, pred: (el: React.ReactElement) => boolean): React.ReactElement | null => {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findEl(child, pred);
      if (found) return found;
    }
    return null;
  }
  const el = node as React.ReactElement<{ children?: unknown; className?: string; title?: string }>;
  if (el && typeof el === "object" && "props" in el) {
    if (pred(el)) return el;
    return findEl(el.props.children, pred);
  }
  return null;
};

const defaultProps = {
  model: "claude-sonnet-4",
  gitStatus: { branch: "main" as string | null, dirty: false },
  cwd: "~/Projects/railgun",
  unsaved: false,
  activeMoaPreset: null as { name: string } | null,
};

describe("StatusBar", () => {
  it("renders model name", () => {
    const bar = StatusBar({ ...defaultProps, model: "claude-sonnet-4" });
    expect(flatText(bar)).toContain("claude-sonnet-4");
  });

  it("renders git branch", () => {
    const bar = StatusBar({ ...defaultProps, gitStatus: { branch: "main", dirty: false } });
    const left = (bar as React.ReactElement<{ children: readonly React.ReactElement[] }>).props.children[0];
    expect(flatText(left)).toContain("main");
  });

  it("renders dirty dot when dirty", () => {
    const bar = StatusBar({ ...defaultProps, gitStatus: { branch: "main", dirty: true } });
    const dirtyDot = findEl(bar, el => {
      const e = el as React.ReactElement<{ className?: string }>;
      return e.props.className === "status-bar__dirty-dot";
    });
    expect(dirtyDot).not.toBeNull();
  });

  it("hides git when branch is null", () => {
    const bar = StatusBar({ ...defaultProps, gitStatus: { branch: null, dirty: false } });
    const left = (bar as React.ReactElement<{ children: readonly React.ReactElement[] }>).props.children[0];
    // No branch text — left section should not contain any branch name
    expect(flatText(left)).not.toContain("main");
  });

  it("renders cwd", () => {
    const bar = StatusBar({ ...defaultProps, cwd: "~/Projects/railgun" });
    const left = (bar as React.ReactElement<{ children: readonly React.ReactElement[] }>).props.children[0];
    expect(flatText(left)).toContain("~/Projects/railgun");
  });

  it("renders MoA preset name", () => {
    const bar = StatusBar({ ...defaultProps, activeMoaPreset: { name: "fast" } });
    const right = (bar as React.ReactElement<{ children: readonly React.ReactElement[] }>).props.children[2];
    expect(flatText(right)).toContain("fast");
  });

  it("hides MoA when null", () => {
    const bar = StatusBar({ ...defaultProps, activeMoaPreset: null });
    const right = (bar as React.ReactElement<{ children: readonly React.ReactElement[] }>).props.children[2];
    const moaSpan = findEl(right, el => {
      const e = el as React.ReactElement<{ title?: string }>;
      return e.props.title === "MoA preset";
    });
    expect(moaSpan).toBeNull();
  });

  it("renders unsaved indicator", () => {
    const bar = StatusBar({ ...defaultProps, unsaved: true });
    expect(flatText(bar)).toContain("●");
  });

  it("hides unsaved indicator when saved", () => {
    const bar = StatusBar({ ...defaultProps, unsaved: false });
    expect(flatText(bar)).not.toContain("●");
  });
});
