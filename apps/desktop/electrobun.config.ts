import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Railgun",
    identifier: "com.railgun.desktop",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      renderer: {
        entrypoint: "renderer/main.tsx",
        jsx: {
          runtime: "automatic",
          importSource: "react",
        },
        // Bun.build alias: mirrors the @railgun/core/* path alias in vite.config.ts
        // and tsconfig.json so the renderer can import from core without ink contamination.
        alias: {
          "@railgun/core": "../../src",
        },
      },
    },
    copy: {
      "index.html": "views/renderer/index.html",
    },
    mac: {
      codesign: false,
      notarize: false,
    },
  },
} satisfies ElectrobunConfig;
