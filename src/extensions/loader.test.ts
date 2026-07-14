import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionRunner } from "./runner.js";
import { loadExtensions } from "./loader.js";
import type { ExtensionError } from "./types.js";

// Helper: create a temp dir and return its path + a cleanup function
const withTempDir = async (
  fn: (dir: string) => Promise<void>
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "railgun-ext-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("loadExtensions", () => {
  it("loads a .js file with a default-export factory from the global extensions dir", async () => {
    await withTempDir(async tmpDir => {
      const homeDir = tmpDir;
      const extDir = join(homeDir, ".railgun", "extensions");
      await mkdir(extDir, { recursive: true });
      await writeFile(join(extDir, "my-ext.js"), `
        export default function(api) {
          api.registerTool({ name: "ext_tool", description: "hi", inputSchema: {}, execute: async () => ({ content: "ok" }) });
        }
      `);

      const runner = createExtensionRunner();
      await loadExtensions(runner, { homeDir });

      expect(runner.getTools()).toHaveLength(1);
      expect(runner.getTools()[0]?.name).toBe("ext_tool");
    });
  });

  it("loads a subdirectory with index.js", async () => {
    await withTempDir(async tmpDir => {
      const homeDir = tmpDir;
      const extDir = join(homeDir, ".railgun", "extensions", "my-plugin");
      await mkdir(extDir, { recursive: true });
      await writeFile(join(extDir, "index.js"), `
        export default function(api) {
          api.registerTool({ name: "plugin_tool", description: "", inputSchema: {}, execute: async () => ({ content: "" }) });
        }
      `);

      const runner = createExtensionRunner();
      await loadExtensions(runner, { homeDir });

      expect(runner.getTools()[0]?.name).toBe("plugin_tool");
    });
  });

  it("skips non-.ts/.js files", async () => {
    await withTempDir(async tmpDir => {
      const homeDir = tmpDir;
      const extDir = join(homeDir, ".railgun", "extensions");
      await mkdir(extDir, { recursive: true });
      await writeFile(join(extDir, "readme.md"), "# docs");
      await writeFile(join(extDir, "config.json"), "{}");

      const runner = createExtensionRunner();
      await loadExtensions(runner, { homeDir });

      expect(runner.getTools()).toHaveLength(0);
    });
  });

  it("reports a load error and continues loading other extensions", async () => {
    await withTempDir(async tmpDir => {
      const homeDir = tmpDir;
      const extDir = join(homeDir, ".railgun", "extensions");
      await mkdir(extDir, { recursive: true });
      // File that throws on import
      await writeFile(join(extDir, "aaa-bad.js"), `throw new Error("bad import");`);
      // File that loads fine — named bbb so it sorts after
      await writeFile(join(extDir, "bbb-good.js"), `
        export default function(api) {
          api.registerTool({ name: "good_tool", description: "", inputSchema: {}, execute: async () => ({ content: "" }) });
        }
      `);

      const runner = createExtensionRunner();
      const errors: ExtensionError[] = [];
      runner.onExtensionError(err => errors.push(err));
      await loadExtensions(runner, { homeDir });

      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toBe("load");
      expect(runner.getTools()[0]?.name).toBe("good_tool");
    });
  });

  it("does not load extensions outside the global Railgun home", async () => {
    await withTempDir(async tmpDir => {
      const localExtDir = join(tmpDir, ".railgun", "extensions");
      await mkdir(localExtDir, { recursive: true });
      await writeFile(join(localExtDir, "local-ext.js"), `
        export default function(api) {
          api.registerTool({ name: "local_tool", description: "", inputSchema: {}, execute: async () => ({ content: "" }) });
        }
      `);
      const homeDir = join(tmpDir, "home");
      await mkdir(homeDir, { recursive: true });

      const runner = createExtensionRunner();
      await loadExtensions(runner, { homeDir });

      expect(runner.getTools().find(t => t.name === "local_tool")).toBeUndefined();
    });
  });

  it("reports a load error for a module that does not export a default function", async () => {
    await withTempDir(async tmpDir => {
      const homeDir = tmpDir;
      const extDir = join(homeDir, ".railgun", "extensions");
      await mkdir(extDir, { recursive: true });
      await writeFile(join(extDir, "no-default.js"), `export const foo = 42;`);

      const runner = createExtensionRunner();
      const errors: ExtensionError[] = [];
      runner.onExtensionError(err => errors.push(err));
      await loadExtensions(runner, { homeDir });

      expect(errors).toHaveLength(1);
      expect(String(errors[0]?.error)).toContain("does not export a default function");
    });
  });

  it("createExtensionAPI delegates on and registerTool to the runner", async () => {
    await withTempDir(async tmpDir => {
      const homeDir = tmpDir;
      const extDir = join(homeDir, ".railgun", "extensions");
      await mkdir(extDir, { recursive: true });
      await writeFile(join(extDir, "wiring.js"), `
        export default function(api) {
          api.on("session_start", () => {});
          api.registerTool({ name: "wired_tool", description: "", inputSchema: {}, execute: async () => ({ content: "" }) });
          // stubs should not throw
          api.registerCommand("x", {});
          api.registerShortcut("y", {});
          api.registerFlag("z", {});
          api.registerProvider("w", {});
        }
      `);

      const runner = createExtensionRunner();
      await loadExtensions(runner, { homeDir });

      expect(runner.getTools()[0]?.name).toBe("wired_tool");
      // session_start handler registered — emitSessionStart should call it without throwing
      await expect(runner.emitSessionStart({ type: "session_start", reason: "new" })).resolves.toBeUndefined();
    });
  });
});
