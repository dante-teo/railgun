// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { ToolCallLine } from "./ToolCallLine.js";

describe("ToolCallLine", () => {
  it("renders the running glyph ⏺ and has tool-call--running class", () => {
    const { container } = render(<ToolCallLine label="bash(ls)" state="running" />);
    expect(container.textContent).toContain("⏺");
    expect(container.textContent).toContain("bash(ls)");
    expect(container.querySelector(".tool-call--running")).not.toBeNull();
  });

  it("renders the done glyph ✔ and has tool-call--done class", () => {
    const { container } = render(<ToolCallLine label="read(x)" state="done" />);
    expect(container.textContent).toContain("✔");
    expect(container.querySelector(".tool-call--done")).not.toBeNull();
  });

  it("renders the error glyph ✘ and has tool-call--error class", () => {
    const { container } = render(<ToolCallLine label="write(y)" state="error" />);
    expect(container.textContent).toContain("✘");
    expect(container.querySelector(".tool-call--error")).not.toBeNull();
  });

  it("has role='status' for accessibility", () => {
    render(<ToolCallLine label="bash(ls)" state="running" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
