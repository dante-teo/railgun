import { spawn } from "node:child_process";

export const openUrlInBrowser = (url: string): void => {
  console.error(`Open this URL to sign in to Devin: ${url}`);
  const [command, args] =
    process.platform === "darwin"
      ? (["open", [url]] as const)
      : process.platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.error("Could not launch a browser automatically; open the URL above manually.");
    });
    child.unref();
  } catch {
    console.error("Could not launch a browser automatically; open the URL above manually.");
  }
};
