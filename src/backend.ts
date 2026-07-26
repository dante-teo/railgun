import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { AuthenticationRequiredError, CredentialRejectedError, DESKTOP_RPC_ENV, runLoginCommand, runLogoutCommand } from "./auth.js";
import { loadConfig, updateConfig } from "./config.js";
import { createExtensionAPI, loadExtensions, registerExtensionTools } from "./extensions/loader.js";
import { createMcpExtension, parseMcpServers } from "./extensions/mcp/index.js";
import { createExtensionRunner } from "./extensions/runner.js";
import type { ExtensionRunner } from "./extensions/runner.js";
import { createMemoryStore, formatMemoriesForPrompt } from "./persistence/memoryStore.js";
import { createSessionStore } from "./persistence/sessionStore.js";
import { runRpcMode } from "./rpc/rpcMode.js";
import { initDevinSession, initFreshDevinSession, RequestedModelUnavailableError } from "./session.js";
import { startScheduler } from "./cron/scheduler.js";
import { runDreamSession } from "./dream/dreamJob.js";
import { loadJobs, saveJobs } from "./cron/jobs.js";
import { loadSkills } from "./skills.js";
import { registry } from "./tools/index.js";
import { isEntryPoint } from "./entryPoint.js";

export type BackendMode =
  | { readonly kind: "desktop" }
  | { readonly kind: "scheduler" }
  | { readonly kind: "dream" }
  | { readonly kind: "login" }
  | { readonly kind: "logout" };

export const BACKEND_USAGE = "Usage: private Railgun backend <desktop|scheduler|dream|login|logout>";

export const parseBackendArgs = (args: readonly string[]): BackendMode => {
  if (args.length !== 1) throw new Error(BACKEND_USAGE);
  switch (args[0]) {
    case "desktop": return { kind: "desktop" };
    case "scheduler": return { kind: "scheduler" };
    case "dream": return { kind: "dream" };
    case "login": return { kind: "login" };
    case "logout": return { kind: "logout" };
    default: throw new Error(BACKEND_USAGE);
  }
};

type BackendDependencies = {
  readonly runDesktop?: () => Promise<void>;
  readonly runScheduler?: () => Promise<void>;
  readonly runDream?: () => Promise<void>;
  readonly runLogin?: () => Promise<void>;
  readonly runLogout?: () => Promise<void>;
  readonly establishHome?: () => void;
};

const withStore = async <T>(run: (store: ReturnType<typeof createSessionStore>) => Promise<T>): Promise<T> => {
  const store = createSessionStore();
  try {
    return await run(store);
  } finally {
    store.close();
  }
};

const withStores = async <T>(
  run: (
    store: ReturnType<typeof createSessionStore>,
    memoryStore: ReturnType<typeof createMemoryStore>,
  ) => Promise<T>,
): Promise<T> =>
  withStore(store => run(store, createMemoryStore(store.db)));

const bootstrapExtensions = async (sessionId: string, config: Awaited<ReturnType<typeof loadConfig>>): Promise<{
  runner: ExtensionRunner;
  cleanup: () => void;
}> => {
  const runner = createExtensionRunner();
  runner.onExtensionError(error => {
    console.error("[extension error]", error.extension, error.event, error.error);
  });
  await loadExtensions(runner, { homeDir: homedir() });

  let cleanup = (): void => {};
  const mcpServers = parseMcpServers(config.mcpServers);
  if (Object.keys(mcpServers).length > 0) {
    const handle = await createMcpExtension(mcpServers)(createExtensionAPI(runner, "mcp"));
    cleanup = handle.close;
  }
  registerExtensionTools(runner, registry, sessionId);
  return { runner, cleanup };
};

const runDesktopBackend = async (): Promise<void> => {
  const config = await loadConfig();
  const session = await initDevinSession(config.model ?? undefined, undefined, "desktop")
    .catch(error => error instanceof RequestedModelUnavailableError
      ? initDevinSession(undefined, undefined, "desktop")
      : Promise.reject(error));
  const { runner, cleanup } = await bootstrapExtensions("desktop", config);
  try {
    await withStores(async (sessionStore, memoryStore) => {
      await runner.emitSessionStart({ type: "session_start", reason: "new" });
      await runRpcMode({
        session,
        config,
        stdin: process.stdin,
        stdout: process.stdout,
        extensionRunner: runner,
        sessionStore,
        memoryStore,
        updateConfig: transform => updateConfig(transform),
        loadJobs: () => loadJobs(),
        saveJobs: jobs => saveJobs(jobs),
        loadSkills,
        randomId: randomUUID,
        now: () => new Date(),
      });
      await runner.emitSessionShutdown({ type: "session_shutdown", reason: "exit" });
    });
  } finally {
    cleanup();
  }
};

const runSchedulerBackend = async (): Promise<void> => {
  const session = await initFreshDevinSession({ surface: "cron" });
  if (session === undefined) return;
  const config = await loadConfig();
  const controller = new AbortController();
  const onSignal = (): void => { controller.abort(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await withStore(store =>
      startScheduler(session.devin, session.model, session.systemPrompt, config, { signal: controller.signal, sessionStore: store }));
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
};

const runDreamBackend = async (): Promise<void> => {
  const session = await initDevinSession(undefined, undefined, "cron");
  const config = await loadConfig();
  await withStores(async (store, memoryStore) => {
    try {
      await runDreamSession(memoryStore, session.devin, session.model);
    } finally {
      store.pruneArchivedSessions(config.archiveRetentionDays ?? 7);
    }
  });
};

const isBackgroundAuthenticationFailure = (error: unknown): boolean =>
  error instanceof AuthenticationRequiredError || error instanceof CredentialRejectedError;

/// The private backend entry point owns desktop RPC startup. Preserve its
/// machine-readable authentication signal so the native app can distinguish it
/// from an ordinary backend exit.
export const backendAuthenticationRequiredFrame = (
  mode: BackendMode,
  error: unknown,
): string | undefined => {
  if (mode.kind !== "desktop") return undefined;
  const credentialSource = error instanceof CredentialRejectedError
    ? error.source
    : error instanceof AuthenticationRequiredError ? "file" : undefined;
  return credentialSource === undefined ? undefined : JSON.stringify({
    type: "startup_status",
    status: "authentication_required",
    credential_source: credentialSource,
  });
};

export const runBackend = async (mode: BackendMode, dependencies: BackendDependencies = {}): Promise<void> => {
  (dependencies.establishHome ?? (() => process.chdir(homedir())))();
  process.env[DESKTOP_RPC_ENV] = "1";
  const operations = {
    desktop: dependencies.runDesktop ?? runDesktopBackend,
    scheduler: dependencies.runScheduler ?? runSchedulerBackend,
    dream: dependencies.runDream ?? runDreamBackend,
    login: dependencies.runLogin ?? runLoginCommand,
    logout: dependencies.runLogout ?? runLogoutCommand,
  };
  try {
    await operations[mode.kind]();
  } catch (error) {
    if ((mode.kind === "scheduler" || mode.kind === "dream") && isBackgroundAuthenticationFailure(error)) return;
    throw error;
  }
};

if (isEntryPoint(process.argv[1], fileURLToPath(import.meta.url))) {
  const mode = parseBackendArgs(process.argv.slice(2));
  runBackend(mode).catch((error: unknown) => {
    const startupFrame = backendAuthenticationRequiredFrame(mode, error);
    if (startupFrame !== undefined) {
      console.log(startupFrame);
      process.exitCode = 1;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
