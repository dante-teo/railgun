import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";

interface StateProps extends React.ComponentProps<"div"> {
  readonly title: string;
  readonly description?: string;
  readonly icon?: React.ReactNode;
}

const StateBody = ({ title, description, icon, children, className, ...props }: StateProps): React.JSX.Element => (
  <div className={cn("grid max-w-md justify-items-center text-center text-foreground", className)} {...props}>
    <span className="mb-4 grid size-13 place-items-center rounded-lg border border-border bg-surface-muted text-primary shadow-control [&_svg]:size-6" aria-hidden="true">{icon}</span>
    <h2 className="m-0 text-display tracking-[-0.035em]">{title}</h2>
    {description === undefined ? null : <p className="m-0 mt-2 text-body leading-[1.45] text-foreground-secondary">{description}</p>}
    {children}
  </div>
);

export const LoadingState = ({ icon = <LoaderCircle />, className, ...props }: StateProps): React.JSX.Element =>
  <StateBody role="status" aria-live="polite" className={cn("[&_.lucide-loader-circle]:animate-spin motion-reduce:[&_.lucide-loader-circle]:animate-none", className)} icon={icon} {...props} />;

export const EmptyState = ({ icon = <Inbox />, className, ...props }: StateProps): React.JSX.Element =>
  <StateBody className={className} icon={icon} {...props} />;

export const ErrorState = ({ icon = <AlertCircle />, className, ...props }: StateProps): React.JSX.Element =>
  <StateBody role="alert" className={cn("[&>span:first-child]:text-destructive", className)} icon={icon} {...props} />;
