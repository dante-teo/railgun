import * as SwitchPrimitive from "@radix-ui/react-switch";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export const Switch = forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentProps<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn("relative h-5 w-9 shrink-0 rounded-full border border-border-strong bg-surface-control-active outline-none transition-colors duration-fast ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary", className)}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block size-4 translate-x-px rounded-full bg-surface shadow-control transition-transform duration-fast ease-standard data-[state=checked]:translate-x-[1.05rem]" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
