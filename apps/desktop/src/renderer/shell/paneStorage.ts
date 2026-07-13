export const PANE_STORAGE_KEY = "railgun.shell.panes";
export const PANE_STORAGE_VERSION = 1;

export const PANE_WIDTHS = {
  sidebar: { default: 238, min: 208, max: 360 },
  inspector: { default: 320, min: 240, max: 420 },
} as const;

export interface PaneWidths {
  readonly sidebar: number;
  readonly inspector: number;
}

const defaults = (): PaneWidths => ({
  sidebar: PANE_WIDTHS.sidebar.default,
  inspector: PANE_WIDTHS.inspector.default,
});

const validWidth = (value: unknown, range: { readonly min: number; readonly max: number }): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= range.min && value <= range.max;

export const readPaneWidths = (storage: Pick<Storage, "getItem">): PaneWidths => {
  try {
    const stored: unknown = JSON.parse(storage.getItem(PANE_STORAGE_KEY) ?? "null");
    if (
      typeof stored !== "object" || stored === null
      || Object.keys(stored).sort().join(",") !== "inspector,sidebar,version"
      || !("version" in stored) || stored.version !== PANE_STORAGE_VERSION
      || !("sidebar" in stored) || !validWidth(stored.sidebar, PANE_WIDTHS.sidebar)
      || !("inspector" in stored) || !validWidth(stored.inspector, PANE_WIDTHS.inspector)
    ) return defaults();
    return { sidebar: stored.sidebar, inspector: stored.inspector };
  } catch {
    return defaults();
  }
};

export const writePaneWidths = (storage: Pick<Storage, "setItem">, widths: PaneWidths): void => {
  try {
    storage.setItem(PANE_STORAGE_KEY, JSON.stringify({ version: PANE_STORAGE_VERSION, ...widths }));
  } catch {
    // Storage can be unavailable in privacy-constrained renderers; resizing still works for this launch.
  }
};

export const clampPaneWidth = (pane: keyof PaneWidths, width: number): number => {
  const range = PANE_WIDTHS[pane];
  return Math.min(range.max, Math.max(range.min, width));
};
