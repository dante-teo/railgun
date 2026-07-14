const SLASH_PHASES: Readonly<Record<string, string>> = Object.freeze({
  "/exit": "slash_exit",
  "/help": "slash_help",
  "/clear": "slash_clear",
  "/model": "slash_model",
  "/settings": "slash_settings",
  "/compact": "slash_compact",
  "/rollback": "slash_rollback",
  "/trust": "slash_trust",
  "/moa": "slash_moa",
  "/branch": "slash_branch",
  "/fork": "slash_fork",
  "/dream": "slash_dream",
  "/cron": "slash_cron",
});

export const diagnosticSlashPhase = (command: string): string =>
  command.startsWith("/skill:") ? "slash_skill" : SLASH_PHASES[command] ?? "slash_unknown";
