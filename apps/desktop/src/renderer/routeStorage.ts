export type AppArea = "chat" | "automation" | "knowledge" | "settings";

const ROUTE_STORAGE_KEY = "railgun.desktop.route";

export const readStoredArea = (storage: Pick<Storage, "getItem">): AppArea => {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(ROUTE_STORAGE_KEY) ?? "null");
    return typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).version === 1
      && (["chat", "automation", "knowledge", "settings"] as const).includes((parsed as Record<string, unknown>).area as AppArea)
      ? (parsed as { area: AppArea }).area : "chat";
  } catch { return "chat"; }
};

export const writeStoredArea = (storage: Pick<Storage, "setItem">, area: AppArea): void => {
  storage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({ version: 1, area }));
};
