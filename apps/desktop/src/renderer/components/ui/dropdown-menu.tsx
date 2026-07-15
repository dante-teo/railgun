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
      <DropdownMenuPrimitive.Content ref={ref} className={cn("ui-popover ui-dropdown-content", className)} sideOffset={sideOffset} {...props}>
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  ),
);
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.Item>, React.ComponentProps<typeof DropdownMenuPrimitive.Item>>(
  ({ className, ...props }, ref) =>
    <DropdownMenuPrimitive.Item ref={ref} className={cn("ui-menu-item", className)} {...props} />,
);
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuCheckboxItem = forwardRef<React.ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>, React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>>(
  ({ className, children, ...props }, ref) => (
    <DropdownMenuPrimitive.CheckboxItem ref={ref} className={cn("ui-menu-item ui-checkbox-item", className)} {...props}>
      <span className="ui-item-indicator"><DropdownMenuPrimitive.ItemIndicator><Check aria-hidden="true" /></DropdownMenuPrimitive.ItemIndicator></span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  ),
);
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";

export const DropdownMenuSeparator = ({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>): React.JSX.Element =>
  <DropdownMenuPrimitive.Separator className={cn("ui-menu-separator", className)} {...props} />;
