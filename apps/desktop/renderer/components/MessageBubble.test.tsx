// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { MessageBubble } from "./MessageBubble.js";

describe("MessageBubble", () => {
  describe("user message", () => {
    it("renders YOU label", () => {
      render(<MessageBubble line={{ kind: "user", text: "Hello" }} />);
      expect(screen.getByText("YOU")).toBeInTheDocument();
    });

    it("has message--user class", () => {
      const { container } = render(<MessageBubble line={{ kind: "user", text: "Hello" }} />);
      expect(container.querySelector(".message--user")).not.toBeNull();
    });

    it("renders plain text body", () => {
      render(<MessageBubble line={{ kind: "user", text: "Hello world" }} />);
      expect(screen.getByText("Hello world")).toBeInTheDocument();
    });
  });

  describe("assistant message", () => {
    it("renders RAILGUN label", () => {
      render(<MessageBubble line={{ kind: "assistant", text: "Hi there" }} />);
      expect(screen.getByText("RAILGUN")).toBeInTheDocument();
    });

    it("has message--assistant class", () => {
      const { container } = render(<MessageBubble line={{ kind: "assistant", text: "Hi there" }} />);
      expect(container.querySelector(".message--assistant")).not.toBeNull();
    });

    it("renders Markdown — bold text produces <strong>", () => {
      const { container } = render(<MessageBubble line={{ kind: "assistant", text: "**bold**" }} />);
      expect(container.querySelector("strong")).not.toBeNull();
    });
  });

  describe("error message", () => {
    it("renders ERROR label", () => {
      render(<MessageBubble line={{ kind: "error", text: "Something went wrong" }} />);
      expect(screen.getByText("ERROR")).toBeInTheDocument();
    });

    it("has message--error class", () => {
      const { container } = render(<MessageBubble line={{ kind: "error", text: "fail" }} />);
      expect(container.querySelector(".message--error")).not.toBeNull();
    });

    it("renders plain text body", () => {
      render(<MessageBubble line={{ kind: "error", text: "fail message" }} />);
      expect(screen.getByText("fail message")).toBeInTheDocument();
    });
  });

  describe("advisory messages", () => {
    it("renders ADVISOR label", () => {
      render(<MessageBubble line={{ kind: "advisory", severity: "concern", text: "Watch out" }} />);
      expect(screen.getByText("ADVISOR")).toBeInTheDocument();
    });

    it("has message--advisory class", () => {
      const { container } = render(<MessageBubble line={{ kind: "advisory", severity: "concern", text: "Watch out" }} />);
      expect(container.querySelector(".message--advisory")).not.toBeNull();
    });

    it("has advisory--error modifier for blocker", () => {
      const { container } = render(<MessageBubble line={{ kind: "advisory", severity: "blocker", text: "Blocked" }} />);
      expect(container.querySelector(".advisory--error")).not.toBeNull();
    });

    it("has advisory--warning modifier for concern", () => {
      const { container } = render(<MessageBubble line={{ kind: "advisory", severity: "concern", text: "Caution" }} />);
      expect(container.querySelector(".advisory--warning")).not.toBeNull();
    });

    it("has advisory--success modifier for nit", () => {
      const { container } = render(<MessageBubble line={{ kind: "advisory", severity: "nit", text: "Minor" }} />);
      expect(container.querySelector(".advisory--success")).not.toBeNull();
    });
  });

  describe("tool kind", () => {
    it("delegates to ToolCallLine — renders tool-call class, not message class", () => {
      const { container } = render(<MessageBubble line={{ kind: "tool", text: "bash(ls)" }} />);
      expect(container.querySelector(".tool-call")).not.toBeNull();
      expect(container.querySelector(".message")).toBeNull();
    });

    it("pending tool renders tool-call--running", () => {
      const { container } = render(<MessageBubble line={{ kind: "tool", text: "bash(ls)", pending: true }} />);
      expect(container.querySelector(".tool-call--running")).not.toBeNull();
    });

    it("failed tool renders tool-call--error", () => {
      const { container } = render(<MessageBubble line={{ kind: "tool", text: "write(x)", failed: true }} />);
      expect(container.querySelector(".tool-call--error")).not.toBeNull();
    });

    it("completed tool renders tool-call--done", () => {
      const { container } = render(<MessageBubble line={{ kind: "tool", text: "read(y)" }} />);
      expect(container.querySelector(".tool-call--done")).not.toBeNull();
    });
  });

  describe("partial assistant (streaming)", () => {
    it("renders text and StreamingCursor when partial with text", () => {
      const { container } = render(<MessageBubble line={{ kind: "assistant", text: "Hello...", partial: true }} />);
      expect(container.textContent).toContain("Hello...");
      expect(container.querySelector(".streaming-cursor")).not.toBeNull();
    });
  });

  describe("partial assistant (thinking)", () => {
    it("renders Thinking text and StreamingCursor when partial with empty text", () => {
      const { container } = render(<MessageBubble line={{ kind: "assistant", text: "", partial: true }} />);
      expect(container.textContent).toContain("Thinking");
      expect(container.querySelector(".streaming-cursor")).not.toBeNull();
    });

    it("has thinking-text class on the thinking span", () => {
      const { container } = render(<MessageBubble line={{ kind: "assistant", text: "", partial: true }} />);
      expect(container.querySelector(".thinking-text")).not.toBeNull();
    });
  });
});
