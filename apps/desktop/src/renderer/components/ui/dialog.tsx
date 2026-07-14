import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const DialogOverlay = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>): React.JSX.Element =>
  <DialogPrimitive.Overlay className={cn("ui-dialog-overlay", className)} {...props} />;

interface DialogContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {
  readonly showClose?: boolean;
}

export const DialogContent = forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, showClose = false, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content ref={ref} className={cn("ui-dialog-content", className)} {...props}>
        {children}
        {showClose ? <DialogPrimitive.Close className="ui-dialog-close" aria-label="Close"><X aria-hidden="true" /></DialogPrimitive.Close> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("ui-dialog-header", className)} {...props} />;
export const DialogFooter = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("ui-dialog-footer", className)} {...props} />;
export const DialogTitle = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>): React.JSX.Element =>
  <DialogPrimitive.Title className={cn("ui-dialog-title", className)} {...props} />;
export const DialogDescription = ({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>): React.JSX.Element =>
  <DialogPrimitive.Description className={cn("ui-dialog-description", className)} {...props} />;

export type SheetEdge = "left" | "right" | "bottom";
interface SheetContentProps extends DialogContentProps { readonly edge?: SheetEdge }

export const Sheet = Dialog;
export const SheetTrigger = DialogTrigger;
export const SheetClose = DialogClose;
export const SheetContent = forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, SheetContentProps>(
  ({ className, edge = "right", ...props }, ref) =>
    <DialogContent ref={ref} className={cn("ui-sheet-content", `ui-sheet-${edge}`, className)} {...props} />,
);
SheetContent.displayName = "SheetContent";
export const SheetHeader = DialogHeader;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;
