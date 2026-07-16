import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-caption font-semibold", {
  variants: {
    variant: {
      neutral: "bg-surface-muted text-foreground-secondary",
      success: "bg-success-soft text-success",
      warning: "bg-warning-soft text-warning",
      destructive: "bg-destructive-soft text-destructive",
      info: "bg-info-soft text-info",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}
export const Badge = ({ className, variant, ...props }: BadgeProps): React.JSX.Element =>
  <span className={cn(badgeVariants({ variant }), className)} {...props} />;

export const StatusBadge = Badge;
