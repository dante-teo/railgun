export type AppArea = "chat" | "automation" | "settings";

const ROUTE_STORAGE_KEY = "railgun.desktop.route";

export const readStoredArea = (storage: Pick<Storage, "getItem">): AppArea => {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(ROUTE_STORAGE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null || (parsed as Record<string, unknown>).version !== 1) return "chat";
    const area = (parsed as Record<string, unknown>).area;
    if (area === "knowledge") return "settings";
    return (["chat", "automation", "settings"] as const).includes(area as AppArea) ? area as AppArea : "chat";
  } catch { return "chat"; }
};

export const writeStoredArea = (storage: Pick<Storage, "setItem">, area: AppArea): void => {
  storage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({ version: 1, area }));
};
