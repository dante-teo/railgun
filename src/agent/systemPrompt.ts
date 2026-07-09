export interface SystemPromptInput {
  cwd: string;
  platform: string;
  osRelease: string;
  startDate: string;
  modelId: string;
  provider: "Devin";
  soulIdentity?: string | null;
  projectContext?: string | null;
}

const promptData = (value: string): string => JSON.stringify(value);

export const buildSystemPrompt = ({
  cwd,
  platform,
  osRelease,
  startDate,
  modelId,
  provider,
  soulIdentity,
  projectContext,
}: SystemPromptInput): readonly string[] => [
  [
    "You are Railgun, a general-purpose assistant inspired by Hermes Agent.",
    "Be helpful, direct, and practical.",
    "Answer the user's request without unnecessary ceremony, and keep concise answers concise."
  ].join("\n"),
  [
    "Tool rules:",
    "- Use tools for real filesystem, directory, and shell facts.",
    "- Do not guess file contents, command output, or local project state when a tool can check it.",
    "- Respect the existing shell approval flow; shell commands may be declined by the user.",
    "- Keep tool use focused on the user's current task."
  ].join("\n"),
  [
    "Environment:",
    `- Provider: ${promptData(provider)}`,
    `- Selected model: ${promptData(modelId)}`,
    `- Current working directory: ${promptData(cwd)}`,
    `- Platform: ${promptData(platform)}`,
    `- OS release: ${promptData(osRelease)}`,
    `- Conversation start date: ${promptData(startDate)}`
  ].join("\n"),
  ...(soulIdentity
    ? [`# Persistent Identity\n\nThe following personal identity notes have been loaded from ~/.railgun/SOUL.md and should be followed:\n\n${soulIdentity}`]
    : []),
  ...(projectContext
    ? [`# Project Context\n\nThe following project context has been loaded and should be followed:\n\n${projectContext}`]
    : []),
];
