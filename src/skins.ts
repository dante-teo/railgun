export interface SkinConfig {
  readonly name: string;
  readonly colors: {
    readonly accent: string;
    readonly border: string;
    readonly muted: string;
    readonly dim: string;
    readonly success: string;
    readonly error: string;
    readonly selectedBg: string;
    readonly promptSymbol: string;
    readonly userMessageBg: string;
    readonly toolPendingBg: string;
    readonly toolSuccessBg: string;
    readonly toolErrorBg: string;
    readonly statusLineBg: string;
    readonly statusLineModel: string;
    readonly statusLinePath: string;
    readonly statusLineGitClean: string;
    readonly statusLineGitDirty: string;
  };
  readonly branding: {
    readonly agentName: string;
    readonly welcome: string;
  };
}

export const DEFAULT_SKIN: SkinConfig = {
  name: "default",
  colors: {
    accent: "#febc38",
    border: "#3d424a",
    muted: "#777d88",
    dim: "#5f6673",
    success: "#89d281",
    error: "#fc3a4b",
    selectedBg: "#31363f",
    promptSymbol: "❯",
    userMessageBg: "#2a2f3a",
    toolPendingBg: "#2a2620",
    toolSuccessBg: "#1f2d22",
    toolErrorBg: "#2d1f22",
    statusLineBg: "#22262c",
    statusLineModel: "#febc38",
    statusLinePath: "#777d88",
    statusLineGitClean: "#89d281",
    statusLineGitDirty: "#febc38",
  },
  branding: { agentName: "Railgun", welcome: "Welcome back." },
};

export const BUILTIN_SKINS: Readonly<Record<string, SkinConfig>> = {
  default: DEFAULT_SKIN,
  mono: {
    name: "mono",
    colors: {
      accent: "#5fafaf",
      border: "#3a3a3a",
      muted: "#8a8a8a",
      dim: "#707070",
      success: "#558a55",
      error: "#8a5555",
      selectedBg: "#3a3a3a",
      promptSymbol: ">",
      userMessageBg: "#2e2e2e",
      toolPendingBg: "#333333",
      toolSuccessBg: "#2a3a2a",
      toolErrorBg: "#3a2a2a",
      statusLineBg: "#2a2a2a",
      statusLineModel: "#5fafaf",
      statusLinePath: "#8a8a8a",
      statusLineGitClean: "#558a55",
      statusLineGitDirty: "#5fafaf",
    },
    branding: { agentName: "Railgun", welcome: "Ready." },
  },
};

export const DEFAULT_SKIN_NAME = "default";

export const resolveSkin = (name: string): SkinConfig | undefined =>
  BUILTIN_SKINS[name];
