import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, "src/mock/backend.ts"),
      formats: ["cjs"],
      fileName: () => "mock-backend.cjs",
    },
    outDir: "backend",
    emptyOutDir: false,
    rollupOptions: {
      external: ["node:readline"],
    },
    sourcemap: true,
  },
});
