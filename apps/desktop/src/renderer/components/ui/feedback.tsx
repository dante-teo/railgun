import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";

type AlertVariant = "info" | "success" | "warning" | "destructive";
const icons = { info: Info, success: CheckCircle2, warning: TriangleAlert, destructive: AlertCircle };
const styles: Record<AlertVariant, string> = {
  info: "border-info/40 bg-info-soft text-info",
  success: "border-success/40 bg-success-soft text-success",
  warning: "border-warning/40 bg-warning-soft text-warning",
  destructive: "border-destructive/40 bg-destructive-soft text-destructive",
};

interface InlineAlertProps extends React.ComponentProps<"div"> { readonly variant?: AlertVariant; readonly title?: string }
export const InlineAlert = ({ variant = "info", title, children, className, ...props }: InlineAlertProps): React.JSX.Element => {
  const Icon = icons[variant];
  return <div role={variant === "destructive" ? "alert" : "status"} className={cn("grid grid-cols-[auto_1fr] gap-2 rounded-sm border p-3 text-control", styles[variant], className)} {...props}>
    <Icon className="mt-0.5 size-4" aria-hidden="true" />
    <div>{title === undefined ? null : <strong className="block">{title}</strong>}{children}</div>
  </div>;
};
