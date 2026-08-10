import {
  transcriptAbortChannel,
  transcriptApprovalResponseChannel,
  transcriptClarificationResponseChannel,
  transcriptSendChannel,
  transcriptSnapshotChannel,
  transcriptUpdateChannel,
  type TranscriptApi,
  type TranscriptSnapshot,
  type TranscriptSubmission,
  type TranscriptUpdate
} from '../shared/transcript-api.ts'

export interface TranscriptIpcRenderer {
  invoke(channel: string, ...arguments_: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, update: TranscriptUpdate) => void): unknown
  removeListener(
    channel: string,
    listener: (event: unknown, update: TranscriptUpdate) => void
  ): unknown
}

export function createTranscriptApi(ipcRenderer: TranscriptIpcRenderer): TranscriptApi {
  return {
    getSnapshot: () => ipcRenderer.invoke(transcriptSnapshotChannel) as Promise<TranscriptSnapshot>,
    subscribe: (listener) => {
      const handleUpdate = (_event: unknown, update: TranscriptUpdate): void => listener(update)
      ipcRenderer.on(transcriptUpdateChannel, handleUpdate)
      return () => ipcRenderer.removeListener(transcriptUpdateChannel, handleUpdate)
    },
    send: async (sessionId: string, submission: TranscriptSubmission): Promise<void> => {
      await ipcRenderer.invoke(transcriptSendChannel, sessionId, submission)
    },
    abort: async (sessionId: string): Promise<void> => {
      await ipcRenderer.invoke(transcriptAbortChannel, sessionId)
    },
    respondToApproval: async (
      sessionId: string,
      requestId: string,
      approved: boolean
    ): Promise<void> => {
      await ipcRenderer.invoke(transcriptApprovalResponseChannel, sessionId, requestId, approved)
    },
    respondToClarification: async (
      sessionId: string,
      requestId: string,
      answer: string
    ): Promise<void> => {
      await ipcRenderer.invoke(transcriptClarificationResponseChannel, sessionId, requestId, answer)
    }
  }
}
