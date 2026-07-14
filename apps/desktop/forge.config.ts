import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readMacReleaseCredentials,
  readReleaseVersion,
  toMacAppVersion,
} from "./src/main/releaseConfig";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const releaseCredentials = readMacReleaseCredentials(process.env);
const releaseVersion = readReleaseVersion(process.env);
const macAppVersion = releaseVersion === undefined ? undefined : toMacAppVersion(releaseVersion);
const buildVersion = process.env.RAILGUN_DESKTOP_BUILD_VERSION;
const signingIdentity = "Developer ID Application: Chen Pei Teo (GUKP6SNV36)";

const config: ForgeConfig = {
  ...(releaseVersion === undefined ? {} : {
    hooks: {
      readPackageJson: async (_forgeConfig, packageJson) => ({ ...packageJson, version: releaseVersion }),
    },
  }),
  packagerConfig: {
    name: "Railgun",
    appBundleId: "sh.railgun.desktop",
    appCategoryType: "public.app-category.developer-tools",
    ...(macAppVersion === undefined ? {} : { appVersion: macAppVersion }),
    ...(buildVersion === undefined ? {} : { buildVersion }),
    asar: true,
    extendInfo: { LSMinimumSystemVersion: "13.0" },
    icon: resolve(desktopRoot, "assets/railgun-icon.icns"),
    prune: false,
    extraResource: [resolve(desktopRoot, "backend")],
    ...(releaseCredentials === undefined ? {} : {
      osxSign: {
        identity: signingIdentity,
        ...(releaseCredentials.keychain === undefined ? {} : { keychain: releaseCredentials.keychain }),
      },
      osxNotarize: {
        appleId: releaseCredentials.appleId,
        appleIdPassword: releaseCredentials.appleIdPassword,
        teamId: releaseCredentials.teamId,
      },
    }),
  },
  makers: [new MakerZIP({}, ["darwin"])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
    }),
  ],
};

export default config;
