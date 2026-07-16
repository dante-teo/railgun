import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn("min-h-control w-full rounded-sm border border-border bg-surface-control px-3 py-2 text-foreground shadow-control outline-none transition-[border-color,box-shadow] duration-fast ease-standard placeholder:text-foreground-tertiary hover:not-disabled:border-border-strong focus:border-focus focus:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus:shadow-destructive-focus", className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn("min-h-20 w-full resize-y rounded-sm border border-border bg-surface-control px-3 py-2 text-foreground shadow-control outline-none transition-[border-color,box-shadow] duration-fast ease-standard placeholder:text-foreground-tertiary hover:not-disabled:border-border-strong focus:border-focus focus:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus:shadow-destructive-focus", className)} {...props} />,
);
Textarea.displayName = "Textarea";
