export interface MacReleaseCredentials {
  readonly appleId: string;
  readonly appleIdPassword: string;
  readonly teamId: string;
  readonly keychain?: string;
}

const RELEASE_CREDENTIALS = [
  ["APPLE_ID", "appleId"],
  ["APPLE_APP_SPECIFIC_PASSWORD", "appleIdPassword"],
  ["APPLE_TEAM_ID", "teamId"],
] as const;

export const readMacReleaseCredentials = (
  environment: NodeJS.ProcessEnv,
): MacReleaseCredentials | undefined => {
  const configured = RELEASE_CREDENTIALS.filter(([name]) => environment[name] !== undefined);
  if (configured.length === 0) return undefined;

  const missing = RELEASE_CREDENTIALS
    .filter(([name]) => environment[name] === undefined || environment[name] === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Incomplete macOS release credentials; missing ${missing.join(", ")}`);
  }

  const credentials = Object.fromEntries(
    RELEASE_CREDENTIALS.map(([name, property]) => [property, environment[name]]),
  ) as unknown as Omit<MacReleaseCredentials, "keychain">;
  const keychain = environment.MACOS_KEYCHAIN;
  return keychain === undefined || keychain === "" ? credentials : { ...credentials, keychain };
};

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export const readReleaseVersion = (environment: NodeJS.ProcessEnv): string | undefined => {
  const version = environment.RAILGUN_DESKTOP_VERSION;
  if (version === undefined) return undefined;
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid desktop release version: ${version}`);
  return version;
};

export const toMacAppVersion = (releaseVersion: string): string => releaseVersion.replace(/-.+$/u, "");
