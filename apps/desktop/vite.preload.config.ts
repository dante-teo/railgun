import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/preload/preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
    outDir: ".vite/build",
    emptyOutDir: false,
    rollupOptions: {
      external: ["electron"],
    },
    sourcemap: true,
  },
});
