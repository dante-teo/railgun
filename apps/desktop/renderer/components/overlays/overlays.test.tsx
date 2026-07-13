// @vitest-environment jsdom
import type React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DevinModel } from "widevin";
import { ModelPicker } from "./ModelPicker.js";
import { TrustPicker } from "./TrustPicker.js";
import { ClarifyPrompt } from "./ClarifyPrompt.js";
import { ShellApproval } from "./ShellApproval.js";
import { ActionPicker } from "./ActionPicker.js";
import { SessionChooser } from "./SessionChooser.js";
import { SettingsPanel } from "./SettingsPanel.js";

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  cleanup();
});

// ---------------------------------------------------------------------------
// ModelPicker
// ---------------------------------------------------------------------------
const MODELS = [
  { id: "claude-sonnet-4" },
  { id: "claude-opus-4" },
  { id: "gpt-4o" },
] as unknown as DevinModel[];

describe("ModelPicker", () => {
  it("renders all model ids", () => {
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={0}
        sessionOnly={false}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("claude-sonnet-4")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
  });

  it("ArrowDown calls onNavigate with next index", () => {
    const onNavigate = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={0}
        sessionOnly={false}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("ArrowDown clamps at last item", () => {
    const onNavigate = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={2}
        sessionOnly={false}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onNavigate).toHaveBeenCalledWith(2);
  });

  it("ArrowUp calls onNavigate with prev index", () => {
    const onNavigate = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={2}
        sessionOnly={false}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("ArrowUp clamps at 0", () => {
    const onNavigate = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={0}
        sessionOnly={false}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("Enter calls onConfirm with current index", () => {
    const onConfirm = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={1}
        sessionOnly={false}
        onNavigate={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(1);
  });

  it("Escape calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={0}
        sessionOnly={false}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("click on item calls onConfirm with that item index", () => {
    const onConfirm = vi.fn();
    render(
      <ModelPicker
        models={MODELS}
        selectedIndex={0}
        sessionOnly={false}
        onNavigate={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByText("gpt-4o")[0]);
    expect(onConfirm).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// TrustPicker
// ---------------------------------------------------------------------------
const TRUST_CHOICES = [
  { label: "Trust", value: "trust" as const },
  { label: "Trust (session)", value: "trust-session" as const },
  { label: "Do not trust", value: "deny" as const },
];

describe("TrustPicker", () => {
  it("renders all choice labels", () => {
    render(
      <TrustPicker
        choices={TRUST_CHOICES}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options.map(o => o.textContent)).toEqual(["Trust", "Trust (session)", "Do not trust"]);
  });

  it("ArrowDown wraps from last to first", () => {
    const onNavigate = vi.fn();
    render(
      <TrustPicker
        choices={TRUST_CHOICES}
        selectedIndex={2}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("ArrowUp wraps from first to last", () => {
    const onNavigate = vi.fn();
    render(
      <TrustPicker
        choices={TRUST_CHOICES}
        selectedIndex={0}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(onNavigate).toHaveBeenCalledWith(2);
  });

  it("Enter calls onConfirm with current index", () => {
    const onConfirm = vi.fn();
    render(
      <TrustPicker
        choices={TRUST_CHOICES}
        selectedIndex={1}
        onNavigate={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(1);
  });

  it("Escape calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <TrustPicker
        choices={TRUST_CHOICES}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ClarifyPrompt — choices mode
// ---------------------------------------------------------------------------
const CLARIFY_CHOICES = ["Option A", "Option B", "Option C"];

describe("ClarifyPrompt (choices mode)", () => {
  it("renders question and choice strings", () => {
    render(
      <ClarifyPrompt
        question="Which way?"
        choices={CLARIFY_CHOICES}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Which way?")).toBeInTheDocument();
    expect(screen.getByText("Option A")).toBeInTheDocument();
    expect(screen.getByText("Option B")).toBeInTheDocument();
    expect(screen.getByText("Option C")).toBeInTheDocument();
  });

  it("ArrowDown moves selection highlight", () => {
    render(
      <ClarifyPrompt
        question="Which way?"
        choices={CLARIFY_CHOICES}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    // After rerender, option 1 should be selected; check by aria-selected
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });

  it("ArrowUp moves selection highlight", () => {
    render(
      <ClarifyPrompt
        question="Which way?"
        choices={CLARIFY_CHOICES}
        onAnswer={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("Enter calls onAnswer with selected choice text", () => {
    const onAnswer = vi.fn();
    render(
      <ClarifyPrompt
        question="Which way?"
        choices={CLARIFY_CHOICES}
        onAnswer={onAnswer}
        onDismiss={vi.fn()}
      />,
    );
    // selectedIndex starts at 0
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith("Option A");
  });

  it("Escape calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <ClarifyPrompt
        question="Which way?"
        choices={CLARIFY_CHOICES}
        onAnswer={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ClarifyPrompt — free-text mode
// ---------------------------------------------------------------------------
describe("ClarifyPrompt (free-text mode)", () => {
  it("renders question and a text input", () => {
    render(
      <ClarifyPrompt question="What is the target?" onAnswer={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText("What is the target?")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("input is auto-focused on mount", () => {
    render(
      <ClarifyPrompt question="What?" onAnswer={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getByRole("textbox")).toHaveFocus();
  });

  it("typing + Enter calls onAnswer with typed text", () => {
    const onAnswer = vi.fn();
    render(
      <ClarifyPrompt question="What?" onAnswer={onAnswer} onDismiss={vi.fn()} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "my answer" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAnswer).toHaveBeenCalledWith("my answer");
  });

  it("Escape calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <ClarifyPrompt question="What?" onAnswer={vi.fn()} onDismiss={onDismiss} />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ShellApproval
// ---------------------------------------------------------------------------
describe("ShellApproval", () => {
  it("renders the command", () => {
    render(
      <ShellApproval command="rm -rf /tmp" onApprove={vi.fn()} onDeny={vi.fn()} />,
    );
    expect(screen.getByText("rm -rf /tmp")).toBeInTheDocument();
  });

  it("y key calls onApprove", () => {
    const onApprove = vi.fn();
    render(
      <ShellApproval command="echo hi" onApprove={onApprove} onDeny={vi.fn()} />,
    );
    fireEvent.keyDown(document, { key: "y" });
    expect(onApprove).toHaveBeenCalled();
  });

  it("n key calls onDeny", () => {
    const onDeny = vi.fn();
    render(
      <ShellApproval command="echo hi" onApprove={vi.fn()} onDeny={onDeny} />,
    );
    fireEvent.keyDown(document, { key: "n" });
    expect(onDeny).toHaveBeenCalled();
  });

  it("Escape calls onDeny", () => {
    const onDeny = vi.fn();
    render(
      <ShellApproval command="echo hi" onApprove={vi.fn()} onDeny={onDeny} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDeny).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ActionPicker
// ---------------------------------------------------------------------------
const ACTION_ITEMS = [
  { id: "a", label: "Alpha", detail: "first" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma", detail: "third", current: true },
];

describe("ActionPicker", () => {
  it("renders title and item labels", () => {
    render(
      <ActionPicker
        title="Settings"
        items={ACTION_ITEMS}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("renders detail text when present", () => {
    render(
      <ActionPicker
        title="Settings"
        items={ACTION_ITEMS}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("third")).toBeInTheDocument();
  });

  it("ArrowDown calls onNavigate clamped", () => {
    const onNavigate = vi.fn();
    render(
      <ActionPicker
        title="Settings"
        items={ACTION_ITEMS}
        selectedIndex={0}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("ArrowUp clamps at 0", () => {
    const onNavigate = vi.fn();
    render(
      <ActionPicker
        title="Settings"
        items={ACTION_ITEMS}
        selectedIndex={0}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("Enter calls onConfirm with current index", () => {
    const onConfirm = vi.fn();
    render(
      <ActionPicker
        title="Settings"
        items={ACTION_ITEMS}
        selectedIndex={1}
        onNavigate={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(1);
  });

  it("Escape calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <ActionPicker
        title="Settings"
        items={ACTION_ITEMS}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SessionChooser
// ---------------------------------------------------------------------------
const SESSIONS = [
  { id: "s1", preview: "First session preview", date: "2025-07-10" },
  { id: "s2", preview: "Second session preview", date: "2025-07-11" },
  { id: "s3", preview: "Third session preview", date: "2025-07-12" },
];

describe("SessionChooser", () => {
  it("renders session previews and dates", () => {
    render(
      <SessionChooser
        sessions={SESSIONS}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("First session preview")).toBeInTheDocument();
    expect(screen.getByText("2025-07-10")).toBeInTheDocument();
    expect(screen.getByText("Second session preview")).toBeInTheDocument();
    expect(screen.getByText("2025-07-11")).toBeInTheDocument();
  });

  it("ArrowDown calls onNavigate with wrapping", () => {
    const onNavigate = vi.fn();
    render(
      <SessionChooser
        sessions={SESSIONS}
        selectedIndex={2}
        onNavigate={onNavigate}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("Ctrl+C calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <SessionChooser
        sessions={SESSIONS}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "c", ctrlKey: true });
    expect(onCancel).toHaveBeenCalled();
  });

  it("Enter calls onConfirm with current index", () => {
    const onConfirm = vi.fn();
    render(
      <SessionChooser
        sessions={SESSIONS}
        selectedIndex={1}
        onNavigate={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// SettingsPanel
// ---------------------------------------------------------------------------

const SETTINGS_DEFAULTS = {
  approvalMode: "smart" as const,
  reviewerModel: null,
  activeMoaPreset: null,
  moaPresetNames: [] as string[],
  advisorEnabled: false,
  advisorModel: null,
  availableModels: ["claude-opus-4", "gpt-4o"],
  theme: "dark" as const,
  selectedIndex: 0,
};

describe("SettingsPanel", () => {
  it("renders top-level menu with all 5 items and detail text", () => {
    render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        onNavigate={vi.fn()}
        onUpdateConfig={vi.fn()}
        onToggleTheme={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Approval mode")).toBeInTheDocument();
    expect(screen.getByText("Reviewer model")).toBeInTheDocument();
    expect(screen.getByText("MoA preset")).toBeInTheDocument();
    expect(screen.getByText("Advisor")).toBeInTheDocument();
    expect(screen.getByText("Theme")).toBeInTheDocument();
    // detail text
    expect(screen.getByText("smart")).toBeInTheDocument();
    expect(screen.getAllByText("Off").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("dark")).toBeInTheDocument();
  });

  it("ArrowDown calls onNavigate with next index", () => {
    const onNavigate = vi.fn();
    render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        selectedIndex={0}
        onNavigate={onNavigate}
        onUpdateConfig={vi.fn()}
        onToggleTheme={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("Escape on top level calls onCancel", () => {
    const onCancel = vi.fn();
    render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        onNavigate={vi.fn()}
        onUpdateConfig={vi.fn()}
        onToggleTheme={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("Enter on Approval mode opens sub-view", () => {
    const onNavigate = vi.fn();
    render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        selectedIndex={0}
        onNavigate={onNavigate}
        onUpdateConfig={vi.fn()}
        onToggleTheme={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByText("Settings · Approval mode")).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("smart")).toBeInTheDocument();
    expect(screen.getByText("off")).toBeInTheDocument();
  });

  it("Escape in sub-view returns to top menu", () => {
    const onNavigate = vi.fn();
    render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        selectedIndex={0}
        onNavigate={onNavigate}
        onUpdateConfig={vi.fn()}
        onToggleTheme={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Enter sub-view
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByText("Settings · Approval mode")).toBeInTheDocument();
    // Escape back
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Approval mode")).toBeInTheDocument();
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("Enter in approval sub-view calls onUpdateConfig", () => {
    const onUpdateConfig = vi.fn();
    const onNavigate = vi.fn();
    // Render with selectedIndex=0 pointing at Approval mode
    const { rerender } = render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        selectedIndex={0}
        onNavigate={onNavigate}
        onUpdateConfig={onUpdateConfig}
        onToggleTheme={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Open approval sub-view
    fireEvent.keyDown(document, { key: "Enter" });
    // Now selectedIndex=0 → "manual"; navigate to "off" (index 2)
    rerender(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        selectedIndex={2}
        onNavigate={onNavigate}
        onUpdateConfig={onUpdateConfig}
        onToggleTheme={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onUpdateConfig).toHaveBeenCalledWith({ approvalMode: "off" });
  });

  it("Enter on Theme calls onToggleTheme without entering a sub-view", () => {
    const onToggleTheme = vi.fn();
    render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        selectedIndex={4}
        onNavigate={vi.fn()}
        onUpdateConfig={vi.fn()}
        onToggleTheme={onToggleTheme}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onToggleTheme).toHaveBeenCalled();
    // Still on top-level menu
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.queryByText("Settings · Theme")).not.toBeInTheDocument();
  });

  it("clicking a top-level item navigates to its sub-view", () => {
    render(
      <SettingsPanel
        {...SETTINGS_DEFAULTS}
        selectedIndex={0}
        onNavigate={vi.fn()}
        onUpdateConfig={vi.fn()}
        onToggleTheme={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // Click "Reviewer model" row
    fireEvent.click(screen.getByText("Reviewer model"));
    expect(screen.getByText("Settings · Reviewer model")).toBeInTheDocument();
  });
});
