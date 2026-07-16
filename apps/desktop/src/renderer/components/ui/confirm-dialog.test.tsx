// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(cleanup);

describe("ConfirmDialog", () => {
  it("keeps operation failures visible and locks dismissal while busy", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<ConfirmDialog
      open
      title="Remove server?"
      description="This cannot be undone."
      confirmLabel="Remove"
      busyLabel="Removing…"
      busy
      error="Removal failed"
      destructive
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
    />);

    expect(screen.getByRole("alert").textContent).toContain("Removal failed");
    expect((screen.getByRole("button", { name: "Removing…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
