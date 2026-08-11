import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  acquireDesktopClientLock,
  releaseDesktopClientLock,
  type DesktopClientLockHandle
} from './desktop-client-lock.mts'
import { asObject } from './value-validation.mts'

const defaultMockScenario = 'ready-idle'
const protocolVersion = 1
const defaultRequestTimeoutMilliseconds = 10_000
const defaultMaximumFrameBytes = 8 * 1024 * 1024

export const backendUnavailableMessage =
  'Tasks are unavailable because no Railgun backend is configured.'

export interface BackendLaunch {
  executablePath: string
  arguments: string[]
  currentDirectory: string
  dataLockDirectory?: string
  environment?: NodeJS.ProcessEnv
}

export interface BackendProcessManagerOptions {
  initializationTimeoutMilliseconds?: number
  maximumFrameBytes?: number
  requestTimeoutMilliseconds?: number
}

export interface BackendRequestOptions {
  timeout?: 'default' | 'none'
}

interface PendingRequest {
  command: string
  reject: (error: Error) => void
  resolve: (data: unknown) => void
  timeout?: NodeJS.Timeout
}

function configuredValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[key]?.trim()
  return value ? value : undefined
}

export function resolveBackendLaunch(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  packagedResourcesPath?: string
): BackendLaunch | undefined {
  const mode = configuredValue(environment, 'RAILGUNX_BACKEND_MODE')
  if (!mode || mode === 'bundled') {
    if (!packagedResourcesPath) {
      if (mode === 'bundled') {
        throw new Error('Packaged resources are required when the bundled backend is enabled')
      }
      return undefined
    }

    const home = configuredValue(environment, 'HOME')
    if (!home) {
      throw new Error('HOME is required when the bundled backend is enabled')
    }
    const backendDirectory = join(resolve(packagedResourcesPath), 'backend')
    const executableName = platform === 'win32' ? 'railgun-backend.exe' : 'railgun-backend'
    return {
      executablePath: join(backendDirectory, executableName),
      arguments: ['desktop'],
      currentDirectory: backendDirectory,
      dataLockDirectory: join(resolve(home), '.railgun'),
      environment: { ...environment, RAILGUN_DESKTOP_RPC: '1' }
    }
  }

  if (mode !== 'source' && mode !== 'mock') {
    throw new Error(`Unsupported Electron backend mode: ${mode}`)
  }

  const configuredRoot = configuredValue(environment, 'RAILGUNX_SOURCE_ROOT')
  if (!configuredRoot) {
    throw new Error(`RAILGUNX_SOURCE_ROOT is required when the ${mode} backend is enabled`)
  }

  const sourceRoot = resolve(configuredRoot)
  const binaryName = mode === 'source' ? 'railgun-backend' : 'railgun-mock-backend'
  const executableName = platform === 'win32' ? `${binaryName}.exe` : binaryName
  const home = mode === 'source' ? configuredValue(environment, 'HOME') : undefined
  if (mode === 'source' && !home) {
    throw new Error('HOME is required when the source backend is enabled')
  }

  return {
    executablePath: join(sourceRoot, 'target', 'debug', executableName),
    arguments:
      mode === 'source'
        ? ['desktop']
        : [configuredValue(environment, 'RAILGUNX_MOCK_SCENARIO') ?? defaultMockScenario],
    currentDirectory: sourceRoot,
    ...(home ? { dataLockDirectory: join(resolve(home), '.railgun') } : {}),
    environment: { ...environment, RAILGUN_DESKTOP_RPC: '1' }
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function validateInitializationData(data: unknown): void {
  const fields = asObject(data)
  if (
    fields?.version !== protocolVersion ||
    !Array.isArray(fields.capabilities) ||
    !fields.capabilities.every((capability) => typeof capability === 'string')
  ) {
    throw new Error('The backend returned an invalid initialization response')
  }
}

export class BackendProcessManager {
  private readonly initializationTimeoutMilliseconds: number
  private readonly maximumFrameBytes: number
  private readonly requestTimeoutMilliseconds: number
  private child: ChildProcessWithoutNullStreams | undefined
  private connectionFailure: Error | undefined
  private dataLock: DesktopClientLockHandle | undefined
  private readonly frameListeners = new Set<(frame: Record<string, unknown>) => void>()
  private isStopping = false
  private nextRequest = 1
  private pending = new Map<string, PendingRequest>()
  private readyState = false
  private readiness: Promise<void> | undefined
  private stdoutBuffer = Buffer.alloc(0)

  constructor(options: BackendProcessManagerOptions = {}) {
    this.initializationTimeoutMilliseconds =
      options.initializationTimeoutMilliseconds ?? defaultRequestTimeoutMilliseconds
    this.maximumFrameBytes = options.maximumFrameBytes ?? defaultMaximumFrameBytes
    this.requestTimeoutMilliseconds =
      options.requestTimeoutMilliseconds ?? defaultRequestTimeoutMilliseconds
  }

  get isReady(): boolean {
    return this.isRunning && this.readyState && this.connectionFailure === undefined
  }

  get isRunning(): boolean {
    return this.child !== undefined && !hasExited(this.child)
  }

  start(launch: BackendLaunch): ChildProcessWithoutNullStreams {
    if (this.isRunning) {
      throw new Error('The backend process is already running')
    }

    const dataLock = launch.dataLockDirectory
      ? acquireDesktopClientLock(launch.dataLockDirectory)
      : undefined
    let child: ChildProcessWithoutNullStreams
    try {
      accessSync(launch.executablePath, constants.X_OK)
      child = spawn(launch.executablePath, launch.arguments, {
        cwd: launch.currentDirectory,
        env: launch.environment,
        stdio: 'pipe'
      })
    } catch (error) {
      if (dataLock) {
        releaseDesktopClientLock(dataLock)
      }
      throw error
    }
    this.child = child
    this.dataLock = dataLock
    this.connectionFailure = undefined
    this.isStopping = false
    this.readyState = false
    this.stdoutBuffer = Buffer.alloc(0)

    child.stderr.pipe(process.stderr, { end: false })
    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(child, chunk))
    child.once('error', (error) => {
      this.handleTermination(child, new Error(`The backend process failed: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      this.handleTermination(
        child,
        new Error(
          this.isStopping
            ? 'The backend process stopped'
            : `The backend process stopped unexpectedly with ${reason}`
        )
      )
    })

    const readiness = this.dispatch(
      'initialize',
      { clientName: 'railgun-electron', version: protocolVersion },
      this.initializationTimeoutMilliseconds
    )
      .then((data) => {
        validateInitializationData(data)
        this.readyState = true
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.failConnection(child, failure)
        throw failure
      })
    this.readiness = readiness
    void readiness.catch(() => undefined)

    return child
  }

  async waitUntilReady(): Promise<void> {
    if (!this.child || !this.readiness) {
      throw new Error(backendUnavailableMessage)
    }
    await this.readiness
  }

  async request(
    command: string,
    fields: Record<string, unknown> = {},
    options: BackendRequestOptions = {}
  ): Promise<unknown> {
    await this.waitUntilReady()
    return this.dispatch(
      command,
      fields,
      options.timeout === 'none' ? undefined : this.requestTimeoutMilliseconds
    )
  }

  subscribeFrames(listener: (frame: Record<string, unknown>) => void): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  async stop(gracePeriodMilliseconds = 2_000): Promise<void> {
    const child = this.child
    if (!child || hasExited(child)) {
      this.child = undefined
      this.releaseDataLock()
      return
    }

    this.isStopping = true
    this.readyState = false
    this.rejectPending(new Error('The backend process stopped'))
    const exited = new Promise<void>((resolveExit) => {
      child.once('exit', () => resolveExit())
      child.once('error', () => resolveExit())
    })

    child.stdin.end()
    child.kill('SIGTERM')

    const forcedTermination = setTimeout(() => {
      if (!hasExited(child)) {
        child.kill('SIGKILL')
      }
    }, gracePeriodMilliseconds)

    await exited
    clearTimeout(forcedTermination)
    if (this.child === child) {
      this.child = undefined
    }
  }

  private consumeStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (this.child !== child || this.connectionFailure) {
      return
    }

    let remaining = chunk
    while (remaining.length > 0) {
      const newline = remaining.indexOf(0x0a)
      const segment = newline < 0 ? remaining : remaining.subarray(0, newline)
      if (!this.appendFrameSegment(child, segment)) {
        return
      }
      if (newline < 0) {
        return
      }

      const line = this.stdoutBuffer.toString('utf8').trim()
      this.stdoutBuffer = Buffer.alloc(0)
      if (line) {
        this.consumeFrame(child, line)
      }
      if (this.connectionFailure) {
        return
      }
      remaining = remaining.subarray(newline + 1)
    }
  }

  private appendFrameSegment(child: ChildProcessWithoutNullStreams, segment: Buffer): boolean {
    const frameBytes = this.stdoutBuffer.length + segment.length
    if (frameBytes > this.maximumFrameBytes) {
      this.stdoutBuffer = Buffer.alloc(0)
      this.failConnection(child, new Error('The backend emitted an oversized JSONL frame'))
      return false
    }
    if (segment.length === 0) {
      return true
    }

    this.stdoutBuffer =
      this.stdoutBuffer.length === 0
        ? Buffer.from(segment)
        : Buffer.concat([this.stdoutBuffer, segment], frameBytes)
    return true
  }

  private consumeFrame(child: ChildProcessWithoutNullStreams, line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.failConnection(child, new Error('The backend emitted malformed JSONL output'))
      return
    }

    const frame = asObject(value)
    if (!frame) {
      this.failConnection(child, new Error('The backend emitted an invalid JSONL frame'))
      return
    }
    if (frame.type !== 'response') {
      for (const listener of this.frameListeners) {
        listener(frame)
      }
      return
    }

    const id = typeof frame.id === 'string' ? frame.id : undefined
    if (!id) {
      this.failConnection(child, new Error('The backend emitted an uncorrelated response'))
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    if (frame.command !== pending.command || typeof frame.success !== 'boolean') {
      const error = new Error(`The backend returned an invalid response for ${pending.command}`)
      this.settleRequest(id, error)
      this.failConnection(child, error)
      return
    }
    if (!frame.success) {
      const detail =
        typeof frame.error === 'string' && frame.error.trim()
          ? frame.error.trim()
          : 'The backend rejected the request'
      this.settleRequest(id, new Error(detail))
      return
    }

    this.settleRequest(id, undefined, frame.data)
  }

  private dispatch(
    command: string,
    fields: Record<string, unknown>,
    timeoutMilliseconds: number | undefined
  ): Promise<unknown> {
    const child = this.child
    if (!child || hasExited(child)) {
      return Promise.reject(new Error(backendUnavailableMessage))
    }
    if (this.connectionFailure) {
      return Promise.reject(this.connectionFailure)
    }

    const id = `electron-${this.nextRequest}`
    this.nextRequest += 1
    const frame = `${JSON.stringify({ ...fields, id, type: command })}\n`

    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const request: PendingRequest = {
        command,
        reject: rejectRequest,
        resolve: resolveRequest
      }
      if (timeoutMilliseconds !== undefined) {
        request.timeout = setTimeout(() => {
          if (this.pending.delete(id)) {
            rejectRequest(new Error(`Backend request ${command} timed out`))
          }
        }, timeoutMilliseconds)
      }
      this.pending.set(id, request)

      child.stdin.write(frame, 'utf8', (error) => {
        if (error) {
          this.settleRequest(id, new Error(`Could not send ${command} to the backend`))
        }
      })
    })
  }

  private settleRequest(id: string, error?: Error, data?: unknown): void {
    const request = this.pending.get(id)
    if (!request) {
      return
    }
    this.pending.delete(id)
    if (request.timeout) {
      clearTimeout(request.timeout)
    }
    if (error) {
      request.reject(error)
    } else {
      request.resolve(data)
    }
  }

  private rejectPending(error: Error): void {
    const requests = [...this.pending.values()]
    this.pending.clear()
    for (const request of requests) {
      if (request.timeout) {
        clearTimeout(request.timeout)
      }
      request.reject(error)
    }
  }

  private failConnection(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child || this.connectionFailure) {
      return
    }
    this.connectionFailure = error
    this.readyState = false
    this.rejectPending(error)
    if (!hasExited(child)) {
      child.kill('SIGTERM')
    }
  }

  private handleTermination(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) {
      return
    }
    this.child = undefined
    this.releaseDataLock()
    this.readyState = false
    this.connectionFailure ??= error
    this.rejectPending(this.connectionFailure)
  }

  private releaseDataLock(): void {
    const dataLock = this.dataLock
    this.dataLock = undefined
    if (dataLock) {
      releaseDesktopClientLock(dataLock)
    }
  }
}
