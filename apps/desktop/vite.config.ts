import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@railgun/core": resolve(__dirname, "../../src"),
    },
  },
  test: {
    environment: "node",
    include: ["gateway/**/*.test.ts"],
  },
});
