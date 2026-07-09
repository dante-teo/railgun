import type { SkinConfig } from "../skins.js";

const WIDTH = 35;

const hexToAnsi = (hex: string): string => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
};

const bold = "\x1b[1m";
const reset = "\x1b[0m";

export const printBanner = (skin: SkinConfig): void => {
  const bc = hexToAnsi(skin.colors.border);
  const tc = hexToAnsi(skin.colors.accent);
  const tx = hexToAnsi(skin.colors.muted);

  console.log(`${bc}╭${"─".repeat(WIDTH)}╮${reset}`);
  console.log(`${bc}│ ${reset}${tc}${bold}${skin.branding.agentName.padEnd(WIDTH - 1)}${reset}${bc}│${reset}`);
  console.log(`${bc}│ ${reset}${tx}${skin.branding.welcome.padEnd(WIDTH - 1)}${reset}${bc}│${reset}`);
  console.log(`${bc}╰${"─".repeat(WIDTH)}╯${reset}`);
  console.log();
};
