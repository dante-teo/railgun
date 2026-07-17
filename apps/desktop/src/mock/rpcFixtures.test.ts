import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getMockScenario } from "./scenarios";
import { createLineReader } from "./testLineReader";

interface FixtureOutputChunk {
  readonly file: string;
  readonly delayMilliseconds: number;
}

interface FixtureStep {
  readonly requestFile: string;
  readonly outputs: readonly FixtureOutputChunk[];
  readonly terminalState: "open" | "eof";
}

interface FixtureManifest {
  readonly version: number;
  readonly scenarios: readonly {
    readonly id: string;
    readonly steps: readonly FixtureStep[];
  }[];
}

const fixtureRoot = new URL("../../../../fixtures/rpc/v1/", import.meta.url);
const loadManifest = async (): Promise<FixtureManifest> =>
  JSON.parse(await readFile(new URL("manifest.json", fixtureRoot), "utf8")) as FixtureManifest;

const readFixture = (path: string): Promise<string> => readFile(new URL(path, fixtureRoot), "utf8");
const entry = fileURLToPath(new URL("./backend.ts", import.meta.url));

const startMock = (scenario: string): ChildProcessWithoutNullStreams =>
  spawn(process.execPath, ["--import", "tsx", entry, scenario], { stdio: ["pipe", "pipe", "pipe"] });

const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise(resolve => child.once("exit", resolve));

const expectedOutput = async (step: FixtureStep): Promise<string> =>
  (await Promise.all(step.outputs.map(({ file }) => readFixture(file)))).join("");

const sendStep = async (
  child: ChildProcessWithoutNullStreams,
  nextLine: () => Promise<{ readonly line: string }>,
  step: FixtureStep,
): Promise<void> => {
  child.stdin.write(await readFixture(step.requestFile));
  expect(`${(await nextLine()).line}\n`).toBe(await expectedOutput(step));
};

describe("shared RPC fixture contract", () => {
  it("keeps the ready handshake aligned with the desktop mock backend", async () => {
    const manifest = await loadManifest();
    const scenario = manifest.scenarios.find(({ id }) => id === "initialize-success");
    if (scenario === undefined) throw new Error("Missing initialize-success fixture");

    expect(manifest.version).toBe(1);
    expect(getMockScenario("ready-idle").behavior).toBe("ready");
    const child = startMock("ready-idle");
    const nextLine = createLineReader(child.stdout);
    try {
      await sendStep(child, nextLine, scenario.steps[0]!);
    } finally {
      child.kill();
    }
  });

  it("keeps the rejected-command response correlated", async () => {
    const manifest = await loadManifest();
    const scenario = manifest.scenarios.find(({ id }) => id === "command-rejected");
    if (scenario === undefined) throw new Error("Missing command-rejected fixture");

    expect(getMockScenario("command-rejection").behavior).toBe("reject-commands");
    const child = startMock("command-rejection");
    const nextLine = createLineReader(child.stdout);
    try {
      await sendStep(child, nextLine, scenario.steps[0]!);
      await sendStep(child, nextLine, scenario.steps[1]!);
    } finally {
      child.kill();
    }
  });

  it("disconnects only after the ready-state response", async () => {
    const manifest = await loadManifest();
    const scenario = manifest.scenarios.find(({ id }) => id === "eof-after-initialize");
    if (scenario === undefined) throw new Error("Missing eof-after-initialize fixture");

    expect(getMockScenario("disconnect-after-ready").behavior).toBe("disconnect-after-ready");
    expect(scenario.steps.map(({ terminalState }) => terminalState)).toEqual(["open", "eof"]);
    const child = startMock("disconnect-after-ready");
    const nextLine = createLineReader(child.stdout);
    try {
      await sendStep(child, nextLine, scenario.steps[0]!);
      await sendStep(child, nextLine, scenario.steps[1]!);
      expect(await waitForExit(child)).toBe(23);
    } finally {
      child.kill();
    }
  });
});
