import {
  DevinApiError,
  createDevinProvider,
  createFileTokenStore,
  createMemoryTokenStore,
} from "widevin";
import type { DevinProvider, TokenStore } from "widevin";
import { openUrlInBrowser } from "./openBrowser.js";
import { TOKEN_PATH } from "./sessionPath.js";

export type CredentialSource = "environment" | "file";

export const DESKTOP_RPC_ENV = "RAILGUN_DESKTOP_RPC";

export class AuthenticationRequiredError extends Error {
  readonly name = "AuthenticationRequiredError";

  constructor() {
    super("Devin authentication is required.");
  }
}

export class CredentialRejectedError extends Error {
  readonly name = "CredentialRejectedError";

  constructor(
    readonly source: CredentialSource,
    readonly rejection: DevinApiError,
    readonly removalFailure?: unknown,
  ) {
    super(`Devin rejected the ${source} credential with HTTP ${rejection.status}.`, { cause: rejection });
  }
}

export class LoginVerificationError extends Error {
  readonly name = "LoginVerificationError";

  constructor(readonly verificationFailure: unknown) {
    super("Devin credentials were saved, but verification failed.", { cause: verificationFailure });
  }
}

type ProviderFactory = (tokenStore: TokenStore) => DevinProvider;

export interface AuthenticationOptions {
  readonly environmentToken?: string;
  readonly fileStore?: TokenStore;
  readonly createMemoryStore?: (token: string) => TokenStore;
  readonly createProvider?: ProviderFactory;
  readonly desktopRpc?: boolean;
}

export interface AuthenticatedProvider {
  readonly devin: DevinProvider;
  readonly source: CredentialSource;
}

const defaultProviderFactory: ProviderFactory = tokenStore =>
  createDevinProvider({ tokenStore, openBrowser: openUrlInBrowser });

const usableEnvironmentToken = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

const rejectCredential = async (
  source: CredentialSource,
  fileStore: TokenStore,
  rejection: DevinApiError,
): Promise<never> => {
  const removalFailure = source === "file"
    ? await fileStore.clear().then(() => undefined, (error: unknown) => error)
    : undefined;
  throw new CredentialRejectedError(source, rejection, removalFailure);
};

const isUnauthorized = (error: unknown): error is DevinApiError =>
  error instanceof DevinApiError && error.status === 401;

const credentialAwareProvider = (
  devin: DevinProvider,
  source: CredentialSource,
  fileStore: TokenStore,
): DevinProvider => ({
  login: devin.login,
  setToken: devin.setToken,
  clearToken: devin.clearToken,
  listModels: async () => {
    try {
      return await devin.listModels();
    } catch (error) {
      if (isUnauthorized(error)) return rejectCredential(source, fileStore, error);
      throw error;
    }
  },
  streamChat: async function* (request) {
    try {
      yield* devin.streamChat(request);
    } catch (error) {
      if (isUnauthorized(error)) await rejectCredential(source, fileStore, error);
      throw error;
    }
  },
});

export const createAuthenticatedProvider = async (
  options: AuthenticationOptions = {},
): Promise<AuthenticatedProvider> => {
  const fileStore = options.fileStore ?? createFileTokenStore(TOKEN_PATH);
  const createProvider = options.createProvider ?? defaultProviderFactory;
  const environmentToken = usableEnvironmentToken(options.environmentToken ?? process.env.DEVIN_TOKEN);
  const desktopRpc = options.desktopRpc ?? process.env[DESKTOP_RPC_ENV] === "1";

  if (environmentToken !== undefined) {
    const memoryStore = (options.createMemoryStore ?? createMemoryTokenStore)(environmentToken);
    return {
      source: "environment",
      devin: credentialAwareProvider(createProvider(memoryStore), "environment", fileStore),
    };
  }

  const devin = createProvider(fileStore);
  if (!(await fileStore.get())) {
    if (desktopRpc) throw new AuthenticationRequiredError();
    await devin.login();
  }
  return { source: "file", devin: credentialAwareProvider(devin, "file", fileStore) };
};

interface AuthCommandOptions {
  readonly environmentToken?: string;
  readonly fileStore?: TokenStore;
  readonly createProvider?: ProviderFactory;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

const environmentOverridesCache = (value: string | undefined): boolean =>
  usableEnvironmentToken(value ?? process.env.DEVIN_TOKEN) !== undefined;

const warnIfEnvironmentOverridesCache = (
  environmentToken: string | undefined,
  stderr: (line: string) => void,
): void => {
  if (environmentOverridesCache(environmentToken)) {
    stderr("Warning: DEVIN_TOKEN is set and will override the newly cached credential.");
  }
};

export const runLoginCommand = async (options: AuthCommandOptions = {}): Promise<void> => {
  const fileStore = options.fileStore ?? createFileTokenStore(TOKEN_PATH);
  const devin = (options.createProvider ?? defaultProviderFactory)(fileStore);
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;

  await devin.login();
  try {
    await devin.listModels();
  } catch (error) {
    if (isUnauthorized(error)) await rejectCredential("file", fileStore, error);
    warnIfEnvironmentOverridesCache(options.environmentToken, stderr);
    throw new LoginVerificationError(error);
  }

  stdout("Devin credentials saved and verified.");
  warnIfEnvironmentOverridesCache(options.environmentToken, stderr);
};

export const runLogoutCommand = async (options: AuthCommandOptions = {}): Promise<void> => {
  const fileStore = options.fileStore ?? createFileTokenStore(TOKEN_PATH);
  await fileStore.clear();
  (options.stdout ?? console.log)("Cached Devin credentials removed.");
  if (environmentOverridesCache(options.environmentToken)) {
    (options.stderr ?? console.error)("Warning: DEVIN_TOKEN is set, so Devin authentication remains active.");
  }
};
