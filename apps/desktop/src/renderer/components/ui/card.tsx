import type * as React from "react";
import { cn } from "../../lib/utils";

export const Card = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("ui-card", className)} {...props} />;

export const CardHeader = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("ui-card-header", className)} {...props} />;

export const CardContent = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("ui-card-content", className)} {...props} />;
