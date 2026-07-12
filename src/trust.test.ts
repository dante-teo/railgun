import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertProjectTrustedForInstall,
  assertProjectTrustedForRead,
  createProjectTrustStore,
  resolveProjectTrust,
} from "./trust.js";
import type { TrustDecision } from "./trust.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "railgun-trust-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// DI helpers — synchronous in-memory write to avoid real FS in most tests
const makeOptions = () => {
  let stored: string | undefined;
  return {
    path: join(directory, "trust.json"),
    readFile: (p: string): string => {
      if (stored === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return stored;
    },
    writeFile: (_p: string, contents: string): void => { stored = contents; },
    get stored() { return stored; },
  };
};

describe("createProjectTrustStore", () => {
  it("returns unknown for an unrecorded directory", () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    expect(store.get(directory)).toEqual({ status: "unknown" });
  });

  it("returns trusted (persisted) after set(cwd, 'trust')", () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const result = store.set(directory, "trust");
    expect(result).toEqual({ status: "trusted", scope: "persisted" });
    expect(store.get(directory)).toEqual({ status: "trusted", scope: "persisted" });
  });

  it("returns denied (persisted) after set(cwd, 'deny')", () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const result = store.set(directory, "deny");
    expect(result).toEqual({ status: "denied", scope: "persisted" });
    expect(store.get(directory)).toEqual({ status: "denied", scope: "persisted" });
  });

  it("returns trusted (session) for 'trust-session' without writing", () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const result = store.set(directory, "trust-session");
    expect(result).toEqual({ status: "trusted", scope: "session" });
    expect(opts.stored).toBeUndefined(); // nothing persisted
    // In-memory state also not affected — get still returns unknown
    expect(store.get(directory)).toEqual({ status: "unknown" });
  });

  it("ancestor walking: trusting a directory makes deeper children trusted", () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const ancestor = join(directory, "a", "b");
    store.set(ancestor, "trust");
    const deep = join(directory, "a", "b", "c", "d");
    expect(store.get(deep)).toEqual({ status: "trusted", scope: "persisted" });
  });

  it("separate sibling directories have independent decisions", () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const dirA = join(directory, "project-a");
    const dirB = join(directory, "project-b");
    store.set(dirA, "trust");
    store.set(dirB, "deny");
    expect(store.get(dirA)).toEqual({ status: "trusted", scope: "persisted" });
    expect(store.get(dirB)).toEqual({ status: "denied", scope: "persisted" });
  });

  it("loads persisted decisions from disk on creation", () => {
    // First store — set a decision
    const opts = makeOptions();
    const store1 = createProjectTrustStore(opts);
    store1.set(directory, "trust");
    expect(opts.stored).toBeDefined();

    // Second store using same DI (simulates reading existing file)
    const store2 = createProjectTrustStore(opts);
    expect(store2.get(directory)).toEqual({ status: "trusted", scope: "persisted" });
  });

  it("missing trust file yields empty store without error", () => {
    const opts = makeOptions();
    // readFile throws ENOENT — no stored value set
    expect(() => createProjectTrustStore(opts)).not.toThrow();
    const store = createProjectTrustStore(opts);
    expect(store.get(directory)).toEqual({ status: "unknown" });
  });
});

describe("resolveProjectTrust", () => {
  const noop = vi.fn(async () => "trust" as const);

  it("cliApprove returns trusted session without calling prompt", async () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const prompt = vi.fn();
    const result = await resolveProjectTrust(directory, store, {
      cliApprove: true,
      defaultTrust: "ask",
      promptTrustChoice: prompt,
    });
    expect(result).toEqual({ status: "trusted", scope: "session" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("cliNoApprove returns denied session without calling prompt", async () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const prompt = vi.fn();
    const result = await resolveProjectTrust(directory, store, {
      cliNoApprove: true,
      defaultTrust: "ask",
      promptTrustChoice: prompt,
    });
    expect(result).toEqual({ status: "denied", scope: "session" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("defaultTrust 'always' returns trusted session without calling prompt", async () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const prompt = vi.fn();
    const result = await resolveProjectTrust(directory, store, {
      defaultTrust: "always",
      promptTrustChoice: prompt,
    });
    expect(result).toEqual({ status: "trusted", scope: "session" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("defaultTrust 'never' returns denied session without calling prompt", async () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const prompt = vi.fn();
    const result = await resolveProjectTrust(directory, store, {
      defaultTrust: "never",
      promptTrustChoice: prompt,
    });
    expect(result).toEqual({ status: "denied", scope: "session" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("existing persisted decision is returned without calling prompt", async () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    store.set(directory, "deny");
    const prompt = vi.fn();
    const result = await resolveProjectTrust(directory, store, {
      defaultTrust: "ask",
      promptTrustChoice: prompt,
    });
    expect(result).toEqual({ status: "denied", scope: "persisted" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("no existing decision + defaultTrust 'ask' calls prompt and persists result", async () => {
    const opts = makeOptions();
    const store = createProjectTrustStore(opts);
    const prompt = vi.fn(async () => "trust" as const);
    const result = await resolveProjectTrust(directory, store, {
      defaultTrust: "ask",
      promptTrustChoice: prompt,
    });
    expect(prompt).toHaveBeenCalledWith(directory);
    expect(result).toEqual({ status: "trusted", scope: "persisted" });
    // Decision persisted — next get returns it
    expect(store.get(directory)).toEqual({ status: "trusted", scope: "persisted" });
  });
});

describe("assertProjectTrustedForRead", () => {
  it("does not throw when status is trusted", () => {
    const decision: TrustDecision = { status: "trusted", scope: "persisted" };
    expect(() => assertProjectTrustedForRead(decision, "/some/resource")).not.toThrow();
  });

  it("throws with resource path in message when status is denied", () => {
    const decision: TrustDecision = { status: "denied", scope: "session" };
    expect(() => assertProjectTrustedForRead(decision, "/path/to/resource"))
      .toThrow(/\/path\/to\/resource/);
  });

  it("throws when status is unknown", () => {
    const decision: TrustDecision = { status: "unknown" };
    expect(() => assertProjectTrustedForRead(decision, "/path/to/resource")).toThrow();
  });
});

describe("assertProjectTrustedForInstall", () => {
  it("does not throw when status is trusted", () => {
    const decision: TrustDecision = { status: "trusted", scope: "session" };
    expect(() => assertProjectTrustedForInstall(decision)).not.toThrow();
  });

  it("throws when status is denied", () => {
    const decision: TrustDecision = { status: "denied", scope: "persisted" };
    expect(() => assertProjectTrustedForInstall(decision)).toThrow(/not trusted/);
  });

  it("throws when status is unknown", () => {
    const decision: TrustDecision = { status: "unknown" };
    expect(() => assertProjectTrustedForInstall(decision)).toThrow();
  });
});
