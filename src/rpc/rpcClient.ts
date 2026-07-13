import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AgentSessionEvent } from "../agent/agentSession.js";
import { serializeJsonLine, makeLineReader } from "./jsonl.js";
import { RPC_PROTOCOL_VERSION } from "./types.js";
import type { RpcApprovalRequest, RpcClarificationRequest, RpcCommand, RpcInitializeResult } from "./types.js";

export interface RpcClientOptions {
  readonly cliPath?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RpcCommandInput = DistributiveOmit<RpcCommand, "id">;

export class RpcClient {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<string, { command: string; resolve: (data: unknown) => void; reject: (err: Error) => void }>();
  private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly approvalListeners = new Set<(request: RpcApprovalRequest) => void>();
  private readonly clarificationListeners = new Set<(request: RpcClarificationRequest) => void>();
  private readonly cleanupLineReader: () => void;

  constructor(options: RpcClientOptions = {}) {
    const cliPath = options.cliPath ?? "node";
    const extraArgs = options.args ?? ["dist/cli.js"];
    const child = spawn(cliPath, [...extraArgs, "--mode", "rpc"], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;

    const stdout = child.stdout;
    if (stdout === null) throw new Error("RpcClient: child stdout is null");

    this.cleanupLineReader = makeLineReader(stdout, line => this.handleLine(line));
    child.on("exit", () => this.rejectPending("RPC backend exited"));
    child.on("error", error => this.rejectPending(error instanceof Error ? error.message : "RPC backend failed"));
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    if (
      typeof obj !== "object" ||
      obj === null
    ) {
      return;
    }

    const record = obj as Record<string, unknown>;
    if (record["type"] === "response") {
      const id = typeof record["id"] === "string" ? record["id"] : undefined;
      if (id !== undefined) {
        const pending = this.pending.get(id);
        if (pending !== undefined) {
          this.pending.delete(id);
          if (record["command"] !== pending.command) {
            pending.reject(new Error(`RPC response command mismatch: expected ${pending.command}, received ${String(record["command"])}`));
            return;
          }
          if (record["success"] === true) {
            pending.resolve(record["data"]);
          } else {
            pending.reject(new Error(typeof record["error"] === "string" ? record["error"] : "RPC error"));
          }
          return;
        }
      }
    }

    if (record["type"] === "approval_request" && typeof record["requestId"] === "string" && typeof record["command"] === "string") {
      for (const listener of this.approvalListeners) listener(obj as RpcApprovalRequest);
      return;
    }
    if (record["type"] === "clarification_request" && typeof record["requestId"] === "string" && typeof record["question"] === "string" &&
        (record["choices"] === undefined || (Array.isArray(record["choices"]) && record["choices"].every(choice => typeof choice === "string")))) {
      for (const listener of this.clarificationListeners) listener(obj as RpcClarificationRequest);
      return;
    }

    // Non-response lines are events
    for (const listener of this.eventListeners) {
      listener(obj as AgentSessionEvent);
    }
  }

  call<T = unknown>(command: RpcCommandInput): Promise<T> {
    const id = String(this.nextId++);
    const full: RpcCommand = { ...command, id } as RpcCommand;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const stdin = this.child.stdin;
    if (stdin === null) {
      reject(new Error("RpcClient: child stdin is null"));
      return promise as Promise<T>;
    }
    this.pending.set(id, { command: command.type, resolve, reject });
    stdin.write(serializeJsonLine(full));
    return promise as Promise<T>;
  }

  initialize(clientName?: string): Promise<RpcInitializeResult> {
    return this.call<RpcInitializeResult>({ type: "initialize", version: RPC_PROTOCOL_VERSION, ...(clientName === undefined ? {} : { clientName }) });
  }

  onEvent(callback: (event: AgentSessionEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  onApprovalRequest(callback: (request: RpcApprovalRequest) => void): () => void {
    this.approvalListeners.add(callback);
    return () => this.approvalListeners.delete(callback);
  }

  onClarificationRequest(callback: (request: RpcClarificationRequest) => void): () => void {
    this.clarificationListeners.add(callback);
    return () => this.clarificationListeners.delete(callback);
  }

  stop(): void {
    this.cleanupLineReader();
    this.rejectPending("RpcClient stopped");
    const stdin = this.child.stdin;
    if (stdin !== null) stdin.end();
    this.child.kill();
  }
}
