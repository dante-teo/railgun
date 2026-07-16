import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";

export const RadioGroup = forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentProps<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn("grid gap-2", className)} {...props} />
));
RadioGroup.displayName = "RadioGroup";

export const RadioGroupItem = forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentProps<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item ref={ref} className={cn("grid size-4 place-items-center rounded-full border border-border-strong bg-surface-control outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary", className)} {...props}>
    <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-primary" />
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = "RadioGroupItem";

export const SegmentedControl = forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentProps<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root ref={ref} className={cn("inline-flex overflow-hidden rounded-sm border border-border bg-surface-control", className)} {...props} />
));
SegmentedControl.displayName = "SegmentedControl";

export const SegmentedControlItem = forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentProps<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Item ref={ref} className={cn("min-h-[1.7rem] border-0 border-r border-border bg-transparent px-3 text-caption capitalize text-foreground-secondary outline-none last:border-r-0 hover:bg-surface-muted focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 data-[state=checked]:bg-surface-control-active data-[state=checked]:text-foreground", className)} {...props} />
));
SegmentedControlItem.displayName = "SegmentedControlItem";
