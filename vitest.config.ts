import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      "apps/desktop/vite.config.ts",
    ],
  },
});
