export interface ViewportState {
  readonly totalRows: number;
  readonly viewportRows: number;
  readonly offset: number;
  readonly unseen: number;
}

export type ViewportAction =
  | { readonly type: "page-up" }
  | { readonly type: "page-down" }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "scroll"; readonly delta: number }
  | { readonly type: "resize"; readonly viewportRows: number }
  | { readonly type: "content"; readonly totalRows: number };

const natural = (value: number): number => Math.max(0, Math.floor(value));
const maxOffset = (totalRows: number, viewportRows: number): number =>
  Math.max(0, natural(totalRows) - Math.max(1, natural(viewportRows)));

export const createViewport = (totalRows: number, viewportRows: number): ViewportState => {
  const total = natural(totalRows);
  const rows = Math.max(1, natural(viewportRows));
  return { totalRows: total, viewportRows: rows, offset: maxOffset(total, rows), unseen: 0 };
};

export const isViewportAtBottom = (state: ViewportState): boolean =>
  state.offset >= maxOffset(state.totalRows, state.viewportRows);

export const visibleViewportRows = <T>(rows: readonly T[], state: ViewportState): readonly T[] => {
  const cueRows = state.unseen > 0 ? 1 : 0;
  const capacity = Math.max(0, state.viewportRows - cueRows);
  return rows.slice(state.offset, state.offset + capacity);
};

export const reduceViewport = (state: ViewportState, action: ViewportAction): ViewportState => {
  const bottom = maxOffset(state.totalRows, state.viewportRows);
  switch (action.type) {
    case "page-up":
      return { ...state, offset: Math.max(0, state.offset - state.viewportRows) };
    case "page-down": {
      const offset = Math.min(bottom, state.offset + state.viewportRows);
      return { ...state, offset, unseen: offset === bottom ? 0 : state.unseen };
    }
    case "home":
      return { ...state, offset: 0 };
    case "end":
      return { ...state, offset: bottom, unseen: 0 };
    case "scroll": {
      const offset = Math.max(0, Math.min(bottom, state.offset + Math.trunc(action.delta)));
      return { ...state, offset, unseen: offset === bottom ? 0 : state.unseen };
    }
    case "resize": {
      const viewportRows = Math.max(1, natural(action.viewportRows));
      const resizedBottom = maxOffset(state.totalRows, viewportRows);
      const offset = isViewportAtBottom(state) ? resizedBottom : Math.min(state.offset, resizedBottom);
      return { ...state, viewportRows, offset, unseen: offset === resizedBottom ? 0 : state.unseen };
    }
    case "content": {
      const totalRows = natural(action.totalRows);
      const added = Math.max(0, totalRows - state.totalRows);
      return isViewportAtBottom(state)
        ? { ...state, totalRows, offset: maxOffset(totalRows, state.viewportRows), unseen: 0 }
        : { ...state, totalRows, offset: Math.min(state.offset, maxOffset(totalRows, state.viewportRows)), unseen: state.unseen + added };
    }
  }
};
