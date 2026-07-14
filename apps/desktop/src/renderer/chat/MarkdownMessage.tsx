import { memo } from "react";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ExternalUrlSchema } from "../../shared/schemas";

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
  return <code {...props} className={className} {...(language === undefined ? {} : { "data-language": language })}>{children}</code>;
};

const MarkdownMessageComponent = ({ children }: { readonly children: string }): React.JSX.Element => (
  <div className="markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      skipHtml
      urlTransform={url => safeExternalUrl(url) ?? ""}
      components={{
        a: MarkdownLink,
        code: MarkdownCode,
        img: () => null,
      }}
    >
      {children}
    </ReactMarkdown>
  </div>
);

/** Completed Markdown is immutable, so streaming sibling updates must not reparse it. */
export const MarkdownMessage = memo(MarkdownMessageComponent);
