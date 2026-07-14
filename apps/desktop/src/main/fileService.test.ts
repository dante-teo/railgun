import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileService, readFileHandleBounded } from "./fileService";
import { DESKTOP_FILE_LIMITS } from "../shared/schemas";

const execFileAsync = promisify(execFile);

describe("home file service", () => {
  let temporaryRoot: string;
  let home: string;
  const reveal = vi.fn();
  const toDataUrl = vi.fn(() => "data:image/png;base64,iVBORw0KGgo=");
  const decodeImage = vi.fn(() => ({ width: 2, height: 3, toDataUrl }));

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "railgun-files-"));
    home = join(temporaryRoot, "home");
    await mkdir(home);
    reveal.mockReset();
    decodeImage.mockClear();
    toDataUrl.mockClear();
  });

  afterEach(async () => { await rm(temporaryRoot, { recursive: true, force: true }); });

  const service = () => createFileService(home, { reveal, decodeImage });

  it("lists root and nested folders with hidden entries and folders first", async () => {
    await mkdir(join(home, "Zoo"));
    await mkdir(join(home, "alpha"));
    await writeFile(join(home, ".hidden"), "secret");
    await writeFile(join(home, "Beta.txt"), "beta");
    await writeFile(join(home, "alpha", "nested.txt"), "nested");
    expect((await service().list([])).entries.map(entry => entry.name)).toEqual(["alpha", "Zoo", ".hidden", "Beta.txt"]);
    expect((await service().list(["alpha"])).entries).toEqual([{ name: "nested.txt", kind: "file", symlink: false }]);
  });

  it("rejects traversal, absolute segments, missing paths, and file listings", async () => {
    await writeFile(join(home, "file.txt"), "text");
    await expect(service().list([".."])) .rejects.toThrow();
    await expect(service().list(["/tmp"])).rejects.toThrow();
    await expect(service().list(["missing"])).rejects.toThrow("unavailable");
    await expect(service().list(["file.txt"])).rejects.toThrow("not a folder");
  });

  it("allows ordinary in-home names that begin with two dots", async () => {
    await writeFile(join(home, "..notes"), "still inside home");
    await expect(service().preview(["..notes"])).resolves.toEqual({ kind: "text", text: "still inside home" });
  });

  it("lists and previews macOS filenames containing backslashes", async () => {
    await writeFile(join(home, "back\\slash.txt"), "valid macOS name");
    expect((await service().list([])).entries).toContainEqual({ name: "back\\slash.txt", kind: "file", symlink: false });
    await expect(service().preview(["back\\slash.txt"])).resolves.toEqual({ kind: "text", text: "valid macOS name" });
  });

  it("allows in-home symlinks but marks escaping and broken links unavailable", async () => {
    await mkdir(join(home, "target"));
    await writeFile(join(home, "target", "safe.txt"), "safe");
    await writeFile(join(temporaryRoot, "outside.txt"), "outside");
    await symlink(join(home, "target"), join(home, "safe-link"));
    await symlink(join(temporaryRoot, "outside.txt"), join(home, "escape-link"));
    await symlink(join(home, "missing"), join(home, "broken-link"));
    const entries = (await service().list([])).entries;
    expect(entries.find(entry => entry.name === "safe-link")).toEqual({ name: "safe-link", kind: "directory", symlink: true });
    expect(entries.find(entry => entry.name === "escape-link")).toEqual({ name: "escape-link", kind: "unavailable", symlink: true });
    expect(entries.find(entry => entry.name === "broken-link")).toEqual({ name: "broken-link", kind: "unavailable", symlink: true });
    await expect(service().preview(["escape-link"])).rejects.toThrow("unavailable");
  });

  it("previews bounded UTF-8 text and rejects binary, invalid, and oversized text", async () => {
    await writeFile(join(home, "text.txt"), "hello 🌿\n");
    await writeFile(join(home, "nul.bin"), Buffer.from([65, 0, 66]));
    await writeFile(join(home, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(home, "large.txt"), Buffer.alloc(DESKTOP_FILE_LIMITS.textBytes + 1, 65));
    await expect(service().preview(["text.txt"])).resolves.toEqual({ kind: "text", text: "hello 🌿\n" });
    await expect(service().preview(["nul.bin"])).rejects.toThrow("binary");
    await expect(service().preview(["invalid.txt"])).rejects.toThrow("UTF-8");
    await expect(service().preview(["large.txt"])).rejects.toThrow("too large");
  });

  it("rejects oversized files, folders, and special devices before reading", async () => {
    await writeFile(join(home, "huge.bin"), Buffer.alloc(DESKTOP_FILE_LIMITS.imageBytes + 1));
    await mkdir(join(home, "folder"));
    await execFileAsync("mkfifo", [join(home, "pipe")]);
    await expect(service().preview(["huge.bin"])).rejects.toThrow("too large");
    await expect(service().preview(["folder"])).rejects.toThrow("Folders");
    await expect(service().preview(["pipe"])).rejects.toThrow("cannot be previewed");
    expect((await service().list([])).entries.find(entry => entry.name === "pipe")?.kind).toBe("unavailable");
  });

  it("decodes and normalizes supported images with bounded dimensions", async () => {
    const fixtures = [
      ["image.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ["image.jpg", Buffer.from([0xff, 0xd8, 0xff])],
      ["image.gif", Buffer.from("GIF89a")],
      ["image.webp", Buffer.from("RIFF0000WEBP")],
      ["image.avif", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif")])],
    ] as const;
    for (const [name, signature] of fixtures) {
      await writeFile(join(home, name), Buffer.concat([signature, Buffer.from("payload")]));
      await expect(service().preview([name])).resolves.toEqual({
        kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 2, height: 3,
      });
    }
    expect(decodeImage).toHaveBeenCalledTimes(fixtures.length);

    toDataUrl.mockClear();
    decodeImage.mockReturnValueOnce({ width: 10_000, height: 10_000, toDataUrl });
    await expect(service().preview(["image.png"])).rejects.toThrow("too large");
    expect(toDataUrl).not.toHaveBeenCalled();
  });

  it("reveals only a canonical target inside home", async () => {
    await writeFile(join(home, "show.txt"), "show");
    await service().reveal(["show.txt"]);
    expect(reveal).toHaveBeenCalledWith(join(await realpath(home), "show.txt"));
    await expect(service().reveal(["missing.txt"])).rejects.toThrow("unavailable");
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("rejects directory responses above the IPC entry bound", async () => {
    const crowded = join(home, "crowded");
    await mkdir(crowded);
    for (let start = 0; start <= DESKTOP_FILE_LIMITS.directoryEntries; start += 250) {
      await Promise.all(Array.from(
        { length: Math.min(250, DESKTOP_FILE_LIMITS.directoryEntries + 1 - start) },
        (_, offset) => writeFile(join(crowded, `entry-${String(start + offset)}`), ""),
      ));
    }
    await expect(service().list(["crowded"])).rejects.toThrow("too large");
  });
});

describe("bounded preview reads", () => {
  it("reads at most the limit plus one byte and rejects a file that grows after stat", async () => {
    const content = Buffer.from("123456");
    const read = vi.fn(async (buffer: Buffer, _offset: number, length: number, position: number) => {
      const bytesRead = Math.min(length, content.length - position);
      if (bytesRead > 0) content.copy(buffer, 0, position, position + bytesRead);
      return { bytesRead, buffer };
    });
    await expect(readFileHandleBounded({ read } as never, 5)).rejects.toThrow("too large");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[2]).toBe(6);
  });
});
