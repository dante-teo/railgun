export interface ThreatPattern {
  readonly id: string;
  readonly regex: RegExp;
}

const MAX_SCAN_CHARS = 65_536;

const FILLER = String.raw`(?:\w+\s+){0,8}`;

export const CONTEXT_THREAT_PATTERNS: readonly ThreatPattern[] = [
  { id: "prompt_injection", regex: new RegExp(String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "i") },
  { id: "sys_prompt_override", regex: /system\s+prompt\s+override/i },
  { id: "disregard_rules", regex: new RegExp(String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "i") },
  { id: "bypass_restrictions", regex: new RegExp(String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`, "i") },
  { id: "html_comment_injection", regex: /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i },
  { id: "hidden_div", regex: /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i },
  { id: "role_hijack", regex: new RegExp(String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "i") },
  { id: "role_pretend", regex: new RegExp(String.raw`pretend\s+${FILLER}(you\s+are|to\s+be)\s+`, "i") },
  { id: "leak_system_prompt", regex: new RegExp(String.raw`output\s+${FILLER}(system|initial)\s+prompt`, "i") },
  { id: "remove_filters", regex: new RegExp(String.raw`(respond|answer|reply)\s+without\s+${FILLER}(restrictions|limitations|filters|safety)`, "i") },
];

export const scanForThreats = (content: string): readonly string[] => {
  const bounded = content.length > MAX_SCAN_CHARS ? content.slice(0, MAX_SCAN_CHARS) : content;
  return CONTEXT_THREAT_PATTERNS.filter(p => p.regex.test(bounded)).map(p => p.id);
};
