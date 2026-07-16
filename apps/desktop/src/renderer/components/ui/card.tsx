import type * as React from "react";
import { cn } from "../../lib/utils";

export const Card = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("rounded-lg border border-border bg-surface text-foreground", className)} {...props} />;

export const CardHeader = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("flex flex-col p-6", className)} {...props} />;

export const CardContent = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("px-6 pb-6", className)} {...props} />;
