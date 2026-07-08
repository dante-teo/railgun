import type Spinner from "ink-spinner";
import type { ComponentProps } from "react";

type SpinnerType = NonNullable<ComponentProps<typeof Spinner>["type"]>;

export interface SkinConfig {
  readonly name: string;
  readonly colors: {
    readonly bannerBorder: string;
    readonly bannerTitle: string;
    readonly bannerAccent: string;
    readonly bannerText: string;
    readonly promptSymbol: string;
  };
  readonly spinnerType: SpinnerType;
  readonly branding: {
    readonly agentName: string;
    readonly welcome: string;
  };
}

export const DEFAULT_SKIN: SkinConfig = {
  name: "default",
  colors: {
    bannerBorder: "#FFD700",
    bannerTitle: "#FFD700",
    bannerAccent: "#CD7F32",
    bannerText: "#FFF8DC",
    promptSymbol: "❯",
  },
  spinnerType: "dots",
  branding: { agentName: "Railgun", welcome: "Welcome back." },
};

export const BUILTIN_SKINS: Readonly<Record<string, SkinConfig>> = {
  default: DEFAULT_SKIN,
  mono: {
    name: "mono",
    colors: {
      bannerBorder: "#888888",
      bannerTitle: "#CCCCCC",
      bannerAccent: "#888888",
      bannerText: "#EEEEEE",
      promptSymbol: ">",
    },
    spinnerType: "line",
    branding: { agentName: "Railgun", welcome: "Ready." },
  },
};

export const DEFAULT_SKIN_NAME = "default";

export const resolveSkin = (name: string): SkinConfig | undefined =>
  BUILTIN_SKINS[name];
