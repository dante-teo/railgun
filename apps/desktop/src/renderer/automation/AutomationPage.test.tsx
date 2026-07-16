// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundAutomationStatus, CronJob, RailgunDesktopApi } from "../../shared/types";
import { AutomationPage } from "./AutomationPage";

afterEach(cleanup);

const job: CronJob = {
  id: "job-1",
  schedule: "0 9 * * 1-5",
  summary: "At 09:00, Monday through Friday",
  prompt: "Plan the day",
};

type CronApi = Pick<RailgunDesktopApi, "listCronJobs" | "createCronJob" | "updateCronJob" | "deleteCronJob" | "getAutomationStatus" | "enableAutomation" | "disableAutomation" | "repairAutomation">;

const automation: BackgroundAutomationStatus = { state: "disabled", enabled: false, scheduler: "stopped", dream: "stopped", message: "Background automation is off." };

const installApi = (overrides: Partial<CronApi> = {}): CronApi => {
  const api = {
    listCronJobs: vi.fn(async () => [job] as readonly CronJob[]),
    createCronJob: vi.fn(async (input) => ({ id: "job-2", summary: "At 10:00", ...input })),
    updateCronJob: vi.fn(async (id, input) => ({ id, summary: "At 10:00", ...input })),
    deleteCronJob: vi.fn(async () => undefined),
    getAutomationStatus: vi.fn(async () => automation),
    enableAutomation: vi.fn(async () => ({ ...automation, state: "enabled" as const, enabled: true })),
    disableAutomation: vi.fn(async () => automation),
    repairAutomation: vi.fn(async () => ({ ...automation, state: "enabled" as const, enabled: true })),
    ...overrides,
  } as CronApi;
  Object.defineProperty(window, "railgunDesktop", { configurable: true, value: api });
  return api;
};

describe("Scheduled page", () => {
  it("controls the two opt-in background services without exposing launchctl", async () => {
    const api = installApi();
    render(<AutomationPage backendPhase="ready" />);
    await waitFor(() => expect(api.getAutomationStatus).toHaveBeenCalledOnce());
    const toggle = screen.getByRole("checkbox", { name: "Enable background automation" });
    expect(screen.getByText(/scheduled prompts and nightly maintenance/u)).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.enableAutomation).toHaveBeenCalledOnce());
  });

  it("renders disconnected, loading, empty, and retryable error states", async () => {
    const disconnected = installApi();
    const view = render(<AutomationPage backendPhase="disconnected" />);
    expect(screen.getByRole("heading", { name: "Scheduled jobs are unavailable" })).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect(create.closest(".content-toolbar-actions")).not.toBeNull();
    expect(create.className).toContain("ui-button-sm");
    expect(disconnected.listCronJobs).not.toHaveBeenCalled();
    view.unmount();

    let resolve!: (jobs: readonly CronJob[]) => void;
    installApi({ listCronJobs: vi.fn(() => new Promise<readonly CronJob[]>(value => { resolve = value; })) });
    const loading = render(<AutomationPage backendPhase="ready" />);
    expect(await screen.findByRole("heading", { name: "Loading scheduled jobs…" })).toBeTruthy();
    resolve([]);
    expect(await screen.findByRole("heading", { name: "No scheduled jobs yet" })).toBeTruthy();
    loading.unmount();

    const listCronJobs = vi.fn().mockRejectedValueOnce(new Error("store failed")).mockResolvedValueOnce([]);
    installApi({ listCronJobs });
    render(<AutomationPage backendPhase="ready" />);
    expect(await screen.findByText("store failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "No scheduled jobs yet" })).toBeTruthy();
    expect(listCronJobs).toHaveBeenCalledTimes(2);
  });

  it("validates and completes create, edit, and confirmed delete operations", async () => {
    const updateCronJob = vi.fn()
      .mockRejectedValueOnce(new Error("update failed"))
      .mockImplementation(async (id: string, input: { schedule: string; prompt: string }) => ({ id, summary: "At 10:00", ...input }));
    const deleteCronJob = vi.fn().mockRejectedValueOnce(new Error("delete failed")).mockResolvedValueOnce(undefined);
    const api = installApi({ updateCronJob, deleteCronJob });
    render(<AutomationPage backendPhase="ready" />);
    expect(await screen.findByText("Plan the day")).toBeTruthy();
    expect(screen.getByText("0 9 * * 1-5")).toBeTruthy();
    expect(screen.getByText("Plan the day").closest("li")?.querySelector(".lucide-clock")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const createButton = screen.getByRole("button", { name: "Create" });
    expect(screen.getByRole("textbox", { name: "Schedule" }).classList.contains("automation-schedule-input")).toBe(true);
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "  Check releases  " } });
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule" }), { target: { value: "0 0 9 * * *" } });
    expect((createButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule" }), { target: { value: " 0  10 * * * " } });
    expect(screen.getByText(/10:00/u)).toBeTruthy();
    fireEvent.click(createButton);
    await waitFor(() => expect(api.createCronJob).toHaveBeenCalledWith({ schedule: "0 10 * * *", prompt: "Check releases" }));
    expect(await screen.findByText("Check releases")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit Plan the day" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule" }), { target: { value: "0 10 * * 1-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("update failed")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Edit scheduled job" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCronJob).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Delete Plan the day" }));
    expect(screen.getByRole("dialog", { name: "Delete scheduled job?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("delete failed")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delete scheduled job?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteCronJob).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Plan the day")).toBeNull();
  });

  it("ignores a stale load after the backend reconnects", async () => {
    let resolveFirst!: (jobs: readonly CronJob[]) => void;
    const listCronJobs = vi.fn()
      .mockImplementationOnce(() => new Promise<readonly CronJob[]>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([]);
    installApi({ listCronJobs });
    const view = render(<AutomationPage backendPhase="ready" />);
    await waitFor(() => expect(listCronJobs).toHaveBeenCalledOnce());
    view.rerender(<AutomationPage backendPhase="disconnected" />);
    view.rerender(<AutomationPage backendPhase="ready" />);
    expect(await screen.findByRole("heading", { name: "No scheduled jobs yet" })).toBeTruthy();
    await act(async () => { resolveFirst([job]); });
    expect(screen.queryByText("Plan the day")).toBeNull();
  });

  it("does not let an outstanding load overwrite a successful creation", async () => {
    let resolveList!: (jobs: readonly CronJob[]) => void;
    const listCronJobs = vi.fn(() => new Promise<readonly CronJob[]>(resolve => { resolveList = resolve; }));
    installApi({ listCronJobs });
    render(<AutomationPage backendPhase="ready" />);
    expect(await screen.findByRole("heading", { name: "Loading scheduled jobs…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "New automation" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Schedule" }), { target: { value: "0 10 * * *" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("New automation")).toBeTruthy();
    await act(async () => { resolveList([]); });
    expect(screen.getByText("New automation")).toBeTruthy();
  });
});
