import { constants } from "node:fs";
import { opendir, lstat, open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { DESKTOP_FILE_LIMITS, DirectoryListingSchema, FilePathSegmentsSchema, FilePreviewSchema } from "../shared/schemas";
import type { DirectoryEntry, DirectoryListing, FilePreview } from "../shared/types";

interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly toDataUrl: () => string;
}

export interface FileServiceDependencies {
  readonly decodeImage: (buffer: Buffer) => DecodedImage;
  readonly reveal: (path: string) => void;
}

export interface FileService {
  list(pathSegments: readonly string[]): Promise<DirectoryListing>;
  preview(pathSegments: readonly string[]): Promise<FilePreview>;
  reveal(pathSegments: readonly string[]): Promise<void>;
}

class SafeFileError extends Error {}
const safeError = (message: string): SafeFileError => new SafeFileError(message);
const PREVIEW_READ_CHUNK_BYTES = 64 * 1_024;
const previewOpenFlags = constants.O_RDONLY
  | constants.O_NONBLOCK
  | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0);

type ReadableFileHandle = Pick<FileHandle, "read">;

export const readFileHandleBounded = async (
  handle: ReadableFileHandle,
  limit: number,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.allocUnsafe(Math.min(PREVIEW_READ_CHUNK_BYTES, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > limit) throw safeError("This file is too large to preview.");
  return Buffer.concat(chunks, total);
};

const isWithin = (root: string, target: string): boolean => {
  const fromRoot = relative(root, target);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
};

const isSupportedImage = (buffer: Buffer): boolean => {
  const ascii = (start: number, end: number): string => buffer.subarray(start, end).toString("ascii");
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return true;
  if (buffer.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return true;
  if (buffer.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    return brand === "avif" || brand === "avis";
  }
  return false;
};

const decodeText = (buffer: Buffer): string => {
  if (buffer.includes(0)) throw safeError("This file appears to be binary and cannot be previewed as text.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw safeError("This file is not valid UTF-8 text.");
  }
  const controls = [...text].filter(character => {
    const code = character.charCodeAt(0);
    return code < 32 && character !== "\n" && character !== "\r" && character !== "\t";
  }).length;
  if (controls > Math.max(8, text.length * 0.01)) {
    throw safeError("This file contains too much binary control data to preview safely.");
  }
  return text;
};

export const createFileService = (homePath: string, dependencies: FileServiceDependencies): FileService => {
  let canonicalHomePromise: Promise<string> | undefined;
  const canonicalHome = (): Promise<string> => canonicalHomePromise ??= realpath(homePath);

  const resolveTarget = async (pathSegments: readonly string[]): Promise<string> => {
    const segments = FilePathSegmentsSchema.parse(pathSegments);
    if (segments.some(segment => segment.includes(sep))) throw safeError("This item is unavailable.");
    const root = await canonicalHome();
    const candidate = join(root, ...segments);
    let target: string;
    try { target = await realpath(candidate); }
    catch { throw safeError("This item is unavailable."); }
    if (!isWithin(root, target)) throw safeError("This item is unavailable.");
    return target;
  };

  const describeEntry = async (directory: string, name: string): Promise<DirectoryEntry> => {
    const candidate = join(directory, name);
    let link;
    try { link = await lstat(candidate); }
    catch { return { name, kind: "unavailable", symlink: false }; }
    const symlink = link.isSymbolicLink();
    try {
      const target = await realpath(candidate);
      const root = await canonicalHome();
      if (!isWithin(root, target)) return { name, kind: "unavailable", symlink };
      const targetStat = symlink ? await stat(target) : link;
      const kind = targetStat.isDirectory() ? "directory" : targetStat.isFile() ? "file" : "unavailable";
      return { name, kind, symlink };
    } catch {
      return { name, kind: "unavailable", symlink };
    }
  };

  return {
    async list(pathSegments) {
      const directory = await resolveTarget(pathSegments);
      let directoryStat;
      try { directoryStat = await stat(directory); }
      catch { throw safeError("This folder is unavailable."); }
      if (!directoryStat.isDirectory()) throw safeError("This item is not a folder.");

      const names: string[] = [];
      try {
        const handle = await opendir(directory);
        for await (const entry of handle) {
          names.push(entry.name);
          if (names.length > DESKTOP_FILE_LIMITS.directoryEntries) {
            throw safeError("This directory is too large to display.");
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === "This directory is too large to display.") throw error;
        throw safeError("This folder is unavailable.");
      }
      const entries = await Promise.all(names.map(name => describeEntry(directory, name)));
      entries.sort((left, right) => {
        const leftFolder = left.kind === "directory" ? 0 : 1;
        const rightFolder = right.kind === "directory" ? 0 : 1;
        return leftFolder - rightFolder || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.name.localeCompare(right.name);
      });
      return DirectoryListingSchema.parse({ entries });
    },

    async preview(pathSegments) {
      const target = await resolveTarget(pathSegments);
      let handle: FileHandle;
      try { handle = await open(target, previewOpenFlags); }
      catch { throw safeError("This file is unreadable."); }
      let buffer: Buffer;
      try {
        const targetStat = await handle.stat();
        if (!targetStat.isFile()) throw safeError(targetStat.isDirectory() ? "Folders cannot be previewed." : "This file type cannot be previewed.");
        if (targetStat.size > DESKTOP_FILE_LIMITS.imageBytes) throw safeError("This file is too large to preview.");
        buffer = await readFileHandleBounded(handle, DESKTOP_FILE_LIMITS.imageBytes);
      } catch (error) {
        if (error instanceof SafeFileError) throw error;
        throw safeError("This file is unreadable.");
      } finally {
        await handle.close().catch(() => undefined);
      }

      if (isSupportedImage(buffer)) {
        let decoded: DecodedImage;
        try { decoded = dependencies.decodeImage(buffer); }
        catch { throw safeError("This image cannot be decoded."); }
        if (decoded.width <= 0 || decoded.height <= 0
          || decoded.width * decoded.height > DESKTOP_FILE_LIMITS.imagePixels) {
          throw safeError("This image is too large to preview.");
        }
        let dataUrl: string;
        try { dataUrl = decoded.toDataUrl(); }
        catch { throw safeError("This image cannot be decoded."); }
        if (dataUrl.length > DESKTOP_FILE_LIMITS.dataUrl) throw safeError("This image is too large to preview.");
        if (!dataUrl.startsWith("data:image/png;base64,")) throw safeError("This image cannot be decoded.");
        return FilePreviewSchema.parse({ kind: "image", dataUrl, width: decoded.width, height: decoded.height });
      }
      if (buffer.length > DESKTOP_FILE_LIMITS.textBytes) throw safeError("This text file is too large to preview.");
      return FilePreviewSchema.parse({ kind: "text", text: decodeText(buffer) });
    },

    async reveal(pathSegments) {
      const target = await resolveTarget(pathSegments);
      dependencies.reveal(target);
    },
  };
};
