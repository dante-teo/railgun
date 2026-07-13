import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  root: "src/renderer",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../.vite/renderer/main_window",
    emptyOutDir: true,
    sourcemap: true,
  },
});
