import { describe, expect, it, vi } from "vitest";
import { createMutationQueue } from "./mutationQueue";
import { createManagementService, redactMcpCommand } from "./managementService";

const harness = () => {
  let servers = [{ name: "docs", command: "/private/tools/docs", args: ["--stdio"], env: [{ name: "TOKEN", present: true as const }] }];
  const secrets: Record<string, string> = { TOKEN: "stored-secret" };
  const calls: Record<string, unknown>[] = [];
  const backend = { call: async <T,>(command: Record<string, unknown>, validate: (value: unknown) => T): Promise<T> => {
    calls.push(command);
    if (command.type === "skills_list") return validate({ skills: [{ name: "testing", description: "Test safely", disableModelInvocation: false }] });
    if (command.type === "skill_get") return validate({ skill: { name: "testing", description: "Test safely", disableModelInvocation: false, body: "# Test" } });
    if (command.type === "mcp_list") return validate({ servers });
    if (command.type === "mcp_upsert") {
      const env = command.env as Record<string, string | null>;
      for (const [name, value] of Object.entries(env)) value === null ? delete secrets[name] : secrets[name] = value;
      servers = [{ name: command.name as string, command: command.command as string, args: command.args as string[], env: Object.keys(secrets).map(name => ({ name, present: true as const })) }];
      return validate({ server: servers[0] });
    }
    if (command.type === "mcp_remove") { servers = []; return validate(undefined); }
    throw new Error("unexpected command");
  } };
  return { service: createManagementService(backend, createMutationQueue()), calls, secrets };
};

describe("desktop management service", () => {
  it("projects bounded skills without paths", async () => {
    const { service } = harness();
    await expect(service.listSkills()).resolves.toEqual([{ name: "testing", description: "Test safely", disableModelInvocation: false }]);
    await expect(service.getSkill("testing")).resolves.toMatchObject({ body: "# Test" });
  });

  it("redacts path-like commands and never projects environment values", async () => {
    const { service } = harness();
    expect(redactMcpCommand("C:\\tools\\server.exe")).toBe("server.exe");
    const result = await service.listMcpServers();
    expect(result[0]).toMatchObject({ command: "docs", env: [{ name: "TOKEN", present: true }] });
    expect(JSON.stringify(result)).not.toContain("stored-secret");
  });

  it("retains hidden commands and applies retain, replace, and delete secret semantics", async () => {
    const { service, calls, secrets } = harness();
    await service.upsertMcpServer({ name: "docs", command: "docs", args: ["--stdio", "--verbose"], env: [] });
    expect(calls).toContainEqual({ type: "mcp_upsert", name: "docs", command: "/private/tools/docs", args: ["--stdio", "--verbose"], env: {} });
    expect(secrets.TOKEN).toBe("stored-secret");
    await service.upsertMcpServer({ name: "docs", command: "docs", args: [], env: [{ name: "TOKEN", value: "replacement" }, { name: "REGION", value: "us" }] });
    expect(secrets).toEqual({ TOKEN: "replacement", REGION: "us" });
    await service.upsertMcpServer({ name: "docs", command: "docs", args: [], env: [{ name: "TOKEN", value: null }] });
    expect(secrets).toEqual({ REGION: "us" });
  });

  it("serializes MCP mutations", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = createMutationQueue();
    const first = queue.run(async () => { order.push("first-start"); await gate; order.push("first-end"); });
    const backend = { call: async <T,>(command: Record<string, unknown>, validate: (value: unknown) => T): Promise<T> => validate(command.type === "mcp_list" ? { servers: [] } : undefined) };
    const remove = createManagementService(backend, queue).removeMcpServer("docs").then(() => order.push("remove"));
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    release(); await Promise.all([first, remove]);
    expect(order).toEqual(["first-start", "first-end", "remove"]);
  });
});
