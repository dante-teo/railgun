import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "./theme.js";

export interface SelectorState {
  readonly itemCount: number;
  readonly visibleCount: number;
  readonly selectedIndex: number;
  readonly scrollOffset: number;
  readonly selectedIndexes: ReadonlySet<number>;
  readonly confirmed: boolean;
  readonly cancelled: boolean;
}

export type SelectorAction =
  | { readonly type: "up" | "down" | "cancel" }
  | { readonly type: "toggle"; readonly maxSelected?: number }
  | { readonly type: "confirm"; readonly minSelected?: number };

export const createSelectorState = (itemCount: number, visibleCount: number, selectedIndex = 0): SelectorState => {
  const normalizedItemCount = Math.max(0, itemCount);
  const normalizedVisibleCount = Math.max(1, visibleCount);
  const normalizedSelectedIndex = normalizedItemCount === 0
    ? 0
    : Math.min(Math.max(0, selectedIndex), normalizedItemCount - 1);
  return {
    itemCount: normalizedItemCount,
    visibleCount: normalizedVisibleCount,
    selectedIndex: normalizedSelectedIndex,
    scrollOffset: Math.max(0, normalizedSelectedIndex - normalizedVisibleCount + 1),
    selectedIndexes: new Set(),
    confirmed: false,
    cancelled: false,
  };
};

const withVisibleSelection = (state: SelectorState, selectedIndex: number): SelectorState => ({
  ...state,
  selectedIndex,
  scrollOffset: selectedIndex < state.scrollOffset
    ? selectedIndex
    : selectedIndex >= state.scrollOffset + state.visibleCount
      ? selectedIndex - state.visibleCount + 1
      : state.scrollOffset,
});

export const reduceSelector = (state: SelectorState, action: SelectorAction): SelectorState => {
  if (action.type === "cancel") return { ...state, cancelled: true };
  if (state.itemCount === 0) return state;
  if (action.type === "up" || action.type === "down") {
    const delta = action.type === "up" ? -1 : 1;
    return withVisibleSelection(state, (state.selectedIndex + delta + state.itemCount) % state.itemCount);
  }
  if (action.type === "toggle") {
    const selectedIndexes = new Set(state.selectedIndexes);
    if (selectedIndexes.has(state.selectedIndex)) selectedIndexes.delete(state.selectedIndex);
    else if (selectedIndexes.size < (action.maxSelected ?? Number.POSITIVE_INFINITY)) selectedIndexes.add(state.selectedIndex);
    return { ...state, selectedIndexes };
  }
  if (action.type === "confirm") return state.selectedIndexes.size >= (action.minSelected ?? 0) ? { ...state, confirmed: true } : state;
  return state;
};

export interface SelectorItem { readonly id: string; readonly label: string; readonly detail?: string; readonly current?: boolean }

export const Selector = ({ title, items, state, theme, multi = false, hint }: {
  readonly title: string;
  readonly items: readonly SelectorItem[];
  readonly state: SelectorState;
  readonly theme: Theme;
  readonly multi?: boolean;
  readonly hint?: string;
}): React.ReactElement => {
  const visible = items.slice(state.scrollOffset, state.scrollOffset + state.visibleCount);
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
    <Text color={theme.strong} bold>{title}</Text>
    {items.length === 0 && <Text color={theme.dim}>No options available.</Text>}
    {visible.map((item, offset) => {
      const index = state.scrollOffset + offset;
      const cursor = index === state.selectedIndex ? "›" : " ";
      const marker = multi ? (state.selectedIndexes.has(index) ? "[x]" : "[ ]") : item.current ? "●" : "○";
      return <Text key={item.id} color={index === state.selectedIndex ? theme.accent : theme.text}>
        {cursor} {marker} {item.label}{item.detail ? ` · ${item.detail}` : ""}
      </Text>;
    })}
    <Text color={theme.dim}>{hint ?? `↑/↓ select · Enter ${multi ? "toggle" : "choose"} · Esc cancel`}</Text>
  </Box>;
};
