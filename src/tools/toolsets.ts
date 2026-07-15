export const BUILT_IN_READ_ONLY_TOOLSETS = ["web"] as const;
export const DEFAULT_TOOLSETS = [
  "file", "terminal", "planning", "clarify", "extension", "memory", "skills", "cron", "railgun",
  ...BUILT_IN_READ_ONLY_TOOLSETS,
] as const;
export const PRIMARY_TOOLSETS = [...DEFAULT_TOOLSETS, "delegation"] as const;
