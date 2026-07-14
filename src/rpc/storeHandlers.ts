import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { updateConfig } from "../config.js";
import type { CronJob } from "../cron/jobs.js";
import { loadJobs, saveJobs, validateJob } from "../cron/jobs.js";
import { parseMcpServers } from "../extensions/mcp/config.js";
import type { MemoryStore } from "../persistence/memoryStore.js";
import type { EmbedFn, NoteStore } from "../persistence/noteStore.js";
import { loadSkills } from "../skills.js";
import type { RpcCommand } from "./types.js";

type ManagementCommand = Extract<RpcCommand,
  { type: "config_get" | "config_update" | "mcp_list" | "mcp_upsert" | "mcp_remove" |
    "cron_list" | "cron_add" | "cron_update" | "cron_remove" |
    "memory_list" | "memory_search" | "memory_create" | "memory_update" | "memory_delete" |
    "notes_import" | "notes_search" | "skills_list" | "skill_get" }>;

export interface RpcStoreDependencies {
  readonly memoryStore?: MemoryStore;
  readonly noteStore?: NoteStore;
  readonly getConfig: () => AppConfig;
  readonly setConfig: (config: AppConfig) => void;
  readonly updateConfig?: (transform: (current: Readonly<AppConfig>) => AppConfig) => Promise<AppConfig>;
  readonly loadJobs?: () => Promise<readonly CronJob[]>;
  readonly saveJobs?: (jobs: readonly CronJob[]) => Promise<void>;
  readonly loadSkills?: typeof loadSkills;
  readonly embedText?: EmbedFn;
  readonly randomId?: () => string;
}

const cleanConfig = (config: AppConfig): AppConfig => {
  const { mcpServers: _mcpServers, ...safe } = config;
  return safe as AppConfig;
};

const safeMcpServers = (config: AppConfig): readonly Record<string, unknown>[] =>
  Object.entries(parseMcpServers(config.mcpServers)).map(([name, server]) => ({
    name,
    command: server.command,
    args: server.args ?? [],
    env: Object.keys(server.env ?? {}).sort().map(key => ({ name: key, present: true })),
  }));

const requireMemory = (store: MemoryStore | undefined): MemoryStore => {
  if (store === undefined) throw new Error("memory store is unavailable");
  return store;
};

const requireNotes = (store: NoteStore | undefined): NoteStore => {
  if (store === undefined) throw new Error("note store is unavailable");
  return store;
};

const validateMutablePatch = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  if (Object.keys(value).length === 0) throw new Error(`${label} patch cannot be empty`);
  const invalid = Object.keys(value).find(key => !allowed.includes(key));
  if (invalid !== undefined) throw new Error(`${label} patch contains unsupported field: ${invalid}`);
};

