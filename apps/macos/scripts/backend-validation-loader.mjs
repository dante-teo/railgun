const validationProviderSource = String.raw`
const model = Object.freeze({
  id: "validation-model",
  name: "Validation Model",
  provider: "devin",
  baseUrl: "https://validation.invalid",
  input: ["text"],
  supportsTools: true,
  reasoning: false,
  contextWindow: 16_384,
  maxTokens: 4_096,
});

export class DevinApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "DevinApiError";
    this.status = status;
    this.body = body;
  }
}

export class DevinAuthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "DevinAuthError";
    this.cause = cause;
  }
}

export class DevinProtocolError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "DevinProtocolError";
    this.cause = cause;
  }
}

export const createMemoryTokenStore = (initialToken = "") => {
  let token = initialToken;
  return {
    get: async () => token || undefined,
    set: async (value) => { token = value; },
    clear: async () => { token = ""; },
  };
};

export const createFileTokenStore = () => createMemoryTokenStore();

export const createDevinProvider = ({ tokenStore = createMemoryTokenStore() } = {}) => ({
  login: async () => {
    await tokenStore.set("validation-token");
    return "validation-token";
  },
  setToken: (token) => tokenStore.set(token),
  clearToken: () => tokenStore.clear(),
  listModels: async () => [model],
  streamChat: async function* () {
    yield { type: "done", reason: "stop" };
  },
});
`;

const validationProviderURL = `data:text/javascript,${encodeURIComponent(validationProviderSource)}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "widevin") {
    return { url: validationProviderURL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
