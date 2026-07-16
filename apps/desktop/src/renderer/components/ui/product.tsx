import { forwardRef } from "react";
import type * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils";

export const PageHeader = ({ className, ...props }: React.ComponentProps<"header">): React.JSX.Element =>
  <header className={cn("flex items-start justify-between gap-4", className)} {...props} />;
export const PageTitle = ({ className, ...props }: React.ComponentProps<"h1">): React.JSX.Element =>
  <h1 className={cn("m-0 text-display font-semibold tracking-[-0.03em]", className)} {...props} />;
export const PageDescription = ({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element =>
  <p className={cn("m-0 mt-1 text-control text-foreground-secondary", className)} {...props} />;
export const SectionHeader = ({ className, ...props }: React.ComponentProps<"header">): React.JSX.Element =>
  <header className={cn("flex items-center justify-between gap-3", className)} {...props} />;
export const Toolbar = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div role="toolbar" className={cn("flex items-center gap-2", className)} {...props} />;

type AsChildProps = { readonly asChild?: boolean };

export const SettingsShell = ({ className, ...props }: React.ComponentProps<"main">): React.JSX.Element =>
  <main className={cn("grid size-full grid-cols-[clamp(13.5rem,24vw,16.5rem)_minmax(0,1fr)] overflow-hidden bg-surface text-foreground max-compact:grid-cols-[11.5rem_minmax(0,1fr)]", className)} {...props} />;

export const SettingsSidebar = ({ className, ...props }: React.ComponentProps<"aside">): React.JSX.Element =>
  <aside data-glass-surface="sidebar" className={cn("relative flex min-w-0 flex-col gap-3 overflow-hidden border-r border-border bg-popover px-3 pb-4 pt-[calc(var(--titlebar-height)_-_var(--space-2))] shadow-popover backdrop-blur-popover [-webkit-app-region:drag] motion-reduce:transition-none", className)} {...props} />;

export const SettingsNavGroup = ({ className, ...props }: React.ComponentProps<"section">): React.JSX.Element =>
  <section className={cn("grid gap-0.5 [&>h2]:m-0 [&>h2]:px-2 [&>h2]:pb-1 [&>h2]:text-[0.625rem] [&>h2]:font-semibold [&>h2]:uppercase [&>h2]:tracking-[0.08em] [&>h2]:text-foreground-tertiary", className)} {...props} />;

export const SettingsNav = ({ className, ...props }: React.ComponentProps<"nav">): React.JSX.Element =>
  <nav className={cn("grid gap-3 overflow-auto [-webkit-app-region:no-drag]", className)} {...props} />;

export const SettingsNavItem = forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
  ({ className, type = "button", ...props }, ref) => <button ref={ref} type={type} className={cn("flex min-h-8 w-full items-center gap-2 rounded-[0.38rem] border-0 bg-transparent px-2 text-left text-control text-foreground outline-none [-webkit-app-region:no-drag] hover:bg-[var(--material-sidebar-control-hover)] focus-visible:outline-2 focus-visible:outline-focus aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground [&>svg]:size-4 [&>svg]:stroke-[1.8]", className)} {...props} />,
);
SettingsNavItem.displayName = "SettingsNavItem";

export const SettingsSearchResults = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("min-h-0 overflow-auto [-webkit-app-region:no-drag] [&>p]:text-center [&>p]:text-control [&>p]:text-foreground-secondary", className)} {...props} />;

export const SettingsSearchResult = forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
  ({ className, type = "button", ...props }, ref) => <button ref={ref} type={type} className={cn("grid w-full gap-0.5 rounded-sm border-0 bg-transparent p-2 text-left text-foreground [-webkit-app-region:no-drag] hover:bg-[var(--material-sidebar-control-hover)] focus-visible:bg-[var(--material-sidebar-control-hover)] [&>span]:text-caption [&>span]:text-foreground-secondary [&>strong]:text-control [&>strong]:font-medium", className)} {...props} />,
);
SettingsSearchResult.displayName = "SettingsSearchResult";

export const SettingsDetail = ({ className, ...props }: React.ComponentProps<"section">): React.JSX.Element =>
  <section className={cn("min-h-0 min-w-0 overflow-auto bg-surface", className)} {...props} />;

export const SettingsColumn = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("mx-auto w-[min(44rem,calc(100%_-_3rem))] pb-8 pt-[calc(var(--titlebar-height)_+_var(--space-7))] max-compact:w-[calc(100%_-_2rem)]", className)} {...props} />;

