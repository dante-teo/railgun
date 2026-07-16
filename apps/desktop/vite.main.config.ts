import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __RAILGUN_UPDATE_CHANNEL__: JSON.stringify(process.env.RAILGUN_UPDATE_CHANNEL === "homebrew" ? "homebrew" : "direct"),
  },
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/main/main.ts"),
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    outDir: ".vite/build",
    rollupOptions: {
      external: ["electron", "node:child_process", "node:path"],
    },
    sourcemap: true,
  },
});
