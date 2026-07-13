// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";

import { Transcript } from "./Transcript.js";
import type { DisplayLine } from "@railgun/core/repl/App.js";

// scrollIntoView is not implemented in jsdom
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

const LINES: readonly DisplayLine[] = [
  { kind: "user", text: "Hello" },
  { kind: "assistant", text: "Hi back" },
  { kind: "tool", text: "bash(ls)" },
];

describe("Transcript", () => {
  it("renders all lines as MessageBubble components", () => {
    render(<Transcript lines={LINES} streaming="" busy={false} />);
    expect(screen.getByText("YOU")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("RAILGUN")).toBeInTheDocument();
    expect(screen.getByText("Hi back")).toBeInTheDocument();
    expect(screen.getByText("bash(ls)")).toBeInTheDocument();
  });

  it("shows streaming assistant line when busy and streaming text present", () => {
    const { container } = render(
      <Transcript lines={[]} streaming="Thinking out loud..." busy={true} />
    );
    expect(container.textContent).toContain("Thinking out loud...");
    expect(container.querySelector(".streaming-cursor")).not.toBeNull();
  });

  it("shows thinking indicator when busy and no streaming text", () => {
    const { container } = render(
      <Transcript lines={[]} streaming="" busy={true} />
    );
    expect(container.textContent).toContain("Thinking");
    expect(container.querySelector(".thinking-text")).not.toBeNull();
  });

  it("does NOT show streaming or thinking when not busy", () => {
    const { container } = render(
      <Transcript lines={LINES} streaming="" busy={false} />
    );
    expect(container.querySelector(".thinking-text")).toBeNull();
    // No extra streaming cursor beyond committed lines
    expect(container.querySelectorAll(".streaming-cursor").length).toBe(0);
  });

  it("has role='log' and aria-live='polite'", () => {
    const { container } = render(<Transcript lines={[]} streaming="" busy={false} />);
    const log = container.querySelector("[role='log']");
    expect(log).not.toBeNull();
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  it("unseen pill appears when new lines arrive while scrolled up", () => {
    const { container, rerender } = render(
      <Transcript lines={LINES} streaming="" busy={false} />
    );

    // Simulate scrolling up (not at bottom)
    const scrollEl = container.querySelector(".transcript")!;
    Object.defineProperty(scrollEl, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scrollEl, "scrollTop", { value: 0, configurable: true });
    Object.defineProperty(scrollEl, "clientHeight", { value: 200, configurable: true });
    fireEvent.scroll(scrollEl);

    // Add a new line
    rerender(
      <Transcript
        lines={[...LINES, { kind: "assistant", text: "New message" }]}
        streaming=""
        busy={false}
      />
    );

    const pill = container.querySelector(".transcript__unseen-pill");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("new");
  });
});
