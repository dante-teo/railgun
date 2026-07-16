import { Search } from "lucide-react";
import { cloneElement, forwardRef, useId } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils";
import { Input } from "./input";

interface FormControlProps {
  readonly id?: string | undefined;
  readonly required?: boolean | undefined;
  readonly "aria-describedby"?: string | undefined;
  readonly "aria-invalid"?: React.AriaAttributes["aria-invalid"] | undefined;
}

interface FormFieldProps extends Omit<React.ComponentProps<"div">, "children"> {
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly htmlFor?: string;
  readonly required?: boolean;
  readonly children: React.ReactElement<FormControlProps>;
}

export const FormField = ({ label, description, error, htmlFor, required, children, className, ...props }: FormFieldProps): React.JSX.Element => {
  const generatedId = useId();
  const id = htmlFor ?? children.props.id ?? generatedId;
  const descriptionId = description === undefined ? undefined : `${id}-description`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedBy = [children.props["aria-describedby"], descriptionId, errorId].filter(value => value !== undefined).join(" ") || undefined;
  const isRequired = required ?? children.props.required;
  const control = cloneElement(children, {
    id,
    required: isRequired,
    "aria-describedby": describedBy,
    "aria-invalid": error === undefined ? children.props["aria-invalid"] : true,
  });
  return <div className={cn("grid gap-2 text-control", className)} {...props}>
    <label htmlFor={id} className="font-semibold text-foreground">{label}{isRequired ? <span aria-hidden="true"> *</span> : null}</label>
    {description === undefined ? null : <p id={descriptionId} className="m-0 text-caption leading-snug text-foreground-secondary">{description}</p>}
    {control}
    {error === undefined ? null : <p id={errorId} className="m-0 text-caption text-destructive" role="alert">{error}</p>}
  </div>;
};

interface SearchFieldProps extends Omit<React.ComponentProps<typeof Input>, "className"> { readonly className?: string; readonly inputClassName?: string }
export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(({ className, inputClassName, ...props }, ref) => (
  <label className={cn("relative block", className)}>
    <Search className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-foreground-secondary" aria-hidden="true" />
    <Input ref={ref} type="search" className={cn("pl-9", inputClassName)} {...props} />
  </label>
));
SearchField.displayName = "SearchField";
