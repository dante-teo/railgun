import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { TRUST_PATH } from "./paths.js";

export type TrustChoice =
  | "trust"
  | "trust-parent"
  | "trust-session"
  | "deny"
  | "deny-session";

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
    switch (choice) {
      case "trust": {
        data = { ...data, [canonical]: { status: "trusted" } };
        persist();
        return { status: "trusted", scope: "persisted" };
      }
      case "trust-parent": {
        const parent = dirname(canonical);
        data = { ...data, [parent]: { status: "trusted" } };
        persist();
        return { status: "trusted", scope: "persisted" };
      }
      case "deny": {
        data = { ...data, [canonical]: { status: "denied" } };
        persist();
        return { status: "denied", scope: "persisted" };
      }
      case "trust-session":
        return { status: "trusted", scope: "session" };
      case "deny-session":
        return { status: "denied", scope: "session" };
    }
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

export const promptTrustChoiceReadline = async (cwd: string): Promise<TrustChoice> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(`\nTrust project folder ${cwd}?\n`);
    process.stderr.write("This allows railgun to load .railgun/ settings, extensions, and skills.\n\n");
    process.stderr.write("  1. Trust\n");
    process.stderr.write("  2. Trust parent folder\n");
    process.stderr.write("  3. Trust (this session only)\n");
    process.stderr.write("  4. Do not trust\n");
    process.stderr.write("  5. Do not trust (this session only)\n\n");
    const answer = await new Promise<string>(resolve => rl.question("Choice [1-5]: ", resolve));
    const choices: Record<string, TrustChoice> = {
      "1": "trust",
      "2": "trust-parent",
      "3": "trust-session",
      "4": "deny",
      "5": "deny-session",
    };
    return choices[answer.trim()] ?? "deny-session";
  } finally {
    rl.close();
  }
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
