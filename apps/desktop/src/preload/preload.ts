import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "../shared/types";
import type { BackendSnapshot, RailgunDesktopApi } from "../shared/types";

const api: RailgunDesktopApi = {
  getBackendSnapshot: () => ipcRenderer.invoke(DESKTOP_IPC.getBackendSnapshot) as Promise<BackendSnapshot>,
  onBackendSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: BackendSnapshot): void => listener(snapshot);
    ipcRenderer.on(DESKTOP_IPC.backendSnapshot, handler);
    return () => ipcRenderer.removeListener(DESKTOP_IPC.backendSnapshot, handler);
  },
  listMockScenarios: () => ipcRenderer.invoke(DESKTOP_IPC.listMockScenarios),
  selectMockScenario: (id) => ipcRenderer.invoke(DESKTOP_IPC.selectMockScenario, id),
};

contextBridge.exposeInMainWorld("railgunDesktop", Object.freeze(api));
