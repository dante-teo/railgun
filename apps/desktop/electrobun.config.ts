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
