import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import type { BackendMode, BackendSnapshot, MockScenarioId, TransportLogEntry } from "../shared/types";
import type { DesktopDiagnosticSink } from "./desktopDiagnostics";

export interface BackendChild {
  readonly stdin: NodeJS.WritableStream & {
    on(event: "error", listener: (error: Error) => void): NodeJS.WritableStream;
  };
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type BackendChildFactory = (mode: BackendMode, scenarioId: MockScenarioId | undefined) => BackendChild;

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
  readonly initialScenarioId?: MockScenarioId;
  readonly readinessTimeoutMs?: number;
  readonly maxDiagnostics?: number;
  readonly maxTransportEntries?: number;
  readonly maxFrameLength?: number;
  readonly maxBufferLength?: number;
  readonly maxLogTextLength?: number;
  readonly terminationGraceMs?: number;
  readonly diagnosticSink?: DesktopDiagnosticSink;
}

export type BackendRpcCommand = Readonly<{ type: string; [key: string]: unknown }>;

const DESKTOP_RPC_VERSION = 1;
const REQUIRED_CAPABILITIES = ["sessions", "interaction.approval", "interaction.clarification", "session.delivery"] as const;
const DESKTOP_RPC_ENV = "RAILGUN_DESKTOP_RPC";

const appendBounded = <T>(values: readonly T[], value: T, limit: number): readonly T[] =>
  [...values, value].slice(-limit);

const SECRET_KEY = /(?:token|password|passwd|secret|authorization|api[_-]?key|credential)/i;
const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;

