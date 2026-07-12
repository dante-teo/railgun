import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { TRUST_PATH } from "./paths.js";

export type TrustChoice = "trust" | "trust-session" | "deny";

export type TrustDecision =
  | { readonly status: "trusted"; readonly scope: "persisted" | "session" }
  | { readonly status: "denied"; readonly scope: "persisted" | "session" }
  | { readonly status: "unknown" };

export interface TrustStoreData {
  readonly [canonicalPath: string]: { readonly status: "trusted" | "denied" };
}

export interface ProjectTrustStore {
  readonly get: (cwd: string) => TrustDecision;
  readonly set: (cwd: string, choice: TrustChoice) => TrustDecision;
}

interface CreateTrustStoreOptions {
  readonly path?: string;
  readonly readFile?: (path: string) => string;
  readonly writeFile?: (path: string, contents: string) => void;
}

export const createProjectTrustStore = (options: CreateTrustStoreOptions = {}): ProjectTrustStore => {
  const storePath = options.path ?? TRUST_PATH;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile = options.writeFile ?? ((p: string, contents: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, contents, { encoding: "utf8", mode: 0o600 });
  });

  let data: TrustStoreData = {};
  try {
    data = JSON.parse(readFile(storePath)) as TrustStoreData;
  } catch {
    // Missing file or unparseable JSON → start with empty store
    data = {};
  }

  const persist = (): void => {
    writeFile(storePath, JSON.stringify(data, null, 2) + "\n");
  };

  const get = (cwd: string): TrustDecision => {
    let current = resolvePath(cwd);
    while (true) {
      const entry = data[current];
      if (entry !== undefined) {
        return { status: entry.status, scope: "persisted" };
      }
      const parent = dirname(current);
      if (parent === current) break; // filesystem root
      current = parent;
    }
    return { status: "unknown" };
  };

  const set = (cwd: string, choice: TrustChoice): TrustDecision => {
    const canonical = resolvePath(cwd);
    if (choice === "trust" || choice === "deny") {
      const status = choice === "trust" ? "trusted" as const : "denied" as const;
      data = { ...data, [canonical]: { status } };
      persist();
      return { status, scope: "persisted" };
    }
    // trust-session: no persistence — assert exhaustiveness so new variants don't silently land here
    const _exhaustive: "trust-session" = choice;
    void _exhaustive;
    return { status: "trusted", scope: "session" };
  };

  return { get, set };
};

export interface TrustResolutionOptions {
  readonly cliApprove?: boolean;
  readonly cliNoApprove?: boolean;
  readonly defaultTrust: "ask" | "always" | "never";
  readonly promptTrustChoice: (cwd: string) => Promise<TrustChoice>;
}

export const resolveProjectTrust = async (
  cwd: string,
  store: ProjectTrustStore,
  options: TrustResolutionOptions,
): Promise<TrustDecision> => {
  if (options.cliApprove) return { status: "trusted", scope: "session" };
  if (options.cliNoApprove) return { status: "denied", scope: "session" };
  if (options.defaultTrust === "always") return { status: "trusted", scope: "session" };
  if (options.defaultTrust === "never") return { status: "denied", scope: "session" };

  const stored = store.get(cwd);
  if (stored.status !== "unknown") return stored;

  const choice = await options.promptTrustChoice(cwd);
  return store.set(cwd, choice);
};

const CHOICES: readonly { readonly label: string; readonly value: TrustChoice }[] = [
  { label: "Trust", value: "trust" },
  { label: "Trust (this session only)", value: "trust-session" },
  { label: "Do not trust", value: "deny" },
];

export const promptTrustChoiceReadline = (cwd: string): Promise<TrustChoice> => {
  const { promise, resolve } = Promise.withResolvers<TrustChoice>();

  let selected = 0;

  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const CYAN = "\x1b[36m";
  const CLEAR_LINE = "\r\x1b[K";
  const HIDE_CURSOR = "\x1b[?25l";
  const SHOW_CURSOR = "\x1b[?25h";

  const render = () => {
    for (let i = 0; i < CHOICES.length; i++) {
      const prefix = i === selected ? `${BOLD}${CYAN}> ` : "  ";
      process.stderr.write(`${CLEAR_LINE}${prefix}${CHOICES[i]!.label}${RESET}\n`);
    }
    // Move cursor back up to re-render in place
    process.stderr.write(`\x1b[${CHOICES.length}A`);
  };

  process.stderr.write(`\nTrust project folder ${cwd}?\n`);
  process.stderr.write("This allows railgun to load .railgun/ settings, extensions, and skills.\n\n");
  process.stderr.write(HIDE_CURSOR);
  render();

  const { stdin } = process;
  const prevRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const teardown = () => {
    stdin.removeListener("data", onData);
    stdin.setRawMode(prevRaw ?? false);
    stdin.pause();
    process.stderr.write(`\x1b[${CHOICES.length}B${SHOW_CURSOR}\n`);
  };

  const onData = (chunk: string) => {
    if (chunk === "\x1b[A" || chunk === "k") {
      selected = (selected - 1 + CHOICES.length) % CHOICES.length;
      render();
    } else if (chunk === "\x1b[B" || chunk === "j") {
      selected = (selected + 1) % CHOICES.length;
      render();
    } else if (chunk === "\r" || chunk === "\n") {
      teardown();
      resolve(CHOICES[selected]!.value);
    } else if (chunk === "\x03") {
      teardown();
      process.kill(process.pid, "SIGINT");
    }
  };

  stdin.on("data", onData);
  return promise;
};

export const assertProjectTrustedForRead = (
  decision: TrustDecision,
  resourcePath: string,
): void => {
  if (decision.status !== "trusted") {
    throw new Error(
      `Refusing to load ${resourcePath}: project is not trusted. ` +
      `Run /trust or restart with --approve to enable local config.`,
    );
  }
};

export const assertProjectTrustedForInstall = (
  decision: TrustDecision,
): void => {
  if (decision.status !== "trusted") {
    throw new Error(
      "Refusing to install project-local package: project is not trusted.",
    );
  }
};
