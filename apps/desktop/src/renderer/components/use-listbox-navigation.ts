import { useEffect, useState } from "react";
import type { Key } from "react";

interface ListboxNavigationOptions<T> {
  readonly open: boolean;
  readonly items: readonly T[];
  readonly disabled?: boolean;
  readonly initialActiveKey?: Key;
  readonly getItemKey: (item: T) => Key;
  readonly isItemDisabled?: (item: T) => boolean;
  readonly onActivate: (item: T | undefined) => void;
}

const findEnabled = <T,>(items: readonly T[], start: number, direction: 1 | -1, isDisabled: (item: T) => boolean): number => {
  if (items.length === 0) return -1;
  const origin = start < 0 && direction === -1 ? 0 : start;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (origin + (offset * direction) + items.length) % items.length;
    const item = items[index];
    if (item !== undefined && !isDisabled(item)) return index;
  }
  return -1;
};

export const useListboxNavigation = <T,>({ open, items, disabled = false, initialActiveKey, getItemKey, isItemDisabled = () => false, onActivate }: ListboxNavigationOptions<T>) => {
  const [activeKey, setActiveKey] = useState<Key>();
  const activeIndex = activeKey === undefined ? -1 : items.findIndex(item => getItemKey(item) === activeKey);
  useEffect(() => {
    if (!open || disabled) {
      setActiveKey(undefined);
      return;
    }
    setActiveKey(current => {
      if (current !== undefined && items.some(item => getItemKey(item) === current && !isItemDisabled(item))) return current;
      if (initialActiveKey !== undefined && items.some(item => getItemKey(item) === initialActiveKey && !isItemDisabled(item))) return initialActiveKey;
      const firstEnabled = findEnabled(items, -1, 1, isItemDisabled);
      return firstEnabled < 0 ? undefined : getItemKey(items[firstEnabled]!);
    });
  }, [disabled, getItemKey, initialActiveKey, isItemDisabled, items, open]);

  const setActiveIndex = (index: number): void => {
    const item = items[index];
    setActiveKey(item === undefined ? undefined : getItemKey(item));
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = findEnabled(items, activeIndex, event.key === "ArrowDown" ? 1 : -1, isItemDisabled);
      setActiveIndex(index);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(findEnabled(items, event.key === "Home" ? -1 : 0, event.key === "Home" ? 1 : -1, isItemDisabled));
    } else if (event.key === "Enter") {
      event.preventDefault();
      onActivate(items[activeIndex]);
    }
  };

  return { activeIndex, setActiveIndex, onKeyDown } as const;
};
