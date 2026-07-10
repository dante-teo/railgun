import { describe, expect, it, vi } from "vitest";
import { DevinApiError, DevinProtocolError, type DevinProvider, type TokenStore } from "widevin";
import {
  CredentialRejectedError,
  LoginVerificationError,
  createAuthenticatedProvider,
  runLoginCommand,
  runLogoutCommand,
} from "./auth.js";

const tokenStore = (initial?: string): TokenStore & { value: string | undefined } => {
  const store: TokenStore & { value: string | undefined } = {
    value: initial,
    get: vi.fn(async () => store.value),
    set: vi.fn(async token => { store.value = token; }),
    clear: vi.fn(async () => { store.value = undefined; }),
  };
  return store;
};

type ProviderOverrides = Partial<DevinProvider> & { streamError?: unknown };
const provider = (store: TokenStore, overrides: ProviderOverrides = {}): DevinProvider => ({
  login: overrides.login ?? vi.fn(async () => { await store.set("oauth-token"); return "oauth-token"; }),
  setToken: overrides.setToken ?? (token => store.set(token)),
  clearToken: overrides.clearToken ?? (() => store.clear()),
  listModels: overrides.listModels ?? vi.fn(async () => []),
  streamChat: overrides.streamChat ?? (async function* () {
    if (overrides.streamError) throw overrides.streamError;
    yield { type: "done", reason: "stop" } as const;
  }),
});

const factory = (overrides: ProviderOverrides = {}) => vi.fn((store: TokenStore) => provider(store, overrides));

describe("createAuthenticatedProvider", () => {
  it("trims DEVIN_TOKEN and gives it process-local precedence without reading or changing the cache", async () => {
    const file = tokenStore("cached-token");
    const memory = tokenStore();
    const createProvider = factory();
    const result = await createAuthenticatedProvider({
      environmentToken: "  environment-token  ", fileStore: file,
      createMemoryStore: vi.fn(token => { memory.value = token; return memory; }), createProvider,
    });

    expect(result.source).toBe("environment");
    expect(memory.value).toBe("environment-token");
    expect(file.get).not.toHaveBeenCalled();
    expect(file.set).not.toHaveBeenCalled();
    expect(file.clear).not.toHaveBeenCalled();
  });

  it("treats whitespace-only environment input as absent and reuses a valid cache", async () => {
    const file = tokenStore("cached-token");
    const createProvider = factory();
    const result = await createAuthenticatedProvider({ environmentToken: " \n ", fileStore: file, createProvider });
    expect(result.source).toBe("file");
    expect(result.devin.login).not.toHaveBeenCalled();
  });

  it("opens browser login only when the cache is absent", async () => {
    const file = tokenStore();
    const createProvider = factory();
    const result = await createAuthenticatedProvider({ fileStore: file, createProvider });
    expect(result.devin.login).toHaveBeenCalledOnce();
  });

  it("clears a cached credential rejected by model discovery", async () => {
    const file = tokenStore("bad-cache");
    const result = await createAuthenticatedProvider({
      fileStore: file,
      createProvider: factory({ listModels: vi.fn(async () => { throw new DevinApiError("unauthorized", 401); }) }),
    });
    await expect(result.devin.listModels()).rejects.toMatchObject({ source: "file" });
    expect(file.clear).toHaveBeenCalledOnce();
  });

  it("reports cache-removal failure on rejection without losing the original 401", async () => {
    const file = tokenStore("bad-cache");
    const removalFailure = new Error("permission denied");
    vi.mocked(file.clear).mockRejectedValue(removalFailure);
    const result = await createAuthenticatedProvider({
      fileStore: file,
      createProvider: factory({ listModels: vi.fn(async () => { throw new DevinApiError("unauthorized", 401); }) }),
    });
    await expect(result.devin.listModels()).rejects.toMatchObject({
      source: "file",
      rejection: expect.objectContaining({ status: 401 }),
      removalFailure,
    });
  });

  it("clears a cached credential rejected during async streaming", async () => {
    const file = tokenStore("bad-cache");
    const result = await createAuthenticatedProvider({
      fileStore: file, createProvider: factory({ streamError: new DevinApiError("unauthorized", 401) }),
    });
    await expect(async () => { for await (const _event of result.devin.streamChat({ model: "m", messages: [] })) { /* consume */ } })
      .rejects.toBeInstanceOf(CredentialRejectedError);
    expect(file.clear).toHaveBeenCalledOnce();
  });

  it("never clears the cached token when an environment credential is rejected", async () => {
    const file = tokenStore("good-cache");
    const result = await createAuthenticatedProvider({
      environmentToken: "bad-env", fileStore: file,
      createProvider: factory({ listModels: vi.fn(async () => { throw new DevinApiError("unauthorized", 401); }) }),
    });
    await expect(result.devin.listModels()).rejects.toMatchObject({ source: "environment" });
    expect(file.clear).not.toHaveBeenCalled();
    expect(file.value).toBe("good-cache");
  });

  it.each([403, 400])("preserves cached credentials for HTTP %d", async status => {
    const file = tokenStore("cached-token");
    const error = new DevinApiError("client failure", status);
    const result = await createAuthenticatedProvider({
      fileStore: file, createProvider: factory({ listModels: vi.fn(async () => { throw error; }) }),
    });
    await expect(result.devin.listModels()).rejects.toBe(error);
    expect(file.clear).not.toHaveBeenCalled();
  });
});

