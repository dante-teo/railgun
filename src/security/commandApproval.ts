export type CommandApprovalMode = "manual" | "smart" | "off";

export type ApprovalRequirement =
  | { readonly kind: "skip" }
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "needs_approval"; readonly reason: string; readonly patternId: string };

interface Pattern {
  readonly id: string;
  readonly regex: RegExp;
}

const HARDLINE_PATTERNS: readonly Pattern[] = [
  { id: "root_delete", regex: /\brm\s+(?:-\w+\s+)*-\w*r\w*(?:\s+-\w+)*\s+\/(?:\s|$)/ },
  { id: "mkfs", regex: /\bmkfs\./ },
  { id: "shutdown_reboot", regex: /\b(?:shutdown|reboot)\b/ },
  { id: "fork_bomb", regex: /:\(\)\s*\{\s*:\|:&\s*\};:/ },
  { id: "dd_disk", regex: /\bdd\b.*\bof=\/dev\/[a-z]/ },
];

const DANGEROUS_PATTERNS: readonly Pattern[] = [
  { id: "rm_recursive", regex: /\brm\s+(?:-\w+\s+)*-\w*r/ },
  { id: "sudo", regex: /\bsudo\b/ },
  { id: "force_push", regex: /\bgit\s+push\s+(?:.*\s+)?--force/ },
  { id: "drop_table", regex: /\bdrop\s+table\b/i },
  { id: "disk_write", regex: />\s*\/dev\/sd/ },
  { id: "chmod_world", regex: /\bchmod\s+(?:\d*7\d*\s|.*\+.*w.*o)/ },
  { id: "curl_pipe_sh", regex: /\bcurl\b.*\|\s*(?:ba)?sh\b/ },
];

export const checkCommandApproval = (
  command: string,
  mode: CommandApprovalMode,
  sessionApprovals: ReadonlySet<string>,
): ApprovalRequirement => {
  for (const pattern of HARDLINE_PATTERNS) {
    if (pattern.regex.test(command)) {
      return { kind: "forbidden", reason: `Command blocked: ${pattern.id} — this operation is not permitted` };
    }
  }

  const dangerous = DANGEROUS_PATTERNS.find(p => p.regex.test(command));
  if (dangerous === undefined) return { kind: "skip" };

  if (sessionApprovals.has(dangerous.id)) return { kind: "skip" };
  if (mode === "off") return { kind: "skip" };

  return { kind: "needs_approval", reason: `Flagged: ${dangerous.id}`, patternId: dangerous.id };
};

export const stripShellComments = (command: string): string =>
  command
    .split("\n")
    .map(line => {
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
