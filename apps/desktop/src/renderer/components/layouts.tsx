import type * as React from "react";
import { cn } from "../lib/utils";

export const AppShell = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("grid size-full min-h-0 min-w-0 overflow-hidden", className)} {...props} />;
export const PageLayout = ({ className, ...props }: React.ComponentProps<"main">): React.JSX.Element =>
  <main className={cn("grid size-full min-h-0 grid-rows-[auto_1fr] overflow-hidden", className)} {...props} />;
export const SidebarLayout = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("grid size-full min-h-0 grid-cols-[16rem_minmax(0,1fr)] overflow-hidden max-compact:grid-cols-1", className)} {...props} />;
export const SplitLayout = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("grid min-h-0 grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)] gap-4 max-compact:grid-cols-1", className)} {...props} />;
export const Stack = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("flex flex-col gap-4", className)} {...props} />;
export const Cluster = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("flex flex-wrap items-center gap-2", className)} {...props} />;
