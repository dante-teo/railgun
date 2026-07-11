import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { AgentSessionEvent } from "../agent/agentSession.js";
import { serializeJsonLine, makeLineReader } from "./jsonl.js";
import type { RpcCommand } from "./types.js";

export interface RpcClientOptions {
  readonly cliPath?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export class RpcClient {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void }>();
  private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
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
          if (record["success"] === true) {
            pending.resolve(record["data"]);
          } else {
            pending.reject(new Error(typeof record["error"] === "string" ? record["error"] : "RPC error"));
          }
          return;
        }
      }
    }

    // Non-response lines are events
    for (const listener of this.eventListeners) {
      listener(obj as AgentSessionEvent);
    }
  }

  call(command: Omit<RpcCommand, "id">): Promise<unknown> {
    const id = String(this.nextId++);
    const full: RpcCommand = { ...command, id } as RpcCommand;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const stdin = this.child.stdin;
    if (stdin === null) {
      reject(new Error("RpcClient: child stdin is null"));
      return promise;
    }
    this.pending.set(id, { resolve, reject });
    stdin.write(serializeJsonLine(full));
    return promise;
  }

  onEvent(callback: (event: AgentSessionEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  stop(): void {
    this.cleanupLineReader();
    const stdin = this.child.stdin;
    if (stdin !== null) stdin.end();
    this.child.kill();
  }
}
