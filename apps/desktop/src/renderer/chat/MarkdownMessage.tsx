import { memo } from "react";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ExternalUrlSchema } from "../../shared/schemas";
import { cn } from "../lib/utils";

export const safeExternalUrl = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const result = ExternalUrlSchema.safeParse(value);
  return result.success ? result.data : undefined;
};

const MarkdownLink = ({ href, children, ...props }: ComponentPropsWithoutRef<"a">): React.JSX.Element => {
  const url = safeExternalUrl(href);
  if (url === undefined) return <span>{children}</span>;
  return (
    <a
      {...props}
      href={url}
      className="font-semibold text-primary underline decoration-primary/40 underline-offset-2 hover:text-primary-hover"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        void window.railgunDesktop.openExternal(url);
      }}
    >
      {children}
    </a>
  );
};

const MarkdownCode = ({ className, children, ...props }: ComponentPropsWithoutRef<"code">): React.JSX.Element => {
  const language = /(?:^|\s)language-([\w-]+)/u.exec(className ?? "")?.[1];
  return <code
    {...props}
    className={cn(
      "rounded-[0.3rem] bg-surface-muted px-1 py-0.5 font-mono text-[0.82em]",
      language !== undefined && "before:mb-2 before:block before:font-sans before:text-[0.625rem] before:font-bold before:uppercase before:tracking-[0.06em] before:text-foreground-tertiary before:content-[attr(data-language)]",
      className,
    )}
    {...(language === undefined ? {} : { "data-language": language })}
  >{children}</code>;
};

const MarkdownMessageComponent = ({ children }: { readonly children: string }): React.JSX.Element => (
  <div className="min-w-0 max-w-full [overflow-wrap:anywhere] text-body leading-[1.58] text-foreground">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      skipHtml
      urlTransform={url => safeExternalUrl(url) ?? ""}
      components={{
        a: MarkdownLink,
        code: MarkdownCode,
        img: () => null,
        p: ({ className, ...props }) => <p className={cn("my-3 first:mt-0 last:mb-0", className)} {...props} />,
        h1: ({ className, ...props }) => <h1 className={cn("mb-2 mt-5 text-display font-semibold tracking-[-0.025em]", className)} {...props} />,
        h2: ({ className, ...props }) => <h2 className={cn("mb-2 mt-5 text-heading font-semibold", className)} {...props} />,
        h3: ({ className, ...props }) => <h3 className={cn("mb-2 mt-4 text-body font-semibold", className)} {...props} />,
        h4: ({ className, ...props }) => <h4 className={cn("mb-2 mt-4 text-body font-semibold", className)} {...props} />,
        ul: ({ className, ...props }) => <ul className={cn("my-3 list-disc space-y-1 pl-5", className)} {...props} />,
        ol: ({ className, ...props }) => <ol className={cn("my-3 list-decimal space-y-1 pl-5", className)} {...props} />,
        blockquote: ({ className, ...props }) => <blockquote className={cn("my-3 border-l-2 border-primary/40 pl-3 text-foreground-secondary", className)} {...props} />,
        pre: ({ className, ...props }) => <pre className={cn("relative my-3 max-w-full overflow-auto rounded-md border border-border bg-surface-muted p-3 text-control leading-relaxed [&>code]:bg-transparent [&>code]:p-0", className)} {...props} />,
        table: ({ className, ...props }) => <div className="my-3 overflow-x-auto"><table className={cn("w-full border-collapse text-control", className)} {...props} /></div>,
        th: ({ className, ...props }) => <th className={cn("border-b border-border-strong px-2 py-1 text-left font-semibold", className)} {...props} />,
        td: ({ className, ...props }) => <td className={cn("border-b border-border px-2 py-1 align-top", className)} {...props} />,
        hr: ({ className, ...props }) => <hr className={cn("my-5 border-0 border-t border-border", className)} {...props} />,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

/** Completed Markdown is immutable, so streaming sibling updates must not reparse it. */
export const MarkdownMessage = memo(MarkdownMessageComponent);
