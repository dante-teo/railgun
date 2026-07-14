import { contextBridge, ipcRenderer } from "electron";
import {
  AppCommandSchema,
  BackendSnapshotSchema,
  DesktopAgentEventSchema,
  EmptyResponseSchema,
  ExternalUrlSchema,
  MockScenarioIdSchema,
  MockScenarioListSchema,
  PromptTextSchema,
} from "../shared/schemas";
import { DESKTOP_IPC } from "../shared/types";
import type { AppCommand, RailgunDesktopApi } from "../shared/types";

interface IpcTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export const createDesktopApi = (transport: IpcTransport): RailgunDesktopApi => {
  const appCommandListeners = new Set<(command: AppCommand) => void>();
  const pendingAppCommands: AppCommand[] = [];
  let appCommandSubscribed = true;
  const appCommandHandler = (_event: unknown, payload: unknown): void => {
    const result = AppCommandSchema.safeParse(payload);
    if (!result.success) return;
    if (appCommandListeners.size === 0) {
      pendingAppCommands.push(result.data);
      return;
    }
    for (const listener of appCommandListeners) listener(result.data);
  };
  transport.on(DESKTOP_IPC.appCommand, appCommandHandler);

  return {
    getBackendSnapshot: async () => BackendSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.getBackendSnapshot),
    ),
    restartBackend: async () => BackendSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.restartBackend),
    ),
    onBackendSnapshot: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const result = BackendSnapshotSchema.safeParse(payload);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_IPC.backendSnapshot, handler);
      return () => transport.removeListener(DESKTOP_IPC.backendSnapshot, handler);
    },
    listMockScenarios: async () => MockScenarioListSchema.parse(
      await transport.invoke(DESKTOP_IPC.listMockScenarios),
    ),
    selectMockScenario: async (id) => {
      const validId = MockScenarioIdSchema.parse(id);
      return BackendSnapshotSchema.parse(
        await transport.invoke(DESKTOP_IPC.selectMockScenario, validId),
      );
    },
    sendPrompt: async (message) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.sendPrompt, PromptTextSchema.parse(message)),
      );
    },
    steerPrompt: async (message) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.steerPrompt, PromptTextSchema.parse(message)),
      );
    },
    followUpPrompt: async (message) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.followUpPrompt, PromptTextSchema.parse(message)),
      );
    },
    abortPrompt: async () => {
      EmptyResponseSchema.parse(await transport.invoke(DESKTOP_IPC.abortPrompt));
    },
    openExternal: async (url) => {
      EmptyResponseSchema.parse(
        await transport.invoke(DESKTOP_IPC.openExternal, ExternalUrlSchema.parse(url)),
      );
    },
    startNewChat: async () => BackendSnapshotSchema.parse(
      await transport.invoke(DESKTOP_IPC.startNewChat),
    ),
    onAgentEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const result = DesktopAgentEventSchema.safeParse(payload);
        if (result.success) listener(result.data);
      };
      transport.on(DESKTOP_IPC.agentEvent, handler);
      return () => transport.removeListener(DESKTOP_IPC.agentEvent, handler);
    },
    onAppCommand: (listener) => {
      if (!appCommandSubscribed) {
        transport.on(DESKTOP_IPC.appCommand, appCommandHandler);
        appCommandSubscribed = true;
      }
      appCommandListeners.add(listener);
      for (const command of pendingAppCommands.splice(0)) listener(command);
      return () => {
        appCommandListeners.delete(listener);
        if (appCommandListeners.size === 0 && appCommandSubscribed) {
          transport.removeListener(DESKTOP_IPC.appCommand, appCommandHandler);
          appCommandSubscribed = false;
        }
      };
    },
  };
};

const api = Object.freeze(createDesktopApi(ipcRenderer));
contextBridge.exposeInMainWorld("railgunDesktop", api);
