import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = forwardRef<React.ComponentRef<typeof SelectPrimitive.Trigger>, React.ComponentProps<typeof SelectPrimitive.Trigger>>(
  ({ className, children, ...props }, ref) => (
    <SelectPrimitive.Trigger ref={ref} className={cn("flex min-h-control w-full items-center gap-2 rounded-sm border border-border bg-surface-control px-3 py-2 text-left text-foreground shadow-control outline-none transition-[border-color,box-shadow] duration-fast ease-standard hover:border-border-strong focus-visible:border-focus focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:text-foreground-secondary", className)} {...props}>
      {children}<SelectPrimitive.Icon asChild><ChevronDown className="ml-auto" aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  ),
);
SelectTrigger.displayName = "SelectTrigger";

export const SelectContent = forwardRef<React.ComponentRef<typeof SelectPrimitive.Content>, React.ComponentProps<typeof SelectPrimitive.Content>>(
  ({ className, children, position = "popper", sideOffset = 6, ...props }, ref) => (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        data-glass-surface="popover"
        position={position}
        sideOffset={sideOffset}
        className={cn(
          "z-[var(--layer-dialog-popover)] max-h-[min(18rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] rounded-md border border-border bg-popover text-foreground shadow-popover backdrop-blur-popover",
          position === "popper" && "w-[var(--radix-select-trigger-width)] origin-[var(--radix-select-content-transform-origin)]",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="max-h-[min(18rem,var(--radix-select-content-available-height))] overflow-y-auto p-1">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  ),
);
SelectContent.displayName = "SelectContent";

export const SelectItem = forwardRef<React.ComponentRef<typeof SelectPrimitive.Item>, React.ComponentProps<typeof SelectPrimitive.Item>>(
  ({ className, children, ...props }, ref) => (
    <SelectPrimitive.Item ref={ref} className={cn("relative flex min-h-control-sm select-none items-center rounded-xs py-2 pl-8 pr-3 text-control outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--color-menu-hover)] data-[highlighted]:text-foreground", className)} {...props}>
      <span className="absolute left-2 grid size-4 place-items-center">
        <SelectPrimitive.ItemIndicator><Check className="size-3.5" aria-hidden="true" /></SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  ),
);
SelectItem.displayName = "SelectItem";