describe("login/logout commands", () => {
  it("always performs fresh OAuth, verifies it, and warns when DEVIN_TOKEN overrides the cache", async () => {
    const file = tokenStore("old-token");
    const stderr = vi.fn();
    const devin = provider(file);
    await runLoginCommand({ environmentToken: " env-token ", fileStore: file, createProvider: () => devin, stdout: vi.fn(), stderr });
    expect(devin.login).toHaveBeenCalledOnce();
    expect(devin.listModels).toHaveBeenCalledOnce();
    expect(file.value).toBe("oauth-token");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("DEVIN_TOKEN"));
  });

  it("preserves the old cache when OAuth fails before returning a replacement", async () => {
    const file = tokenStore("old-token");
    const error = new Error("cancelled");
    await expect(runLoginCommand({
      fileStore: file, createProvider: () => provider(file, { login: vi.fn(async () => { throw error; }) }), stdout: vi.fn(), stderr: vi.fn(),
    })).rejects.toBe(error);
    expect(file.value).toBe("old-token");
  });

  it("clears a newly saved token rejected with 401", async () => {
    const file = tokenStore("old-token");
    await expect(runLoginCommand({
      fileStore: file,
      createProvider: () => provider(file, { listModels: vi.fn(async () => { throw new DevinApiError("unauthorized", 401); }) }),
      stdout: vi.fn(), stderr: vi.fn(),
    })).rejects.toBeInstanceOf(CredentialRejectedError);
    expect(file.value).toBeUndefined();
  });

  it.each([
    new DevinProtocolError("bad response"),
    new DevinApiError("temporarily unavailable", 503),
  ])("retains a saved token and adds saved-but-unverified context for uncertain verification failure $name", async error => {
    const file = tokenStore("old-token");
    const stderr = vi.fn();
    await expect(runLoginCommand({
      environmentToken: "env-token", fileStore: file,
      createProvider: () => provider(file, { listModels: vi.fn(async () => { throw error; }) }),
      stdout: vi.fn(), stderr,
    })).rejects.toBeInstanceOf(LoginVerificationError);
    expect(file.value).toBe("oauth-token");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("DEVIN_TOKEN"));
  });

  it.each([undefined, "cached-token"])("logout is idempotent with cache %s and warns when env auth remains", async initial => {
    const file = tokenStore(initial);
    const stderr = vi.fn();
    await runLogoutCommand({ environmentToken: "env-token", fileStore: file, stdout: vi.fn(), stderr });
    expect(file.clear).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("DEVIN_TOKEN"));
  });
});
