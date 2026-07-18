#!/usr/bin/env node

import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [nodeBinary, backendEntrypoint, architecture] = process.argv.slice(2);

const fail = (message) => {
  throw new Error(`${architecture ?? "unknown"} packaged backend validation failed: ${message}`);
};

if (!nodeBinary || !backendEntrypoint || !architecture) {
  console.error(`usage: ${basename(process.argv[1])} NODE_BINARY BACKEND_ENTRYPOINT ARCHITECTURE`);
  process.exit(64);
}

const loaderPath = resolve(dirname(fileURLToPath(import.meta.url)), "backend-validation-loader.mjs");
const home = await mkdtemp(join(tmpdir(), `railgun-packaged-backend-${architecture}-`));
const activeChildren = new Set();
const timeoutMilliseconds = 10_000;
const diagnosticLimit = 32 * 1024;

const withTimeout = async (operation, description, milliseconds = timeoutMilliseconds) => {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const boundedAppend = (current, chunk) => `${current}${chunk}`.slice(-diagnosticLimit);

const launch = ({ useMockProvider }) => {
  const args = useMockProvider
    ? ["--experimental-loader", loaderPath, backendEntrypoint, "desktop"]
    : [backendEntrypoint, "desktop"];
  const child = spawn(nodeBinary, args, {
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      RAILGUN_DESKTOP_RPC: "1",
      ...(useMockProvider ? { DEVIN_TOKEN: "packaged-backend-validation-token" } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeChildren.add(child);

  let stderr = "";
  const jsonFrames = [];
  const frameWaiters = [];
  let lineBuffer = "";

  const dispatchFrame = (frame) => {
    jsonFrames.push(frame);
    for (const waiter of [...frameWaiters]) {
      if (waiter.predicate(frame)) {
        frameWaiters.splice(frameWaiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    let newline;
    while ((newline = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      try {
        dispatchFrame(JSON.parse(line));
      } catch {
        // Diagnostics are captured for errors; only JSONL protocol frames matter here.
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = boundedAppend(stderr, chunk); });

  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      resolveExit({ code, signal });
    });
  });

  const waitForFrame = (predicate, description) => {
    const existing = jsonFrames.find(predicate);
    if (existing) return Promise.resolve(existing);
    const waiter = {};
    const frame = new Promise((resolveFrame) => {
      Object.assign(waiter, { predicate, resolve: resolveFrame });
      frameWaiters.push(waiter);
    });
    return withTimeout(frame, description).finally(() => {
      const index = frameWaiters.indexOf(waiter);
      if (index >= 0) frameWaiters.splice(index, 1);
    });
  };

  return { child, exited, stderr: () => stderr, waitForFrame };
};

const writeFrame = (child, frame) => { child.stdin.write(`${JSON.stringify(frame)}\n`); };

const assertResponse = async (backend, id, command) => {
  const response = await backend.waitForFrame(
    (frame) => frame?.type === "response" && frame.id === id && frame.command === command,
    `${command} response`,
  );
  if (response.success !== true) fail(`${command} was rejected: ${String(response.error)}`);
  return response;
};

const startReadyBackend = async () => {
  const backend = launch({ useMockProvider: true });
  writeFrame(backend.child, { id: "initialize", type: "initialize", version: 1, clientName: "railgunx-validation" });
  const initialize = await assertResponse(backend, "initialize", "initialize");
  const capabilities = initialize.data?.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes("sessions")) {
    fail("initialize did not report the sessions capability");
  }

  writeFrame(backend.child, { id: "get-state", type: "get_state" });
  await assertResponse(backend, "get-state", "get_state");
  return backend;
};

try {
  const authenticationBackend = launch({ useMockProvider: false });
  const authenticationStatus = await authenticationBackend.waitForFrame(
    (frame) => frame?.type === "startup_status" && frame.status === "authentication_required",
    "authentication-required startup status",
  );
  if (authenticationStatus.credential_source !== "file") {
    fail("authentication startup did not identify the missing file credential");
  }
  const authenticationExit = await withTimeout(authenticationBackend.exited, "authentication backend exit");
  if (authenticationExit.code !== 1 || authenticationExit.signal !== null) {
    fail(`authentication startup exited unexpectedly: ${JSON.stringify(authenticationExit)}\n${authenticationBackend.stderr()}`);
  }

  const crashedBackend = await startReadyBackend();
  await access(join(home, ".railgun", "state.db"));
  if (!crashedBackend.child.kill("SIGKILL")) fail("unable to crash the ready backend");
  const crashExit = await withTimeout(crashedBackend.exited, "crashed backend exit");
  if (crashExit.signal !== "SIGKILL") {
    fail(`backend crash was not reported as SIGKILL: ${JSON.stringify(crashExit)}\n${crashedBackend.stderr()}`);
  }

  const restartedBackend = await startReadyBackend();
  restartedBackend.child.stdin.end();
  const shutdownExit = await withTimeout(restartedBackend.exited, "graceful backend shutdown");
  if (shutdownExit.code !== 0 || shutdownExit.signal !== null) {
    fail(`backend did not shut down cleanly: ${JSON.stringify(shutdownExit)}\n${restartedBackend.stderr()}`);
  }

  console.log(`validated packaged backend authentication, crash, restart, and shutdown for ${architecture}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
} finally {
  for (const child of activeChildren) child.kill("SIGKILL");
  await rm(home, { recursive: true, force: true });
}
