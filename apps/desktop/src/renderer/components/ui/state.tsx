import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";
import type * as React from "react";
import { cn } from "../../lib/utils";

interface StateProps extends React.ComponentProps<"div"> {
  readonly title: string;
  readonly description?: string;
  readonly icon?: React.ReactNode;
}

const StateBody = ({ title, description, icon, children, className, ...props }: StateProps): React.JSX.Element => (
  <div className={cn("ui-state", className)} {...props}>
    <span className="ui-state-icon" aria-hidden="true">{icon}</span>
    <h2>{title}</h2>
    {description === undefined ? null : <p>{description}</p>}
    {children}
  </div>
);

export const LoadingState = ({ icon = <LoaderCircle />, className, ...props }: StateProps): React.JSX.Element =>
  <StateBody role="status" aria-live="polite" className={cn("ui-state-loading", className)} icon={icon} {...props} />;

export const EmptyState = ({ icon = <Inbox />, className, ...props }: StateProps): React.JSX.Element =>
  <StateBody className={cn("ui-state-empty", className)} icon={icon} {...props} />;

export const ErrorState = ({ icon = <AlertCircle />, className, ...props }: StateProps): React.JSX.Element =>
  <StateBody role="alert" className={cn("ui-state-error", className)} icon={icon} {...props} />;
