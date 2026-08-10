import type { ContextUsageSnapshot, ContextUsageUpdate } from '../shared/context-usage-api.ts'
import { emptyContextUsageSnapshot } from '../shared/context-usage-api.ts'
import { asObject, nonNegativeInteger, positiveInteger } from './value-validation.mts'

type ContextUsageAction =
  | { type: 'configuration'; contextWindow: number; usedTokens: number | null }
  | { type: 'usage'; usedTokens: number }

export interface ContextUsageBackend {
  request(command: string, fields?: Record<string, unknown>): Promise<unknown>
  subscribeFrames(listener: (frame: Record<string, unknown>) => void): () => void
}

function normalizeUsage(value: unknown): ContextUsageAction | undefined {
  const usage = asObject(value)
  if (!usage) {
    return undefined
  }
  const inputTokens = nonNegativeInteger(usage.inputTokens)
  const outputTokens = nonNegativeInteger(usage.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined
  }
  const usedTokens = inputTokens + outputTokens
  return Number.isSafeInteger(usedTokens) ? { type: 'usage', usedTokens } : undefined
}

function normalizePersistedUsage(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null
  }
  return normalizeUsage(value)?.usedTokens
}

export function normalizeContextUsageFrame(frameValue: unknown): ContextUsageAction | undefined {
  const frame = asObject(frameValue)
  if (!frame || typeof frame.type !== 'string') {
    return undefined
  }
  if (frame.type === 'turn_end') {
    return normalizeUsage(frame.usage)
  }
  if (frame.type !== 'message_update') {
    return undefined
  }
  const streamEvent = asObject(frame.streamEvent)
  return streamEvent?.type === 'usage' ? normalizeUsage(streamEvent) : undefined
}

export function normalizeContextConfiguration(
  stateValue: unknown,
  catalogValue: unknown
): ContextUsageAction | undefined {
  const state = asObject(stateValue)
  const catalog = asObject(catalogValue)
  if (!state || !catalog || typeof state.model !== 'string' || !Array.isArray(catalog.models)) {
    return undefined
  }
  const activeModel = catalog.models.map(asObject).find((model) => model?.id === state.model)
  const contextWindow = positiveInteger(activeModel?.contextWindow)
  const usedTokens = normalizePersistedUsage(state.latestUsage)
  return contextWindow === undefined || usedTokens === undefined
    ? undefined
    : { type: 'configuration', contextWindow, usedTokens }
}

export function reduceContextUsageSnapshot(
  snapshot: ContextUsageSnapshot,
  action: ContextUsageAction
): ContextUsageSnapshot {
  switch (action.type) {
    case 'configuration':
      return snapshot.contextWindow === action.contextWindow &&
        snapshot.usedTokens === action.usedTokens
        ? snapshot
        : { ...snapshot, contextWindow: action.contextWindow, usedTokens: action.usedTokens }
    case 'usage':
      return snapshot.usedTokens === action.usedTokens
        ? snapshot
        : { ...snapshot, usedTokens: action.usedTokens }
  }
}

export class ContextUsageService {
  private readonly backend: ContextUsageBackend
  private readonly listeners = new Set<(update: ContextUsageUpdate) => void>()
  private readonly unsubscribeFrames: () => void
  private hydration: Promise<void> | undefined
  private refreshSequence = 0
  private snapshot = emptyContextUsageSnapshot()

  constructor(backend: ContextUsageBackend) {
    this.backend = backend
    this.unsubscribeFrames = backend.subscribeFrames((frame) => this.consume(frame))
  }

  getSnapshot(): ContextUsageSnapshot {
    return { ...this.snapshot }
  }

  hydrate(): Promise<void> {
    this.hydration ??= this.refresh()
    return this.hydration
  }

  async refresh(): Promise<void> {
    const refreshSequence = ++this.refreshSequence
    const [state, catalog] = await Promise.all([
      this.backend.request('get_state'),
      this.backend.request('get_available_models')
    ])
    const action = normalizeContextConfiguration(state, catalog)
    if (!action) {
      throw new Error('The backend returned an invalid context configuration')
    }
    if (refreshSequence === this.refreshSequence) {
      this.commit(action)
    }
  }

  subscribe(listener: (update: ContextUsageUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.unsubscribeFrames()
    this.listeners.clear()
  }

  private consume(frame: Record<string, unknown>): void {
    const action = normalizeContextUsageFrame(frame)
    if (action) {
      this.commit(action)
    }
  }

  private commit(action: ContextUsageAction): void {
    const next = reduceContextUsageSnapshot(this.snapshot, action)
    if (next === this.snapshot) {
      return
    }
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 }
    const snapshot = this.getSnapshot()
    const update = { revision: snapshot.revision, snapshot }
    for (const listener of this.listeners) {
      listener(update)
    }
  }
}
