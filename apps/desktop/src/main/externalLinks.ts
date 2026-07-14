import type { IpcMainInvokeEvent } from "electron";
import { ExternalUrlSchema } from "../shared/schemas";
import { assertAuthorizedIpcSender } from "./security";
import type { SenderAuthorizationContext } from "./security";

export const openExternalFromRenderer = async (
  event: IpcMainInvokeEvent,
  value: unknown,
  context: SenderAuthorizationContext,
  openExternal: (url: string) => Promise<void>,
): Promise<void> => {
  assertAuthorizedIpcSender(event, context);
  await openExternal(ExternalUrlSchema.parse(value));
};
