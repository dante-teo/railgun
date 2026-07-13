import { useEffect } from "react";

interface ListKeyboardOptions {
  readonly length: number;
  readonly selectedIndex: number;
  /** When true, ArrowDown at last wraps to 0, ArrowUp at 0 wraps to last. Default: clamp. */
  readonly wrap?: boolean;
  readonly onNavigate: (index: number) => void;
  readonly onConfirm: (index: number) => void;
  readonly onCancel: () => void;
}

/**
 * Attaches window keydown handlers for list navigation.
 * ArrowDown/ArrowUp → onNavigate; Enter → onConfirm; Escape → onCancel.
 */
export function useListKeyboard({
  length,
  selectedIndex,
  wrap = false,
  onNavigate,
  onConfirm,
  onCancel,
}: ListKeyboardOptions): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        onNavigate(
          wrap
            ? (selectedIndex + 1) % length
            : Math.min(selectedIndex + 1, length - 1),
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        onNavigate(
          wrap
            ? (selectedIndex - 1 + length) % length
            : Math.max(selectedIndex - 1, 0),
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm(selectedIndex);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [length, selectedIndex, wrap, onNavigate, onConfirm, onCancel]);
}
