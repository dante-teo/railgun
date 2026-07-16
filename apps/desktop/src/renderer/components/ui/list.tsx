import type * as React from "react";
import { cn } from "../../lib/utils";

export const List = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("overflow-hidden rounded-md border border-border bg-surface", className)} {...props} />;

export const ListSection = ({ className, ...props }: React.ComponentProps<"section">): React.JSX.Element =>
  <section className={cn("border-border [&+&]:border-t", className)} {...props} />;

export const ListSectionTitle = ({ className, ...props }: React.ComponentProps<"h2">): React.JSX.Element =>
  <h2 className={cn("m-0 px-4 pb-2 pt-3 text-caption uppercase tracking-[0.07em] text-foreground-secondary", className)} {...props} />;

export const ListRow = ({ className, type = "button", ...props }: React.ComponentProps<"button">): React.JSX.Element =>
  <button type={type} className={cn("flex w-full items-center gap-3 border-0 border-t border-border bg-transparent px-4 py-3 text-left hover:bg-surface-muted active:bg-surface-control-active", className)} {...props} />;
