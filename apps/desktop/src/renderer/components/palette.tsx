import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../lib/utils";
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { SearchField } from "./ui/form";

export const PaletteContent = forwardRef<React.ComponentRef<typeof DialogContent>, React.ComponentProps<typeof DialogContent>>(
  ({ className, ...props }, ref) => <DialogContent ref={ref} className={cn("w-[min(36rem,calc(100vw_-_2rem))] p-3", className)} {...props} />,
);
PaletteContent.displayName = "PaletteContent";

export const PaletteHeader = ({ title, description }: { readonly title: string; readonly description: string }): React.JSX.Element => (
  <DialogHeader className="px-2 pb-2 pt-1"><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
);

export const PaletteSearch = forwardRef<HTMLInputElement, React.ComponentProps<typeof SearchField>>(
  ({ className, ...props }, ref) => <SearchField ref={ref} className={cn("mb-2", className)} {...props} />,
);
PaletteSearch.displayName = "PaletteSearch";

export const PaletteList = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("grid max-h-[min(24rem,55vh)] gap-1 overflow-y-auto", className)} {...props} />;

interface PaletteOptionProps extends React.ComponentProps<"button"> { readonly active?: boolean }
export const PaletteOption = forwardRef<HTMLButtonElement, PaletteOptionProps>(
  ({ className, active = false, type = "button", ...props }, ref) => <button ref={ref} type={type} role="option" className={cn("flex min-h-control w-full items-center justify-between rounded-xs border border-transparent bg-transparent px-3 py-2 text-left text-foreground outline-none hover:bg-[var(--color-menu-hover)] focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40", active && "bg-[var(--color-menu-hover)]", className)} {...props} />,
);
PaletteOption.displayName = "PaletteOption";

export const PaletteState = ({ className, ...props }: React.ComponentProps<"p">): React.JSX.Element =>
  <p className={cn("m-5 text-center text-control text-foreground-secondary", className)} {...props} />;
