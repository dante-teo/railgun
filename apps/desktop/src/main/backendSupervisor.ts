import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type { BackendMode, BackendSnapshot, TransportLogEntry } from "../shared/types";

export interface BackendChild {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type BackendChildFactory = (mode: BackendMode, scenarioId: string | undefined) => BackendChild;

export type BackendRuntime =
  | {
    readonly kind: "development";
    readonly repositoryRoot: string;
  }
  | {
    readonly kind: "packaged";
    readonly resourcesPath: string;
    readonly executablePath: string;
    readonly workingDirectory: string;
  };

export interface BackendSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface BackendSupervisorOptions {
  readonly mode: BackendMode;
  readonly spawnChild: BackendChildFactory;
  readonly initialScenarioId?: string;
  readonly readinessTimeoutMs?: number;
  readonly maxDiagnostics?: number;
  readonly maxTransportEntries?: number;
}

const appendBounded = <T>(values: readonly T[], value: T, limit: number): readonly T[] =>
  [...values, value].slice(-limit);

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class BackendSupervisor {
  readonly #spawnChild: BackendChildFactory;
  readonly #readinessTimeoutMs: number;
  readonly #maxDiagnostics: number;
  readonly #maxTransportEntries: number;
  readonly #listeners = new Set<(snapshot: BackendSnapshot) => void>();
  #generation = 0;
  #child: BackendChild | undefined;
  #readinessTimer: ReturnType<typeof setTimeout> | undefined;
  #snapshot: BackendSnapshot;

  constructor(options: BackendSupervisorOptions) {
    this.#spawnChild = options.spawnChild;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
    this.#maxDiagnostics = options.maxDiagnostics ?? 20;
    this.#maxTransportEntries = options.maxTransportEntries ?? 80;
    this.#snapshot = {
      mode: options.mode,
      phase: "starting",
      ...(options.initialScenarioId === undefined ? {} : { scenarioId: options.initialScenarioId }),
      diagnostics: [],
      transportLog: [],
    };
  }

  getSnapshot(): BackendSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: BackendSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(scenarioId = this.#snapshot.scenarioId): BackendSnapshot {
    const generation = ++this.#generation;
    this.#stopActiveChild();
    this.#snapshot = {
      mode: this.#snapshot.mode,
      phase: "starting",
      ...(scenarioId === undefined ? {} : { scenarioId }),
      diagnostics: [],
      transportLog: [{ direction: "system", text: "Starting backend" }],
    };
    this.#emit();

