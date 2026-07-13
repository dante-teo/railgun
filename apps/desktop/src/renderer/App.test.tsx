// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BackendStatus, MockPanel } from "./App";
import type { BackendPhase, BackendSnapshot } from "../shared/types";

const snapshot = (phase: BackendPhase): BackendSnapshot => ({
  mode: "mock",
  phase,
  scenarioId: "ready-idle",
  ...(phase === "failed" || phase === "disconnected" ? { error: "backend unavailable" } : {}),
  diagnostics: phase === "failed" ? ["diagnostic detail"] : [],
  transportLog: [{ direction: "system", text: "Starting backend" }],
});

describe("BackendStatus", () => {
  it.each([
    ["starting", "Starting Railgun"],
    ["ready", "Railgun is ready"],
    ["failed", "Railgun could not start"],
    ["disconnected", "Railgun disconnected"],
  ] as const)("renders the %s screen", (phase, title) => {
    render(<BackendStatus snapshot={snapshot(phase)} />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    if (phase === "failed") expect(screen.getByText("diagnostic detail")).toBeTruthy();
  });
});

describe("MockPanel", () => {
  it("renders scenarios and restarts the selected backend", () => {
    const onSelect = vi.fn(async () => undefined);
    render(<MockPanel
      snapshot={snapshot("ready")}
      scenarios={[
        { id: "ready-idle", label: "Ready / idle", description: "Ready now" },
        { id: "delayed-startup", label: "Delayed startup", description: "Ready later" },
      ]}
      onSelect={onSelect}
    />);

    expect(screen.getByRole("combobox", { name: "Mock scenario" })).toBeTruthy();
    expect(screen.getByText("Ready now")).toBeTruthy();
    expect(screen.getByText("Starting backend")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart backend" }));
    expect(onSelect).toHaveBeenCalledWith("ready-idle");
  });
});
