import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export const DropdownMenuContent = forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.Content>, React.ComponentProps<typeof DropdownMenuPrimitive.Content>>(
  ({ className, children, sideOffset = 8, ...props }, ref) => (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content ref={ref} data-glass-surface="popover" className={cn("z-[var(--layer-popover)] min-w-48 origin-[var(--radix-dropdown-menu-content-transform-origin)] rounded-md border border-border bg-popover p-1 text-foreground shadow-popover backdrop-blur-popover", className)} sideOffset={sideOffset} {...props}>
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  ),
);
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.Item>, React.ComponentProps<typeof DropdownMenuPrimitive.Item>>(
  ({ className, ...props }, ref) =>
    <DropdownMenuPrimitive.Item ref={ref} className={cn("relative flex min-h-control-sm select-none items-center rounded-xs px-3 py-2 text-control outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--color-menu-hover)]", className)} {...props} />,
);
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>, React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>>(
  ({ className, children, ...props }, ref) => (
    <DropdownMenuPrimitive.CheckboxItem ref={ref} className={cn("relative flex min-h-control-sm select-none items-center rounded-xs py-2 pl-8 pr-3 text-control outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--color-menu-hover)]", className)} {...props}>
      <span className="absolute left-2 grid size-4 place-items-center"><DropdownMenuPrimitive.ItemIndicator><Check className="size-3.5" aria-hidden="true" /></DropdownMenuPrimitive.ItemIndicator></span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  ),
);
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuSeparator = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>): React.JSX.Element =>
  <DropdownMenuPrimitive.Separator className={cn("m-1 h-px bg-border", className)} {...props} />;
