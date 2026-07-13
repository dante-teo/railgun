import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "ui-button",
  {
    variants: {
      variant: {
        primary: "ui-button-primary",
        glass: "ui-button-glass",
        ghost: "ui-button-ghost",
        destructive: "ui-button-destructive",
        capsule: "ui-button-capsule",
      },
      size: {
        default: "ui-button-md",
        sm: "ui-button-sm",
        icon: "ui-button-icon",
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

export const ButtonGroup = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div role="group" className={cn("ui-button-group", className)} {...props} />;
