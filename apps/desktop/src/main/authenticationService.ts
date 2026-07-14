import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { BackendRuntime } from "./backendSupervisor";
import type { MutationQueue } from "./mutationQueue";

export interface AuthenticationHelperSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export const createAuthenticationHelperSpec = (
  runtime: BackendRuntime,
  action: "login" | "logout",
): AuthenticationHelperSpec => {
  if (runtime.kind === "development") return {
    command: "pnpm",
    args: ["exec", "tsx", resolve(runtime.repositoryRoot, "src/cli.ts"), action],
    cwd: runtime.repositoryRoot,
    env: { ...process.env, RAILGUN_DESKTOP_RPC: undefined },
  };
  return {
    command: runtime.executablePath,
    args: [resolve(runtime.resourcesPath, "backend/railgun/dist/cli.js"), action],
    cwd: runtime.workingDirectory,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", RAILGUN_DESKTOP_RPC: undefined },
  };
};

type RunHelper = (spec: AuthenticationHelperSpec) => Promise<void>;

const createHelperRunner = () => {
  const children = new Set<ReturnType<typeof spawn>>();
  const run: RunHelper = spec => new Promise((resolveRun, rejectRun) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    // Helper output can contain OAuth details and intentionally never crosses IPC.
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", (error) => { children.delete(child); rejectRun(error); });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (code === 0) resolveRun();
      else rejectRun(new Error(signal === null ? `Authentication helper exited with code ${String(code)}` : `Authentication helper exited with signal ${signal}`));
    });
  });
  const shutdown = (): void => {
    for (const child of children) child.kill("SIGTERM");
    children.clear();
  };
  return { run, shutdown };
};

export const createAuthenticationService = (
  runtime: BackendRuntime,
  restartBackend: (action: "login" | "logout") => void | Promise<void>,
  run?: RunHelper,
) => {
  const helperRunner = createHelperRunner();
  const execute = run ?? helperRunner.run;
  let active: Promise<void> | undefined;
  const perform = (action: "login" | "logout"): Promise<void> => {
    if (active !== undefined) return Promise.reject(new Error("Another authentication operation is already in progress"));
    const operation = execute(createAuthenticationHelperSpec(runtime, action)).then(() => restartBackend(action));
    active = operation.finally(() => { active = undefined; });
    return active;
  };
  return { signIn: () => perform("login"), signOut: () => perform("logout"), shutdown: helperRunner.shutdown };
};

interface AuthenticationCoordinatorOptions<T> {
  readonly mutations: MutationQueue;
  readonly isAgentRunning: () => Promise<boolean>;
  readonly signIn: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly snapshot: () => Promise<T>;
}

export const createAuthenticationCoordinator = <T,>(options: AuthenticationCoordinatorOptions<T>) => {
  let busy = false;
  const assertTaskMutationAllowed = (): void => {
    if (busy) throw new Error("Tasks cannot change while authentication is in progress");
  };
  const mutate = async (action: "login" | "logout"): Promise<T> => {
    if (busy) throw new Error("Another authentication operation is already in progress");
    busy = true;
    try {
      return await options.mutations.run(async () => {
        if (await options.isAgentRunning()) throw new Error("Authentication cannot change while the agent is running");
        if (action === "login") await options.signIn();
        else await options.signOut();
        return options.snapshot();
      });
    } finally {
      busy = false;
    }
  };
  return { assertTaskMutationAllowed, mutate };
};