export const createRpcStoreHandler = (dependencies: RpcStoreDependencies) => {
  const persistConfig = dependencies.updateConfig ?? ((transform) => updateConfig(transform));
  const readJobs = dependencies.loadJobs ?? (() => loadJobs());
  const writeJobs = dependencies.saveJobs ?? (jobs => saveJobs(jobs));
  const skills = dependencies.loadSkills ?? loadSkills;
  const newId = dependencies.randomId ?? randomUUID;

  const mutateConfig = async (transform: (current: Readonly<AppConfig>) => AppConfig): Promise<AppConfig> => {
    const updated = await persistConfig(transform);
    dependencies.setConfig(updated);
    return updated;
  };

  const execute = async (command: ManagementCommand): Promise<unknown> => {
    switch (command.type) {
      case "config_get": return { config: cleanConfig(dependencies.getConfig()) };
      case "config_update": {
        if ("mcpServers" in command.patch) throw new Error("mcpServers must be changed with MCP commands");
        const updated = await mutateConfig(current => {
          const { activeMoaPreset, ...ordinaryPatch } = command.patch;
          const next = { ...current, ...ordinaryPatch } as AppConfig;
          if (activeMoaPreset === null) {
            const { activeMoaPreset: _removed, ...withoutActivePreset } = next;
            return withoutActivePreset as AppConfig;
          }
          return activeMoaPreset === undefined
            ? next
            : { ...next, activeMoaPreset } as AppConfig;
        });
        return { config: cleanConfig(updated) };
      }
      case "mcp_list": return { servers: safeMcpServers(dependencies.getConfig()) };
      case "mcp_upsert": {
        const updated = await mutateConfig(current => {
          const servers = parseMcpServers(current.mcpServers);
          const previous = servers[command.name];
          const env = { ...(previous?.env ?? {}) };
          for (const [key, value] of Object.entries(command.env ?? {})) {
            if (value === null) delete env[key]; else env[key] = value;
          }
          return {
            ...current,
            mcpServers: {
              ...servers,
              [command.name]: {
                command: command.command,
                args: command.args ?? previous?.args ?? [],
                ...(Object.keys(env).length === 0 ? {} : { env }),
              },
            },
          };
        });
        return { server: safeMcpServers(updated).find(server => server.name === command.name) };
      }
      case "mcp_remove": {
        if (parseMcpServers(dependencies.getConfig().mcpServers)[command.name] === undefined) throw new Error(`MCP server not found: ${command.name}`);
        await mutateConfig(current => {
          const servers = parseMcpServers(current.mcpServers);
          delete servers[command.name];
          return { ...current, mcpServers: servers };
        });
        return undefined;
      }
      case "cron_list": {
        const jobs = await readJobs();
        if (command.cursor === undefined && command.limit === undefined && command.editableOnly === undefined && command.maxPromptLength === undefined) {
          return { jobs };
        }
        const cursor = command.cursor ?? 0;
        const page = jobs.slice(cursor, cursor + (command.limit ?? jobs.length));
        const maxPromptLength = command.maxPromptLength;
        if (maxPromptLength !== undefined && page.some(job => job.prompt.length > maxPromptLength)) {
          throw new Error(`cron job prompt exceeds requested limit of ${maxPromptLength}`);
        }
        const projected = command.editableOnly === true
          ? page.map(({ id, schedule, prompt }) => ({ id, schedule, prompt }))
          : page;
        const nextCursor = cursor + page.length;
        return { jobs: projected, ...(nextCursor < jobs.length ? { nextCursor } : {}) };
      }
      case "cron_add": {
        const jobs = await readJobs();
        const job = validateJob({ id: command.jobId ?? newId(), schedule: command.schedule, prompt: command.prompt, lastRun: null }, "RPC cron command");
        if (jobs.some(item => item.id === job.id)) throw new Error(`cron job already exists: ${job.id}`);
        await writeJobs([...jobs, job]);
        return command.includeJob === false ? { jobId: job.id } : { job };
      }
      case "cron_update": {
        validateMutablePatch(command.patch as Record<string, unknown>, ["schedule", "prompt"], "cron");
        const jobs = await readJobs();
        const index = jobs.findIndex(job => job.id === command.jobId);
        if (index === -1) throw new Error(`cron job not found: ${command.jobId}`);
        const current = jobs[index]!;
        const job = validateJob({ ...current, ...command.patch }, "RPC cron command");
        const next = [...jobs]; next[index] = job;
        await writeJobs(next);
        return command.includeJob === false ? { jobId: job.id } : { job };
      }
      case "cron_remove": {
        const jobs = await readJobs();
        if (!jobs.some(job => job.id === command.jobId)) throw new Error(`cron job not found: ${command.jobId}`);
        await writeJobs(jobs.filter(job => job.id !== command.jobId));
        return undefined;
      }
      case "memory_list": return { memories: command.limit === undefined ? requireMemory(dependencies.memoryStore).all() : requireMemory(dependencies.memoryStore).recent(command.limit) };
      case "memory_search": return { memories: requireMemory(dependencies.memoryStore).search(command.query, command.limit) };
      case "memory_create": return { memory: requireMemory(dependencies.memoryStore).save(command.content, command.category) };
      case "memory_update": {
        validateMutablePatch(command.patch as Record<string, unknown>, ["content", "category"], "memory");
        const store = requireMemory(dependencies.memoryStore);
        const existing = store.all().find(memory => memory.id === command.memoryId);
        if (existing === undefined) throw new Error(`memory not found: ${command.memoryId}`);
        const content = command.patch.content ?? existing.content;
        const category = command.patch.category ?? existing.category;
        if (content.trim() === "" || category.trim() === "") throw new Error("memory content and category must be non-empty strings");
        return { memory: store.update(command.memoryId, content, category)! };
      }
      case "memory_delete": {
        if (!requireMemory(dependencies.memoryStore).delete(command.memoryId)) throw new Error(`memory not found: ${command.memoryId}`);
        return undefined;
      }
      case "notes_import": {
        const store = requireNotes(dependencies.noteStore);
        if (command.semantic) {
          if (dependencies.embedText === undefined) throw new Error("semantic note embedding is unavailable");
          return { imported: await store.importFolderWithEmbeddings(command.folderPath, dependencies.embedText) };
        }
        return { imported: store.importFolder(command.folderPath) };
      }
      case "notes_search": {
        const store = requireNotes(dependencies.noteStore);
        if (command.mode === "semantic") {
          if (dependencies.embedText === undefined) throw new Error("semantic note search is unavailable");
          return { notes: store.searchSemantic(await dependencies.embedText(command.query, "query"), command.limit) };
        }
        return { notes: store.search(command.query, command.limit) };
      }
      case "skills_list": return { skills: [...skills().values()].map(skill => ({ name: skill.name, description: skill.description, disableModelInvocation: skill.disableModelInvocation })) };
      case "skill_get": {
        const skill = skills().get(command.name);
        if (skill === undefined) throw new Error(`skill not found: ${command.name}`);
        return { skill: { name: skill.name, description: skill.description, disableModelInvocation: skill.disableModelInvocation, body: skill.loadBody() } };
      }
    }
  };
  let queue = Promise.resolve();
  return (command: ManagementCommand): Promise<unknown> => {
    const operation = queue.then(() => execute(command));
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  };
};
