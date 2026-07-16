import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-default items-center justify-center gap-2 whitespace-nowrap rounded-full border border-transparent text-control font-semibold transition-[color,background-color,border-color,transform,box-shadow] duration-fast ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 active:not-disabled:scale-[0.975]",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:not-disabled:bg-primary-hover",
        secondary: "bg-secondary text-secondary-foreground hover:not-disabled:bg-secondary-hover active:not-disabled:bg-secondary-active",
        ghost: "bg-transparent text-primary hover:not-disabled:bg-surface-muted hover:not-disabled:text-primary-hover active:not-disabled:scale-100 active:not-disabled:opacity-75",
        destructive: "bg-destructive text-destructive-foreground hover:not-disabled:bg-destructive-hover",
      },
      size: {
        default: "min-h-control px-4 py-2",
        sm: "min-h-control-sm px-3 py-1 text-caption",
        icon: "size-control-icon rounded-full p-0",
        titlebarIcon: "size-[var(--titlebar-control-height)] rounded-full p-0",
        compactIcon: "size-6 min-h-0 rounded-xs p-0 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Component = asChild ? Slot : "button";
    return <Component ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
  },
);
Button.displayName = "Button";

export const InsetIconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "size" | "variant">>(
  ({ className, ...props }, ref) => <Button
    ref={ref}
    variant="ghost"
    size="icon"
    className={cn("relative hover:not-disabled:bg-transparent before:pointer-events-none before:absolute before:left-1/2 before:top-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:transition-colors before:duration-fast before:content-[''] hover:not-disabled:before:bg-surface-muted [&_svg]:relative [&_svg]:z-[1]", className)}
    {...props}
  />,
);
InsetIconButton.displayName = "InsetIconButton";

export const ButtonGroup = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div role="group" className={cn("inline-flex items-center gap-1", className)} {...props} />;
