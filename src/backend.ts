import { fileURLToPath } from "node:url";
import { AuthenticationRequiredError, CredentialRejectedError, DESKTOP_RPC_ENV } from "./auth.js";
import { dispatchCli, establishHomeWorkingDirectory } from "./cli.js";
import type { CliMode } from "./cli.js";
import { isCliEntryPoint } from "./cliEntryPoint.js";

export type BackendMode =
  | { readonly kind: "desktop" }
  | { readonly kind: "scheduler" }
  | { readonly kind: "dream" }
  | { readonly kind: "login" }
  | { readonly kind: "logout" };

export const BACKEND_USAGE = "Usage: private Railgun desktop backend <desktop|scheduler|dream|login|logout>";

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
  readonly dispatch?: (mode: CliMode) => Promise<void>;
  readonly establishHome?: () => void;
};

const cliMode = (mode: BackendMode): CliMode => {
  switch (mode.kind) {
    case "desktop": return { kind: "rpc" };
    case "scheduler": return { kind: "cron" };
    case "dream": return { kind: "dream" };
    case "login": return { kind: "login" };
    case "logout": return { kind: "logout" };
  }
};

const isBackgroundAuthenticationFailure = (error: unknown): boolean =>
  error instanceof AuthenticationRequiredError || error instanceof CredentialRejectedError;

export const runBackend = async (mode: BackendMode, dependencies: BackendDependencies = {}): Promise<void> => {
  const dispatch = dependencies.dispatch ?? dispatchCli;
  (dependencies.establishHome ?? establishHomeWorkingDirectory)();
  process.env[DESKTOP_RPC_ENV] = "1";
  try {
    await dispatch(cliMode(mode));
  } catch (error) {
    if ((mode.kind === "scheduler" || mode.kind === "dream") && isBackgroundAuthenticationFailure(error)) return;
    throw error;
  }
};

const isEntryPoint = isCliEntryPoint(process.argv[1], fileURLToPath(import.meta.url));
if (isEntryPoint) {
  runBackend(parseBackendArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