export const redactSensitiveText = (text: string): string => text
  .replace(/\b(Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
  .replace(/\b((?:DEVIN_TOKEN|[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*)[^\s,;]+/gi, "$1[REDACTED]")
  .replace(/(["']?(?:token|password|passwd|secret|authorization|api[_-]?key|credential)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[REDACTED]");

const errorMessage = (error: unknown): string => redactSensitiveText(error instanceof Error ? error.message : String(error));

const frameSummary = (value: Record<string, unknown>): string => {
  const fields = [
    typeof value.type === "string" ? `type=${value.type}` : "type=unknown",
    value.type === "response" && typeof value.command === "string" ? `command=${value.command}` : undefined,
    typeof value.id === "string" ? `id=${value.id}` : undefined,
    typeof value.status === "string" ? `status=${value.status}` : undefined,
    typeof value.success === "boolean" ? `success=${String(value.success)}` : undefined,
  ];
  return fields.filter((field): field is string => field !== undefined && !SECRET_KEY.test(field)).join(" ");
};

export class BackendSupervisor {
  readonly #spawnChild: BackendChildFactory;
  readonly #readinessTimeoutMs: number;
  readonly #maxDiagnostics: number;
  readonly #maxTransportEntries: number;
  readonly #maxFrameLength: number;
  readonly #maxBufferLength: number;
  readonly #maxLogTextLength: number;
  readonly #terminationGraceMs: number;
  readonly #diagnosticSink: DesktopDiagnosticSink | undefined;
  readonly #listeners = new Set<(snapshot: BackendSnapshot) => void>();
  readonly #backendEventListeners = new Set<(event: unknown) => void>();
  readonly #pendingCalls = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (error: Error) => void;
    validate: (data: unknown) => unknown;
    command: string;
  }>();
  #generation = 0;
  #nextCallId = 1;
  #child: BackendChild | undefined;
  #readinessTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #terminationTimers = new Map<BackendChild, ReturnType<typeof setTimeout>>();
  #snapshot: BackendSnapshot;

  constructor(options: BackendSupervisorOptions) {
    this.#spawnChild = options.spawnChild;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 15_000;
    this.#maxDiagnostics = options.maxDiagnostics ?? 20;
    this.#maxTransportEntries = options.maxTransportEntries ?? 80;
    this.#maxFrameLength = options.maxFrameLength ?? 4 * 1024 * 1024;
    this.#maxBufferLength = options.maxBufferLength ?? 8 * 1024 * 1024;
    this.#maxLogTextLength = options.maxLogTextLength ?? 2_000;
    this.#terminationGraceMs = options.terminationGraceMs ?? 1_000;
    this.#diagnosticSink = options.diagnosticSink;
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

  subscribeBackendEvents(listener: (event: unknown) => void): () => void {
    this.#backendEventListeners.add(listener);
    return () => this.#backendEventListeners.delete(listener);
  }

  call(command:
    | { readonly type: "prompt" | "steer" | "follow_up"; readonly message: string }
    | { readonly type: "abort" }
  ): Promise<void>;
  call<T>(command: BackendRpcCommand, validate: (data: unknown) => T): Promise<T>;
  call<T = void>(command: BackendRpcCommand, validate?: (data: unknown) => T): Promise<T> {
    const child = this.#child;
    if (child === undefined || this.#snapshot.phase !== "ready") {
      return Promise.reject(new Error("Backend is not ready"));
    }
    const id = `desktop-rpc-${this.#nextCallId++}`;
    return new Promise<T>((resolveCall, rejectCall) => {
      this.#pendingCalls.set(id, {
        resolve: data => resolveCall(data as T),
        reject: rejectCall,
        validate: validate ?? (data => {
          if (data !== undefined) throw new Error("Backend RPC returned unexpected response data");
          return undefined as T;
        }),
        command: command.type,
      });
      try {
        this.#write(child, JSON.stringify({ id, ...command }));
      } catch (error) {
        this.#pendingCalls.delete(id);
        const message = `Unable to write to backend: ${errorMessage(error)}`;
        this.#fail(this.#generation, message);
        rejectCall(new Error(message));
      }
    });
  }

  start(scenarioId = this.#snapshot.scenarioId): BackendSnapshot {
    const generation = ++this.#generation;
    this.#stopActiveChild();
    this.#snapshot = {
      mode: this.#snapshot.mode,
      phase: "starting",
      ...(scenarioId === undefined ? {} : { scenarioId }),
      diagnostics: [],
      transportLog: [this.#safeEntry("system", "Starting backend", "lifecycle")],
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

    child.stdin.on("error", (error) => {
      if (!this.#isCurrent(generation, child)) return;
      this.#fail(generation, `Backend stdin error: ${error.message}`);
    });

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (!this.#isCurrent(generation, child)) return;
      if (this.#authenticationRequired()) return;
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length > this.#maxFrameLength) {
          this.#fail(generation, "Backend JSONL frame exceeded the maximum size");
          return;
        }
        if (line.length > 0) this.#handleStdoutLine(generation, child, line);
        if (this.#authenticationRequired()) return;
        if (!this.#isCurrent(generation, child)) return;
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
      if (stdoutBuffer.length > this.#maxBufferLength) {
        this.#fail(generation, "Backend JSONL buffer exceeded the maximum size");
        stdoutBuffer = "";
        return;
      }
      if (stdoutBuffer.length > this.#maxFrameLength) {
        this.#fail(generation, "Backend JSONL frame exceeded the maximum size");
        stdoutBuffer = "";
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (!this.#isCurrent(generation, child)) return;
      const text = this.#safeText(chunk.toString().trim());
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
      this.#clearTerminationTimer(child);
      if (!this.#isCurrent(generation, child)) return;
      this.#child = undefined;
      this.#rejectPendingCalls(new Error("Backend exited"));
      this.#clearReadinessTimer();
      const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
      this.#snapshot = {
        ...this.#snapshot,
        phase: this.#snapshot.phase === "authentication-required"
          ? "authentication-required"
          : this.#snapshot.phase === "ready" ? "disconnected" : "failed",
        ...(this.#snapshot.phase === "authentication-required" ? {} : { error: `Backend exited with ${detail}` }),
        transportLog: appendBounded(
          this.#snapshot.transportLog,
          this.#safeEntry("system", `Backend exited with ${detail}`, "lifecycle"),
          this.#maxTransportEntries,
        ),
      };
      this.#emit();
    });

    const request = JSON.stringify({ id: `desktop-init-${generation}`, type: "initialize", version: DESKTOP_RPC_VERSION, clientName: "railgun-desktop" });
    try {
      this.#write(child, request);
    } catch (error) {
      this.#fail(generation, `Unable to write backend initialization request: ${errorMessage(error)}`);
      return this.#snapshot;
    }
    this.#readinessTimer = setTimeout(() => {
      this.#fail(generation, "Backend readiness probe timed out");
    }, this.#readinessTimeoutMs);
    return this.#snapshot;
  }

  restartWithScenario(scenarioId: MockScenarioId): BackendSnapshot {
    if (this.#snapshot.mode !== "mock") throw new Error("Mock scenarios are unavailable in real backend mode");
    return this.start(scenarioId);
  }

  restartBackend(): BackendSnapshot {
    return this.start();
  }

  stop(): BackendSnapshot {
    ++this.#generation;
    this.#clearReadinessTimer();
    this.#stopActiveChild();
    this.#snapshot = {
      ...this.#snapshot,
      phase: "disconnected",
      error: "Backend stopped",
      transportLog: appendBounded(this.#snapshot.transportLog, this.#safeEntry("system", "Backend stopped", "lifecycle"), this.#maxTransportEntries),
    };
    this.#emit();
    return this.#snapshot;
  }

  shutdown(): void {
    this.#snapshot = {
      ...this.#snapshot,
      transportLog: appendBounded(
        this.#snapshot.transportLog,
        this.#safeEntry("system", "Desktop supervisor shutting down", "lifecycle"),
        this.#maxTransportEntries,
      ),
    };
    this.#emit();
    ++this.#generation;
    this.#clearReadinessTimer();
    this.#stopActiveChild();
    this.#listeners.clear();
    this.#backendEventListeners.clear();
  }

  #handleStdoutLine(generation: number, child: BackendChild, line: string): void {
    if (this.#snapshot.phase === "authentication-required") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#appendTransport("stdout", "malformed JSONL frame");
      this.#fail(generation, "Backend emitted malformed JSONL output");
      return;
    }
    if (typeof message !== "object" || message === null) {
      this.#fail(generation, "Backend emitted a non-object JSONL frame");
      return;
    }
    const record = message as Record<string, unknown>;
    this.#appendTransport("stdout", frameSummary(record));
    if (
      this.#snapshot.phase === "starting"
      && record.type === "startup_status"
      && record.status === "authentication_required"
    ) {
      this.#clearReadinessTimer();
      this.#snapshot = {
        ...this.#snapshot,
        phase: "authentication-required",
        error: record.credential_source === "environment"
          ? "DEVIN_TOKEN was rejected. Remove or replace it in the launch environment, then relaunch Railgun Classic."
          : "Run `railgun login` in Terminal, then retry.",
      };
      this.#emit();
      return;
    }
    const initId = `desktop-init-${generation}`;
    const readyId = `desktop-ready-${generation}`;
    if (record.id === initId) {
      if (record.type !== "response" || record.command !== "initialize" || record.success !== true) {
        this.#fail(generation, typeof record.error === "string" ? `Backend protocol initialization failed: ${this.#safeText(record.error)}` : "Backend rejected protocol initialization");
        return;
      }
      const data = typeof record.data === "object" && record.data !== null ? record.data as Record<string, unknown> : undefined;
      const capabilities = Array.isArray(data?.capabilities) ? data.capabilities : [];
      if (data?.version !== DESKTOP_RPC_VERSION) {
        this.#fail(generation, `Backend protocol version mismatch: expected ${DESKTOP_RPC_VERSION}, received ${String(data?.version)}`);
        return;
      }
      const missing = REQUIRED_CAPABILITIES.filter(capability => !capabilities.includes(capability));
      if (missing.length > 0) {
        this.#fail(generation, `Backend is missing required capabilities: ${missing.join(", ")}`);
        return;
      }
      try {
        this.#write(child, JSON.stringify({ id: readyId, type: "get_state" }));
      } catch (error) {
        this.#fail(generation, `Unable to write backend readiness probe: ${errorMessage(error)}`);
      }
      return;
    }
    if (record.type === "response" && record.id !== readyId) {
      const id = typeof record.id === "string" ? record.id : undefined;
      const pending = id === undefined ? undefined : this.#pendingCalls.get(id);
      if (id !== undefined) this.#pendingCalls.delete(id);
      if (pending !== undefined) {
        if (record.command !== pending.command) {
          pending.reject(new Error(this.#safeText(
            `Invalid backend RPC response: expected command ${pending.command}, received ${String(record.command)}`,
          )));
          return;
        }
        if (record.success === true) {
          try { pending.resolve(pending.validate(record.data)); }
          catch (error) { pending.reject(new Error(this.#safeText(`Invalid backend RPC response: ${errorMessage(error)}`))); }
        } else pending.reject(new Error(typeof record.error === "string" ? this.#safeText(record.error) : "Backend RPC failed"));
      }
      return;
    }
    if (record.id !== readyId) {
      for (const listener of this.#backendEventListeners) listener(message);
      this.#emit();
      return;
    }
    if (record.type !== "response" || record.command !== "get_state" || record.success !== true) {
      this.#fail(
        generation,
        typeof record.error === "string" ? this.#safeText(record.error) : "Backend rejected the readiness probe",
      );
      return;
    }
    if (typeof record.data !== "object" || record.data === null || typeof (record.data as Record<string, unknown>).running !== "boolean") {
      this.#fail(generation, "Backend returned invalid session state");
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
        this.#safeEntry("stdin", this.#summarizeJsonLine(line)),
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
    const safeMessage = this.#safeText(message);
    this.#rejectPendingCalls(new Error(safeMessage));
    if (child !== undefined) this.#terminateChild(child);
    this.#snapshot = {
      ...this.#snapshot,
      phase: this.#snapshot.phase === "ready" ? "disconnected" : "failed",
      error: safeMessage,
      transportLog: appendBounded(
        this.#snapshot.transportLog,
        this.#safeEntry("system", safeMessage),
        this.#maxTransportEntries,
      ),
    };
    this.#emit();
  }

  #isCurrent(generation: number, child: BackendChild): boolean {
    return generation === this.#generation && child === this.#child;
  }

  #authenticationRequired(): boolean {
    return this.#snapshot.phase === "authentication-required";
  }

  #stopActiveChild(): void {
    this.#clearReadinessTimer();
    const child = this.#child;
    this.#child = undefined;
    this.#rejectPendingCalls(new Error("Backend stopped"));
    if (child !== undefined) this.#terminateChild(child);
  }

  #rejectPendingCalls(error: Error): void {
    for (const pending of this.#pendingCalls.values()) pending.reject(error);
    this.#pendingCalls.clear();
  }

  #clearReadinessTimer(): void {
    if (this.#readinessTimer !== undefined) clearTimeout(this.#readinessTimer);
    this.#readinessTimer = undefined;
  }

  #terminateChild(child: BackendChild): void {
    if (this.#terminationTimers.has(child)) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      this.#terminationTimers.delete(child);
      child.kill("SIGKILL");
    }, this.#terminationGraceMs);
    this.#terminationTimers.set(child, timer);
  }

  #clearTerminationTimer(child: BackendChild): void {
    const timer = this.#terminationTimers.get(child);
    if (timer !== undefined) clearTimeout(timer);
    this.#terminationTimers.delete(child);
  }

  #safeText(text: string): string {
    return truncate(redactSensitiveText(text), this.#maxLogTextLength);
  }

  #summarizeJsonLine(line: string): string {
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === "object" && value !== null
        ? this.#safeText(frameSummary(value as Record<string, unknown>))
        : "non-object JSONL frame";
    } catch {
      return "malformed JSONL frame";
    }
  }

  #appendTransport(direction: TransportLogEntry["direction"], text: string): void {
    this.#snapshot = {
      ...this.#snapshot,
      transportLog: appendBounded(
        this.#snapshot.transportLog,
        this.#safeEntry(direction, text),
        this.#maxTransportEntries,
      ),
    };
  }

  #safeEntry(direction: TransportLogEntry["direction"], text: string, category: "transport" | "lifecycle" = "transport"): TransportLogEntry {
    const entry = { direction, text: this.#safeText(text) };
    this.#diagnosticSink?.write({ category, ...entry });
    return entry;
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}

export const createBackendSpawnSpec = (
  runtime: BackendRuntime,
  mode: BackendMode,
  scenarioId?: MockScenarioId,
): BackendSpawnSpec => {
  if (runtime.kind === "development") {
    const entry = mode === "real"
      ? resolve(runtime.repositoryRoot, "src/backend.ts")
      : resolve(runtime.repositoryRoot, "apps/desktop/src/mock/backend.ts");
    return {
      command: "pnpm",
      args: mode === "real"
        ? ["exec", "tsx", entry, "desktop"]
        : ["exec", "tsx", entry, scenarioId ?? "ready-idle"],
      cwd: runtime.repositoryRoot,
      env: mode === "real" ? { ...process.env, [DESKTOP_RPC_ENV]: "1" } : process.env,
    };
  }

  const entry = mode === "real"
    ? resolve(runtime.resourcesPath, "backend/railgun/dist/backend.js")
    : resolve(runtime.resourcesPath, "backend/mock-backend.cjs");
  return {
    command: runtime.executablePath,
    args: mode === "real" ? [entry, "desktop"] : [entry, scenarioId ?? "ready-idle"],
    cwd: runtime.workingDirectory,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(mode === "real" ? { [DESKTOP_RPC_ENV]: "1" } : {}),
    },
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
