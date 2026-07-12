import { describe, expect, it, vi } from "vitest";
import { registry } from "./registry.js";
import type { ToolContext } from "./registry.js";
import type { AdvisoryContext } from "../advisor/advisoryContext.js";
import type { DevinMessage } from "widevin";
import "./advise.js";

const makeAdvisoryContext = (overrides: Partial<AdvisoryContext> = {}): AdvisoryContext => ({
  steer: vi.fn(),
  appendToPrimary: vi.fn(),
  dedupe: new Set<string>(),
  notesThisUpdate: 0,
  ...overrides,
});

const makeContext = (advisoryContext?: AdvisoryContext): ToolContext => ({
  signal: new AbortController().signal,
  commandApprovalMode: "manual",
  sessionApprovals: new Set<string>(),
  confirmShellCommand: async () => false,
  ...(advisoryContext !== undefined ? { advisoryContext } : {}),
});

describe("advise tool", () => {
  it("returns error when advisoryContext is missing", async () => {
    const result = await registry.run("advise", { note: "something" }, makeContext());
    expect(result).toEqual({
      content: "Error: advise tool requires advisory context",
      isError: true,
    });
  });

  it("severity concern → steer called with XML-wrapped note", async () => {
    const ctx = makeAdvisoryContext();
    const result = await registry.run(
      "advise",
      { note: "missing null check", severity: "concern" },
      makeContext(ctx),
    );
    expect(result).toEqual({ content: "Recorded.", isError: false });
    expect(ctx.steer).toHaveBeenCalledOnce();
    const call = (ctx.steer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(call).toContain('<advisory severity="concern"');
    expect(call).toContain("missing null check");
    expect(ctx.appendToPrimary).not.toHaveBeenCalled();
  });

  it("no severity → appendToPrimary called with nit XML", async () => {
    const ctx = makeAdvisoryContext();
    const result = await registry.run("advise", { note: "minor rename" }, makeContext(ctx));
    expect(result).toEqual({ content: "Recorded.", isError: false });
    expect(ctx.appendToPrimary).toHaveBeenCalledOnce();
    const msg = (ctx.appendToPrimary as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DevinMessage;
    expect(typeof msg.content === "string" && msg.content).toContain('<advisory severity="nit"');
    expect(ctx.steer).not.toHaveBeenCalled();
  });

  it("content-free 'lgtm' → Recorded, no steer/append", async () => {
    const ctx = makeAdvisoryContext();
    const result = await registry.run("advise", { note: "lgtm" }, makeContext(ctx));
    expect(result).toEqual({ content: "Recorded.", isError: false });
    expect(ctx.steer).not.toHaveBeenCalled();
    expect(ctx.appendToPrimary).not.toHaveBeenCalled();
  });

  it("content-free with punctuation/caps variation → suppressed", async () => {
    const ctx = makeAdvisoryContext();
    const result = await registry.run("advise", { note: "LGTM!" }, makeContext(ctx));
    expect(result).toEqual({ content: "Recorded.", isError: false });
    expect(ctx.steer).not.toHaveBeenCalled();
  });

  it("same note twice → second returns Recorded, no second delivery", async () => {
    const ctx = makeAdvisoryContext();
    await registry.run("advise", { note: "missing null check", severity: "concern" }, makeContext(ctx));
    const second = await registry.run("advise", { note: "missing null check", severity: "concern" }, makeContext(ctx));
    expect(second).toEqual({ content: "Recorded.", isError: false });
    expect(ctx.steer).toHaveBeenCalledOnce();
  });

  it("two distinct notes in same cycle → second returned Recorded via rate limit", async () => {
    const ctx = makeAdvisoryContext();
    await registry.run("advise", { note: "first issue", severity: "concern" }, makeContext(ctx));
    const second = await registry.run("advise", { note: "second issue", severity: "blocker" }, makeContext(ctx));
    expect(second).toEqual({ content: "Recorded.", isError: false });
    expect(ctx.steer).toHaveBeenCalledOnce();
  });

  it("severity blocker → steer called (not appendToPrimary)", async () => {
    const ctx = makeAdvisoryContext();
    await registry.run("advise", { note: "breaks everything", severity: "blocker" }, makeContext(ctx));
    expect(ctx.steer).toHaveBeenCalledOnce();
    const call = (ctx.steer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(call).toContain('<advisory severity="blocker"');
    expect(ctx.appendToPrimary).not.toHaveBeenCalled();
  });

  it("XML-special chars in note are escaped", async () => {
    const ctx = makeAdvisoryContext();
    await registry.run("advise", { note: "use <tag> & 'quotes'", severity: "nit" }, makeContext(ctx));
    const msg = (ctx.appendToPrimary as ReturnType<typeof vi.fn>).mock.calls[0]![0] as DevinMessage;
    expect(typeof msg.content === "string" && msg.content).toContain("&lt;tag&gt;");
    expect(typeof msg.content === "string" && msg.content).toContain("&amp;");
  });
});
