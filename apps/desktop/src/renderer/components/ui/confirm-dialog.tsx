import type * as React from "react";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: React.ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly busy?: boolean;
  readonly busyLabel?: string;
  readonly confirmDisabled?: boolean;
  readonly destructive?: boolean;
  readonly error?: string | undefined;
  readonly contentClassName?: string;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
}

export const ConfirmDialog = ({ open, title, description, confirmLabel, cancelLabel = "Cancel", busy = false, busyLabel, confirmDisabled = false, destructive = false, error, contentClassName, onConfirm, onOpenChange }: ConfirmDialogProps): React.JSX.Element => (
  <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <DialogContent className={contentClassName}>
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      {error === undefined ? null : <p className="m-0 mt-3 text-control text-destructive" role="alert">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
        <Button type="button" variant={destructive ? "destructive" : "primary"} disabled={busy || confirmDisabled} onClick={onConfirm}>{busy ? busyLabel ?? confirmLabel : confirmLabel}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
