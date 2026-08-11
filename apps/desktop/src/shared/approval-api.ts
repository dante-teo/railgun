export const approvalGetChannel = 'railgun:approval:get'
export const approvalSetModeChannel = 'railgun:approval:set-mode'
export const approvalSetChannel = 'railgun:approval:set'

export type ApprovalMode = 'manual' | 'smart' | 'off'

export interface ApprovalConfiguration {
  readonly mode: ApprovalMode
  readonly reviewerModelId: string | null
}

export interface ApprovalApi {
  get: () => Promise<ApprovalConfiguration>
  set: (configuration: ApprovalConfiguration) => Promise<ApprovalConfiguration>
  setMode: (mode: ApprovalMode) => Promise<ApprovalConfiguration>
}
