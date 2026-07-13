import { useEffect } from "react";

interface UseOverlayKeyNavOptions {
  readonly length: number;
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
  readonly onCancel: () => void;
  /** When true, ArrowUp/Down wraps around; when false, clamps. Default: false. */
  readonly wrap?: boolean;
}

/**
 * Keyboard navigation for overlay list components.
 * Handles ArrowDown, ArrowUp (with optional wrap), Enter, and Escape.
 */
export const useOverlayKeyNav = ({
  length,
  selectedIndex,
  onSelect,
  onCancel,
  wrap = false,
}: UseOverlayKeyNavOptions): void => {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          onSelect(wrap ? (selectedIndex + 1) % length : Math.min(selectedIndex + 1, length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          onSelect(wrap ? (selectedIndex - 1 + length) % length : Math.max(selectedIndex - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          onSelect(selectedIndex);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [length, selectedIndex, onSelect, onCancel, wrap]);
};