export const SettingsHeading = ({ className, ...props }: React.ComponentProps<"header">): React.JSX.Element =>
  <header className={cn("mb-6 [&>h1]:m-0 [&>h1]:text-display [&>h1]:font-semibold [&>h1]:tracking-[-0.025em] [&>p]:mb-0 [&>p]:mt-1 [&>p]:text-control [&>p]:text-foreground-secondary", className)} {...props} />;

export const SettingsSection = ({ asChild = false, className, ...props }: React.ComponentProps<"section"> & AsChildProps): React.JSX.Element => {
  const Component = asChild ? Slot : "section";
  return <Component className={cn("mt-3 overflow-hidden rounded-md border border-border bg-surface shadow-control first:mt-0", className)} {...props} />;
};

export const SettingsRow = ({ asChild = false, className, ...props }: React.ComponentProps<"div"> & AsChildProps): React.JSX.Element => {
  const Component = asChild ? Slot : "div";
  return <Component className={cn("flex min-h-16 items-center justify-between gap-5 border-b border-border px-4 py-3 outline-none last:border-b-0 max-compact:items-start max-compact:flex-col", className)} {...props} />;
};

export const SettingsRowCopy = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("grid min-w-0 gap-1 [&>small]:max-w-md [&>small]:text-caption [&>small]:leading-snug [&>small]:text-foreground-secondary [&>strong]:text-control [&>strong]:font-semibold", className)} {...props} />;

export const SettingsInline = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("flex items-center justify-end gap-2 max-compact:w-full", className)} {...props} />;

export const SettingsSave = ({ className, ...props }: React.ComponentProps<"footer">): React.JSX.Element =>
  <footer className={cn("flex min-h-12 items-center justify-end gap-3 pt-4 [&>span]:text-caption [&>span]:text-foreground-secondary", className)} {...props} />;

export const SettingsSkeleton = ({ rows = 3, className, ...props }: React.ComponentProps<"div"> & { readonly rows?: number }): React.JSX.Element =>
  <div className={cn("grid gap-px overflow-hidden rounded-md border border-border bg-border", className)} {...props}>{Array.from({ length: rows }, (_, index) => <i key={index} className="h-16 animate-pulse bg-surface-muted motion-reduce:animate-none" />)}</div>;

export const GlassSurface = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div data-glass-surface="panel" className={cn("border border-border bg-popover shadow-popover backdrop-blur-popover", className)} {...props} />;

export const KnowledgeShell = ({ className, ...props }: React.ComponentProps<"main">): React.JSX.Element =>
  <main className={cn("grid size-full grid-cols-[16.25rem_minmax(0,1fr)] bg-surface text-foreground max-compact:grid-cols-1", className)} {...props} />;

export const KnowledgeSidebar = ({ className, ...props }: React.ComponentProps<"aside">): React.JSX.Element =>
  <aside data-glass-surface="sidebar" className={cn("flex flex-col gap-6 border-r border-border bg-popover px-4 pb-4 pt-[calc(var(--titlebar-height)_+_var(--space-3))] shadow-popover backdrop-blur-popover max-compact:border-b max-compact:border-r-0", className)} {...props} />;

export const KnowledgeNav = ({ className, ...props }: React.ComponentProps<"nav">): React.JSX.Element =>
  <nav className={cn("grid gap-0.5 max-compact:grid-cols-2", className)} {...props} />;

export const KnowledgeNavItem = forwardRef<HTMLButtonElement, React.ComponentProps<"button">>(
  ({ className, type = "button", ...props }, ref) => <button ref={ref} type={type} className={cn("flex min-h-8 items-center gap-2 rounded-sm border-0 bg-transparent px-2 text-left text-foreground hover:bg-[var(--material-sidebar-control-hover)] aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground [&>svg]:size-4", className)} {...props} />,
);
KnowledgeNavItem.displayName = "KnowledgeNavItem";

export const KnowledgeContent = ({ className, ...props }: React.ComponentProps<"section">): React.JSX.Element =>
  <section className={cn("overflow-auto px-[clamp(2rem,7vw,6rem)] pb-8 pt-[calc(var(--titlebar-height)_+_var(--space-7))]", className)} {...props} />;

export const KnowledgeHeader = ({ className, ...props }: React.ComponentProps<"header">): React.JSX.Element =>
  <header className={cn("mb-5 flex items-start justify-between gap-4 [&_h2]:m-0 [&_h2]:text-heading [&_h2]:font-semibold [&_p]:mb-0 [&_p]:mt-1 [&_p]:text-control [&_p]:leading-snug [&_p]:text-foreground-secondary", className)} {...props} />;
