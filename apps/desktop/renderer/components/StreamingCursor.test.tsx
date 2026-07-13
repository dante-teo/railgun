// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { StreamingCursor } from "./StreamingCursor.js";

describe("StreamingCursor", () => {
  it("renders the streaming cursor glyph ▌", () => {
    const { container } = render(<StreamingCursor />);
    expect(container.textContent).toBe("▌");
  });

  it("has aria-hidden='true'", () => {
    const { container } = render(<StreamingCursor />);
    const span = container.querySelector("span");
    expect(span).toHaveAttribute("aria-hidden", "true");
  });

  it("has class streaming-cursor", () => {
    const { container } = render(<StreamingCursor />);
    const span = container.querySelector("span");
    expect(span).toHaveClass("streaming-cursor");
  });
});
