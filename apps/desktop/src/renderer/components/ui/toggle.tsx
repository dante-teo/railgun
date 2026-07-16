import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const Toggle = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn("inline-flex min-h-control-sm items-center justify-center gap-2 rounded-full border border-transparent bg-secondary px-3 text-caption font-semibold text-secondary-foreground outline-none transition-colors duration-fast ease-standard hover:bg-secondary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50 aria-pressed:bg-primary aria-pressed:text-primary-foreground [&_svg]:size-4", className)} {...props} />
  ),
);
Toggle.displayName = "Toggle";
