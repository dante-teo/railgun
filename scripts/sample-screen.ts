import { createAnsiTheme } from "../src/ui/theme.js";

const theme = createAnsiTheme("dark");

console.log(theme.strong("RAILGUN") + theme.muted(" · adaptive agent console"));
console.log(theme.dim("─".repeat(60)));
console.log(theme.accent("YOU") + "  " + theme.text("summarize notes.txt"));
console.log(theme.strong("RAILGUN") + "  " + theme.text("I'll read the file first."));
console.log(theme.toolCallLabel("read_file", "running"));
console.log(theme.toolCallLabel("read_file", "done"));
console.log(theme.toolCallLabel("write_file", "error"));
console.log(theme.text("The file contains") + theme.streamingCursor());
console.log(theme.thinkingIndicator());
console.log(theme.unseenPill());
