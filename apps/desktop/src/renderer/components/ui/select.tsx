import * as SelectPrimitive from "@radix-ui/react-select";
import { Check } from "lucide-react";
import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<React.ComponentRef<typeof SelectPrimitive.Trigger>, React.ComponentProps<typeof SelectPrimitive.Trigger>>(
  ({ className, children, ...props }, ref) => (
    <SelectPrimitive.Trigger ref={ref} className={cn("ui-field ui-select-trigger", className)} {...props}>
      {children}
    </SelectPrimitive.Trigger>
  ),
);
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = forwardRef<React.ComponentRef<typeof SelectPrimitive.Content>, React.ComponentProps<typeof SelectPrimitive.Content>>(
  ({ className, children, position = "popper", sideOffset = 6, ...props }, ref) => (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        position={position}
        sideOffset={sideOffset}
        className={cn(
          "ui-popover ui-select-content",
          position === "popper" && "radix-select-trigger-width",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="ui-select-viewport">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  ),
);
SelectContent.displayName = "SelectContent";

export const SelectItem = forwardRef<React.ComponentRef<typeof SelectPrimitive.Item>, React.ComponentProps<typeof SelectPrimitive.Item>>(
  ({ className, children, ...props }, ref) => (
    <SelectPrimitive.Item ref={ref} className={cn("ui-menu-item ui-select-item", className)} {...props}>
      <span className="ui-item-indicator">
        <SelectPrimitive.ItemIndicator><Check aria-hidden="true" /></SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  ),
);
SelectItem.displayName = "SelectItem";
