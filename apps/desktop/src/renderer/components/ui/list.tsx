import type * as React from "react";
import { cn } from "../../lib/utils";

export const List = ({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element =>
  <div className={cn("ui-list", className)} {...props} />;

export const ListSection = ({ className, ...props }: React.ComponentProps<"section">): React.JSX.Element =>
  <section className={cn("ui-list-section", className)} {...props} />;

export const ListSectionTitle = ({ className, ...props }: React.ComponentProps<"h2">): React.JSX.Element =>
  <h2 className={cn("ui-list-section-title", className)} {...props} />;

export const ListRow = ({ className, type = "button", ...props }: React.ComponentProps<"button">): React.JSX.Element =>
  <button type={type} className={cn("ui-list-row", className)} {...props} />;
