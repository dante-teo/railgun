import { describe, expect, it } from "vitest";
import { readMacReleaseCredentials, readReleaseVersion, toMacAppVersion } from "./releaseConfig";

describe("desktop release configuration", () => {
  it("keeps ordinary local and CI packages unsigned", () => {
    expect(readMacReleaseCredentials({})).toBeUndefined();
    expect(readReleaseVersion({})).toBeUndefined();
  });

  it("loads complete notarization credentials and an optional temporary keychain", () => {
    expect(readMacReleaseCredentials({
      APPLE_ID: "developer@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAM123456",
      MACOS_KEYCHAIN: "/tmp/release.keychain-db",
    })).toEqual({
      appleId: "developer@example.com",
      appleIdPassword: "app-password",
      teamId: "TEAM123456",
      keychain: "/tmp/release.keychain-db",
    });
  });

  it("rejects partial credentials and malformed tag versions", () => {
    expect(() => readMacReleaseCredentials({ APPLE_ID: "developer@example.com" }))
      .toThrow("missing APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID");
    expect(() => readReleaseVersion({ RAILGUN_DESKTOP_VERSION: "v1.2.3" }))
      .toThrow("Invalid desktop release version");
    expect(readReleaseVersion({ RAILGUN_DESKTOP_VERSION: "1.2.3-beta.1" })).toBe("1.2.3-beta.1");
  });

  it("uses a numeric macOS app version for prereleases", () => {
    expect(toMacAppVersion("1.2.3")).toBe("1.2.3");
    expect(toMacAppVersion("1.2.3-beta.1")).toBe("1.2.3");
  });
});
