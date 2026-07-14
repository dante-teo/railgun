import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";

export const INSTRUCTION_FILE_IDS = [
  "soul", "railgun-dotfile", "railgun", "agents-upper", "agents-lower",
  "claude-upper", "claude-lower", "cursor-rules",
] as const;

export type InstructionFileId = typeof INSTRUCTION_FILE_IDS[number];
export type InstructionFileStatus = "missing" | "active" | "shadowed";

export interface InstructionFileSummary {
  readonly id: InstructionFileId;
  readonly label: string;
  readonly status: InstructionFileStatus;
}

export interface InstructionFile extends InstructionFileSummary {
  readonly content: string;
}

interface Candidate {
  readonly id: InstructionFileId;
  readonly label: string;
  readonly path: string;
  readonly group: "identity" | "project";
}

type CandidateState = "missing" | "empty" | "non-empty";

const candidatesForHome = (home: string): readonly Candidate[] => [
  { id: "soul", label: "~/.railgun/SOUL.md", path: join(home, ".railgun", "SOUL.md"), group: "identity" },
  { id: "railgun-dotfile", label: "~/.railgun.md", path: join(home, ".railgun.md"), group: "project" },
  { id: "railgun", label: "~/RAILGUN.md", path: join(home, "RAILGUN.md"), group: "project" },
  { id: "agents-upper", label: "~/AGENTS.md", path: join(home, "AGENTS.md"), group: "project" },
  { id: "agents-lower", label: "~/agents.md", path: join(home, "agents.md"), group: "project" },
  { id: "claude-upper", label: "~/CLAUDE.md", path: join(home, "CLAUDE.md"), group: "project" },
  { id: "claude-lower", label: "~/claude.md", path: join(home, "claude.md"), group: "project" },
  { id: "cursor-rules", label: "~/.cursorrules", path: join(home, ".cursorrules"), group: "project" },
];

const isInstructionFileId = (value: string): value is InstructionFileId =>
  (INSTRUCTION_FILE_IDS as readonly string[]).includes(value);

export const parseInstructionFileId = (value: unknown): InstructionFileId => {
  if (typeof value !== "string" || !isInstructionFileId(value)) throw new Error("unknown instruction file id");
  return value;
};

export interface InstructionFileService {
  list(): Promise<readonly InstructionFileSummary[]>;
  get(id: InstructionFileId): Promise<InstructionFile>;
  update(id: InstructionFileId, content: string): Promise<InstructionFile>;
}

export const createInstructionFileService = (home = homedir()): InstructionFileService => {
  const candidates = candidatesForHome(home);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));

  const candidateFor = (id: InstructionFileId): Candidate => {
    const candidate = byId.get(id);
    if (candidate === undefined) throw new Error(`instruction file registry is missing id: ${id}`);
    return candidate;
  };

  const validateDirectory = async (path: string, label: string, allowMissing = false): Promise<void> => {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
      if (!info.isDirectory()) throw new Error(`${label} is not a directory`);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  };

  const validateParent = async (candidate: Candidate): Promise<void> => {
    await validateDirectory(home, "instruction home directory");
    if (candidate.id === "soul") {
      await validateDirectory(join(home, ".railgun"), `${candidate.label} parent directory`, true);
    }
  };

  const inspect = async (candidate: Candidate): Promise<CandidateState> => {
    await validateParent(candidate);
    try {
      const info = await lstat(candidate.path);
      if (info.isSymbolicLink()) throw new Error(`${candidate.label} is a symbolic link`);
      if (!info.isFile()) throw new Error(`${candidate.label} is not a regular file`);
      return (await readFile(candidate.path, "utf8")).trim() === "" ? "empty" : "non-empty";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  };

  const list = async (): Promise<readonly InstructionFileSummary[]> => {
    const states = await Promise.all(candidates.map(inspect));
    const firstProject = candidates.findIndex((candidate, index) =>
      candidate.group === "project" && states[index] === "non-empty");
    return candidates.map((candidate, index) => ({
      id: candidate.id,
      label: candidate.label,
      status: states[index] === "missing" ? "missing"
        : states[index] === "non-empty" && (candidate.group === "identity" || index === firstProject)
          ? "active"
          : "shadowed",
    }));
  };

  const get = async (id: InstructionFileId): Promise<InstructionFile> => {
    const candidate = candidateFor(id);
    const summaries = await list();
    const summary = summaries.find(item => item.id === id);
    if (summary === undefined) throw new Error(`instruction file summary is missing id: ${id}`);
    return { ...summary, content: await inspect(candidate) === "missing" ? "" : await readFile(candidate.path, "utf8") };
  };

  const update = async (id: InstructionFileId, content: string): Promise<InstructionFile> => {
    if (typeof content !== "string") throw new Error("instruction content must be a string");
    const candidate = candidateFor(id);
    await inspect(candidate);
    if (id === "soul") {
      await mkdir(join(home, ".railgun"), { recursive: true, mode: 0o700 });
      await validateParent(candidate);
    }
    await writeFileAtomic(candidate.path, content, { encoding: "utf8", mode: 0o600 });
    return get(id);
  };

  return { list, get, update };
};
