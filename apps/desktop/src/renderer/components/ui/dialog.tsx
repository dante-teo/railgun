import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const DialogOverlay = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element =>
  <DialogPrimitive.Overlay className={cn("fixed inset-0 z-[var(--layer-overlay)] bg-[var(--color-scrim)]", className)} {...props} />;

interface DialogContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {
  readonly showClose?: boolean;
}

export const DialogContent = forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, showClose = false, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content ref={ref} data-glass-surface="dialog" className={cn("fixed left-1/2 top-1/2 z-[var(--layer-dialog)] max-h-[calc(100vh_-_2rem)] w-[min(28rem,calc(100vw_-_2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-[var(--material-dialog)] p-6 text-foreground shadow-dialog backdrop-blur-[24px] focus:outline-none", className)} {...props}>
        {children}
        {showClose ? <DialogPrimitive.Close className="absolute right-3 top-3 grid size-control-icon place-items-center rounded-full border-0 bg-transparent text-foreground-secondary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" aria-label="Close"><X className="size-4" aria-hidden="true" /></DialogPrimitive.Close> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("grid gap-1", className)} {...props} />;
export const DialogFooter = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
export const DialogTitle = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element =>
  <DialogPrimitive.Title className={cn("m-0 text-heading font-semibold tracking-[-0.015em]", className)} {...props} />;
export const DialogDescription = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>): React.JSX.Element =>
  <DialogPrimitive.Description className={cn("m-0 mt-2 text-body leading-[1.45] text-foreground-secondary", className)} {...props} />;

export type SheetEdge = "left" | "right" | "bottom";
interface SheetContentProps extends DialogContentProps { readonly edge?: SheetEdge }

export const Sheet = Dialog;
export const SheetTrigger = DialogTrigger;
export const SheetClose = DialogClose;
export const SheetContent = forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ className, edge = "right", ...props }, ref) =>
    <DialogContent ref={ref} className={cn(
      "inset-y-0 max-h-none w-[min(24rem,calc(100vw_-_2rem))] translate-y-0 rounded-none",
      edge === "right" && "left-auto right-0 translate-x-0 border-y-0 border-r-0",
      edge === "left" && "left-0 translate-x-0 border-y-0 border-l-0",
      edge === "bottom" && "inset-x-0 bottom-0 top-auto w-full max-w-none translate-x-0 max-h-[75vh] rounded-t-xl border-x-0 border-b-0",
      className,
    )} data-edge={edge} {...props} />,
);
SheetContent.displayName = "SheetContent";
export const SheetHeader = DialogHeader;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;
