import {
  approvalGetChannel,
  approvalSetModeChannel,
  type ApprovalApi,
  type ApprovalConfiguration,
  type ApprovalMode
} from '../shared/approval-api.ts'

export interface ApprovalIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createApprovalApi(ipcRenderer: ApprovalIpcRenderer): ApprovalApi {
  return {
    get: () => ipcRenderer.invoke(approvalGetChannel) as Promise<ApprovalConfiguration>,
    setMode: (mode: ApprovalMode) =>
      ipcRenderer.invoke(approvalSetModeChannel, mode) as Promise<ApprovalConfiguration>
  }
}