    let child: BackendChild;
    try {
      child = this.#spawnChild(this.#snapshot.mode, scenarioId);
    } catch (error) {
      this.#fail(generation, `Unable to start backend: ${errorMessage(error)}`);
      return this.#snapshot;
    }
    this.#child = child;

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!this.#isCurrent(generation, child)) return;
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > 0) this.#handleStdoutLine(generation, child, line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!this.#isCurrent(generation, child)) return;
      const text = chunk.toString().trim();
      if (text.length === 0) return;
      this.#snapshot = {
        ...this.#snapshot,
        diagnostics: appendBounded(this.#snapshot.diagnostics, text, this.#maxDiagnostics),
        transportLog: appendBounded(
          this.#snapshot.transportLog,
          { direction: "stderr", text },
          this.#maxTransportEntries,
        ),
      };
      this.#emit();
    });
    child.once("error", (error) => {
      if (!this.#isCurrent(generation, child)) return;
      this.#fail(generation, `Backend process error: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      if (!this.#isCurrent(generation, child)) return;
      this.#child = undefined;
      this.#clearReadinessTimer();
      const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      this.#snapshot = {
        ...this.#snapshot,
        phase: this.#snapshot.phase === "ready" ? "disconnected" : "failed",
        error: `Backend exited with ${detail}`,
        transportLog: appendBounded(
          this.#snapshot.transportLog,
          { direction: "system", text: `Backend exited with ${detail}` },
          this.#maxTransportEntries,
        ),
      };
      this.#emit();
    });

    const request = JSON.stringify({ id: `desktop-ready-${generation}`, type: "get_state" });
    this.#write(child, request);
    this.#readinessTimer = setTimeout(() => {
      this.#fail(generation, "Backend readiness probe timed out");
    }, this.#readinessTimeoutMs);
    return this.#snapshot;
  }

  restartWithScenario(scenarioId: string): BackendSnapshot {
    if (this.#snapshot.mode !== "mock") throw new Error("Mock scenarios are unavailable in real backend mode");
    return this.start(scenarioId);
  }

  shutdown(): void {
    ++this.#generation;
    this.#clearReadinessTimer();
    this.#stopActiveChild();
    this.#listeners.clear();
  }

  #handleStdoutLine(generation: number, child: BackendChild, line: string): void {
    this.#snapshot = {
      ...this.#snapshot,
      transportLog: appendBounded(
        this.#snapshot.transportLog,
        { direction: "stdout", text: line },
        this.#maxTransportEntries,
      ),
    };
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fail(generation, "Backend emitted malformed JSONL output");
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.#fail(generation, "Backend emitted a non-object JSONL frame");
      return;
    }
    const record = message as Record<string, unknown>;
    if (record.id !== `desktop-ready-${generation}`) {
      this.#emit();
      return;
    }
    if (record.type !== "response" || record.command !== "get_state" || record.success !== true) {
      this.#fail(
        generation,
        typeof record.error === "string" ? record.error : "Backend rejected the readiness probe",
      );
      return;
    }
    if (!this.#isCurrent(generation, child)) return;
    this.#clearReadinessTimer();
    const { error: _error, ...snapshot } = this.#snapshot;
    this.#snapshot = { ...snapshot, phase: "ready" };
    this.#emit();
  }

  #write(child: BackendChild, line: string): void {
    const text = `${line}\n`;
    child.stdin.write(text);
    this.#snapshot = {
      ...this.#snapshot,
      transportLog: appendBounded(
        this.#snapshot.transportLog,
        { direction: "stdin", text: line },
        this.#maxTransportEntries,
      ),
    };
    this.#emit();
  }

  #fail(generation: number, message: string): void {
    if (generation !== this.#generation) return;
    this.#clearReadinessTimer();
    const child = this.#child;
    this.#child = undefined;
    child?.kill("SIGTERM");
    this.#snapshot = {
      ...this.#snapshot,
      phase: "failed",
      error: message,
      transportLog: appendBounded(
        this.#snapshot.transportLog,
        { direction: "system", text: message },
        this.#maxTransportEntries,
      ),
    };
    this.#emit();
  }

  #isCurrent(generation: number, child: BackendChild): boolean {
    return generation === this.#generation && child === this.#child;
  }

  #stopActiveChild(): void {
    this.#clearReadinessTimer();
    const child = this.#child;
    this.#child = undefined;
    child?.kill("SIGTERM");
  }

  #clearReadinessTimer(): void {
    if (this.#readinessTimer !== undefined) clearTimeout(this.#readinessTimer);
    this.#readinessTimer = undefined;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

export const createBackendSpawnSpec = (
  runtime: BackendRuntime,
  mode: BackendMode,
  scenarioId?: string,
): BackendSpawnSpec => {
  if (runtime.kind === "development") {
    const entry = mode === "real"
      ? resolve(runtime.repositoryRoot, "src/cli.ts")
      : resolve(runtime.repositoryRoot, "apps/desktop/src/mock/backend.ts");
    return {
      command: "pnpm",
      args: mode === "real"
        ? ["exec", "tsx", entry, "--mode", "rpc"]
        : ["exec", "tsx", entry, scenarioId ?? "ready-idle"],
      cwd: runtime.repositoryRoot,
      env: process.env,
    };
  }

  const entry = mode === "real"
    ? resolve(runtime.resourcesPath, "backend/railgun/dist/cli.js")
    : resolve(runtime.resourcesPath, "backend/mock-backend.cjs");
  return {
    command: runtime.executablePath,
    args: mode === "real" ? [entry, "--mode", "rpc"] : [entry, scenarioId ?? "ready-idle"],
    cwd: runtime.workingDirectory,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  };
};

export const createBackendChildFactory = (runtime: BackendRuntime): BackendChildFactory =>
  (mode, scenarioId): ChildProcessWithoutNullStreams => {
    const spec = createBackendSpawnSpec(runtime, mode, scenarioId);
    return spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
