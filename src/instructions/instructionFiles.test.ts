import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInstructionFileService, parseInstructionFileId } from "./instructionFiles.js";

const homes: string[] = [];
const home = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "railgun-instructions-"));
  homes.push(value);
  return value;
};
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("instruction files", () => {
  it("exposes only fixed ids and applies loader precedence", async () => {
    const root = await home();
    await writeFile(join(root, ".railgun.md"), "primary");
    await writeFile(join(root, "AGENTS.md"), "secondary");
    const files = await createInstructionFileService(root).list();
    expect(files).toHaveLength(8);
    expect(files.find(file => file.id === "railgun-dotfile")?.status).toBe("active");
    expect(files.find(file => file.id === "agents-upper")?.status).toBe("shadowed");
    expect(() => parseInstructionFileId("../../credentials")).toThrow("unknown instruction file id");
  });

  it("skips empty higher-priority files when reporting loader precedence", async () => {
    const root = await home();
    await writeFile(join(root, ".railgun.md"), "  \n");
    await writeFile(join(root, "AGENTS.md"), "active instructions");

    const files = await createInstructionFileService(root).list();

    expect(files.find(file => file.id === "railgun-dotfile")?.status).toBe("shadowed");
    expect(files.find(file => file.id === "agents-upper")?.status).toBe("active");
  });

  it("creates missing files atomically and permits empty content", async () => {
    const root = await home();
    const service = createInstructionFileService(root);
    await service.update("soul", "");
    expect(await readFile(join(root, ".railgun", "SOUL.md"), "utf8")).toBe("");
    expect((await service.get("soul")).status).toBe("shadowed");
  });

  it("rejects symbolic links and non-regular files", async () => {
    const root = await home();
    await writeFile(join(root, "target"), "secret");
    await symlink(join(root, "target"), join(root, "AGENTS.md"));
    await expect(createInstructionFileService(root).get("agents-upper")).rejects.toThrow("symbolic link");
    await rm(join(root, "AGENTS.md"));
    await mkdir(join(root, "AGENTS.md"));
    await expect(createInstructionFileService(root).update("agents-upper", "value")).rejects.toThrow("not a regular file");
  });

  it("rejects a symlinked Soul parent directory", async () => {
    const root = await home();
    const outside = await home();
    await symlink(outside, join(root, ".railgun"));

    await expect(createInstructionFileService(root).update("soul", "do not write"))
      .rejects.toThrow("parent directory is a symbolic link");
    await expect(readFile(join(outside, "SOUL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
