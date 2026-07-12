import { render, type Theme as MarkdownTheme } from "markdansi";
import type { Theme } from "./theme.js";
import { rgb } from "../ui/theme.js";

const markdownTheme: MarkdownTheme = {
  heading: { color: "magenta", bold: true },
  strong: { color: "yellow", bold: true },
  emph: { color: "white", italic: true },
  inlineCode: { color: "cyan" },
  blockCode: { color: "green" },
  code: { color: "green" },
  link: { color: "blue", underline: true },
  quote: { color: "gray" },
  hr: { color: "gray" },
  listMarker: { color: "cyan", bold: true },
  tableHeader: { color: "yellow", bold: true },
  tableCell: { color: "white" },
};

const applyMintAnsi = (output: string, theme: Theme): string =>
  output
    .replaceAll("\u001b[35m", rgb(theme.strong))
    .replaceAll("\u001b[33m", rgb(theme.strong))
    .replaceAll("\u001b[37m", rgb(theme.text))
    .replaceAll("\u001b[36m", rgb(theme.accent))
    .replaceAll("\u001b[32m", rgb(theme.text))
    .replaceAll("\u001b[34m", rgb(theme.accent))
    .replaceAll("\u001b[90m", rgb(theme.muted));

export const renderAssistantMarkdown = (markdown: string, theme: Theme, width: number): string =>
  applyMintAnsi(render(markdown.replace(/(^|\n)(```|~~~)([^\n]*)\n([^\n]*)\n\2(?=\n|$)/g, "$1$2$3\n$4\n\n$2"), {
    width: Math.max(8, width),
    wrap: true,
    color: true,
    hyperlinks: true,
    theme: markdownTheme,
    tableBorder: "unicode",
    tableTruncate: true,
    codeBox: true,
    codeWrap: true,
    highlighter: code => `${rgb(theme.text)}${rgb(theme.codeSurface, true)}${code}\u001b[39;49m`,
  }), theme);
