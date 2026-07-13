import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn("ui-field ui-input", className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn("ui-field ui-textarea", className)} {...props} />,
);
Textarea.displayName = "Textarea";
