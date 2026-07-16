// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateCheckPage } from "./UpdateCheckPage";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./components/ui/dialog";
import { SearchField } from "./components/ui/form";
import { SegmentedControl, SegmentedControlItem } from "./components/ui/radio-group";
import { EmptyState, ErrorState, LoadingState } from "./components/ui/state";
import { Switch } from "./components/ui/switch";

afterEach(cleanup);
const audit = async (): Promise<void> => {
  const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
  expect(result.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([]);
};

describe("representative renderer accessibility", () => {
  it("passes automated checks for forms, selection controls, and shared states", async () => {
    render(<main aria-label="Settings sample">
      <SearchField aria-label="Search settings" />
      <label>Background automation <Switch /></label>
      <SegmentedControl aria-label="Approval mode" defaultValue="manual"><SegmentedControlItem value="manual">Manual</SegmentedControlItem><SegmentedControlItem value="smart">Smart</SegmentedControlItem></SegmentedControl>
      <LoadingState title="Loading" /><EmptyState title="Empty" /><ErrorState title="Error" />
    </main>);
    await audit();
  });

  it("passes automated checks for focus-trapped dialogs", async () => {
    render(<Dialog><DialogTrigger asChild><Button>Open</Button></DialogTrigger><DialogContent><DialogTitle>Confirm action</DialogTitle><DialogDescription>Review this action.</DialogDescription><Button>Continue</Button></DialogContent></Dialog>);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Confirm action" })).toBeTruthy();
    await audit();
  });

  it("passes automated checks for the update-check surface", async () => {
    render(<UpdateCheckPage />);
    await audit();
  });
});
