import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;
export const HoverCardContent = forwardRef<
  React.ComponentRef<typeof HoverCardPrimitive.Content>,
  React.ComponentProps<typeof HoverCardPrimitive.Content>
>(({ className, sideOffset = 8, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content ref={ref} sideOffset={sideOffset} data-glass-surface="popover" className={cn("z-[var(--layer-popover)] max-w-sm rounded-md border border-border bg-popover p-3 text-foreground shadow-popover backdrop-blur-popover", className)} {...props} />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = "HoverCardContent";
