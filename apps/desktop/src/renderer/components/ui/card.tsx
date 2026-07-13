import type * as React from "react";
import { cn } from "../../lib/utils";

export const Card = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("rounded-xl border bg-card text-card-foreground shadow-sm", className)} {...props} />;

export const CardHeader = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />;

export const CardContent = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("p-6 pt-0", className)} {...props} />;
