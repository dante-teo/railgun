import type { RailgunDesktopApi } from "./types";

declare global {
  interface Window {
    readonly railgunDesktop: RailgunDesktopApi;
  }

  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
}

export {};
