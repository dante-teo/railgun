// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer, RailgunDesktopApi } from "../../shared/types";
import { McpSettingsPanel } from "./McpSettingsPanel";

afterEach(cleanup);
const server: McpServer = { name: "docs", command: "docs-server", args: ["--stdio", "--format"], env: [{ name: "TOKEN", present: true }] };

describe("McpSettingsPanel", () => {
  it("masks stored values, retains unchanged secrets, and keeps immutable names", async () => {
    const upsertMcpServer = vi.fn(async () => [server]);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listMcpServers: async () => [server], upsertMcpServer, removeMcpServer: vi.fn(),
    } as unknown as RailgunDesktopApi });
    render(<McpSettingsPanel />);
    expect(await screen.findByText("Saved secret")).toBeTruthy();
    expect(document.body.textContent).not.toContain("stored-value");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Environment value 1") as HTMLInputElement).placeholder).toBe("Saved secret");
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledWith({ name: "docs", command: "docs-server", args: ["--stdio", "--format"], env: [] }));
  });

  it("validates duplicate keys and confirms deletion", async () => {
    const removeMcpServer = vi.fn(async () => []);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listMcpServers: async () => [server], upsertMcpServer: vi.fn(), removeMcpServer,
    } as unknown as RailgunDesktopApi });
    render(<McpSettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Add environment variable" }));
    fireEvent.change(screen.getByLabelText("Environment key 2"), { target: { value: "TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    expect(await screen.findByText("Environment keys must be unique.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("dialog", { name: "Remove docs?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove server" }));
    await waitFor(() => expect(removeMcpServer).toHaveBeenCalledWith("docs"));
  });

  it("rejects an add draft that would overwrite an existing server", async () => {
    const upsertMcpServer = vi.fn(async () => [server]);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listMcpServers: async () => [server], upsertMcpServer, removeMcpServer: vi.fn(),
    } as unknown as RailgunDesktopApi });
    render(<McpSettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " docs " } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "other-server" } });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    expect(await screen.findByText("A server named docs already exists. Edit it instead.")).toBeTruthy();
    expect(upsertMcpServer).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add MCP server" })).toBeTruthy();
  });

  it("sends an explicitly edited empty string for a saved environment value", async () => {
    const upsertMcpServer = vi.fn(async () => [server]);
    Object.defineProperty(window, "railgunDesktop", { configurable: true, value: {
      listMcpServers: async () => [server], upsertMcpServer, removeMcpServer: vi.fn(),
    } as unknown as RailgunDesktopApi });
    render(<McpSettingsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const value = screen.getByLabelText("Environment value 1");
    fireEvent.change(value, { target: { value: "temporary" } });
    fireEvent.change(value, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(upsertMcpServer).toHaveBeenCalledWith({
      name: "docs", command: "docs-server", args: ["--stdio", "--format"], env: [{ name: "TOKEN", value: "" }],
    }));
  });
});
