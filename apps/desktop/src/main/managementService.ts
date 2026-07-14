import { z } from "zod";
import {
  McpServerListSchema,
  McpServerNameSchema,
  McpServerSchema,
  McpServerUpsertSchema,
  SkillDetailSchema,
  SkillNameSchema,
  SkillSummaryListSchema,
} from "../shared/schemas";
import type { McpServer, McpServerUpsert, SkillDetail, SkillSummary } from "../shared/types";
import type { BackendRpcCommand } from "./backendSupervisor";
import type { MutationQueue } from "./mutationQueue";

interface ManagementBackend {
  call<T>(command: BackendRpcCommand, validate: (data: unknown) => T): Promise<T>;
}

const skillListResponse = z.strictObject({ skills: SkillSummaryListSchema });
const skillDetailResponse = z.strictObject({ skill: SkillDetailSchema });
const mcpListResponse = z.strictObject({ servers: McpServerListSchema });
const mcpMutationResponse = z.strictObject({ server: McpServerSchema });

export const redactMcpCommand = (command: string): string => {
  const segments = command.split(/[\\/]/u).filter(Boolean);
  return segments.length > 1 ? segments.at(-1)! : command;
};

const projectServers = (servers: readonly McpServer[]): readonly McpServer[] =>
  McpServerListSchema.parse(servers.map(server => ({ ...server, command: redactMcpCommand(server.command) })));

export const createManagementService = (backend: ManagementBackend, mutations: MutationQueue) => {
  const listSkills = async (): Promise<readonly SkillSummary[]> =>
    (await backend.call({ type: "skills_list" }, value => skillListResponse.parse(value))).skills;

  const getSkill = async (rawName: string): Promise<SkillDetail> => {
    const name = SkillNameSchema.parse(rawName);
    return (await backend.call({ type: "skill_get", name }, value => skillDetailResponse.parse(value))).skill;
  };

  const listMcpServers = async (): Promise<readonly McpServer[]> => {
    const response = await backend.call({ type: "mcp_list" }, value => mcpListResponse.parse(value));
    return projectServers(response.servers);
  };

  const upsertMcpServer = (rawServer: McpServerUpsert): Promise<readonly McpServer[]> => mutations.run(async () => {
    const server = McpServerUpsertSchema.parse(rawServer);
    const current = (await backend.call({ type: "mcp_list" }, value => mcpListResponse.parse(value))).servers
      .find(item => item.name === server.name);
    const command = current !== undefined && redactMcpCommand(current.command) === server.command
      ? current.command : server.command;
    const env = Object.fromEntries(server.env.map(entry => [entry.name, entry.value]));
    await backend.call({ type: "mcp_upsert", name: server.name, command, args: server.args, env }, value => mcpMutationResponse.parse(value));
    return listMcpServers();
  });

  const removeMcpServer = (rawName: string): Promise<readonly McpServer[]> => mutations.run(async () => {
    const name = McpServerNameSchema.parse(rawName);
    await backend.call({ type: "mcp_remove", name }, value => z.undefined().parse(value));
    return listMcpServers();
  });

  return { listSkills, getSkill, listMcpServers, upsertMcpServer, removeMcpServer };
};
