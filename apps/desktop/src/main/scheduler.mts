import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { build, parse, type PlistValue } from 'plist'

import type { SchedulerStatus } from '../shared/scheduler-api.ts'
import { asObject } from './value-validation.mts'

export const schedulerLabel = 'sh.railgun.cron'
export const legacySchedulerLabel = 'sh.railgun.dream'

export interface SchedulerTarget {
  readonly bundled: boolean
  readonly executablePath: string
  readonly homeDirectory: string
  readonly version: string
  readonly workingDirectory: string
}

export interface LaunchctlResult {
  readonly code: number
  readonly stderr: string
  readonly stdout: string
}

export type LaunchctlRunner = (
  executable: string,
  arguments_: readonly string[]
) => Promise<LaunchctlResult>

export interface SchedulerServiceOptions {
  readonly platform?: NodeJS.Platform
  readonly runner?: LaunchctlRunner
  readonly target?: SchedulerTarget
  readonly uid?: number
}

function defaultRunner(
  executable: string,
  arguments_: readonly string[]
): Promise<LaunchctlResult> {
  return new Promise((resolve) => {
    execFile(executable, arguments_, { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code =
        error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0
      resolve({ code, stdout, stderr })
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
}

async function executableHash(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined
}

function arraysEqual(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && left.every((value, index) => value === right[index])
}

function unavailable(detail: string): SchedulerStatus {
  return { state: 'unavailable', detail }
}

function serviceIsMissing(result: LaunchctlResult): boolean {
  return (
    result.code === 113 ||
    (result.code !== 0 && /\bcould not find (?:specified )?service\b/iu.test(result.stderr))
  )
}

export class SchedulerService {
  private readonly platform: NodeJS.Platform
  private readonly runner: LaunchctlRunner
  private readonly target?: SchedulerTarget
  private readonly uid?: number
  private mutationTail: Promise<unknown> = Promise.resolve()

  constructor(options: SchedulerServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.runner = options.runner ?? defaultRunner
    this.target = options.target
    this.uid = options.uid ?? process.getuid?.()
  }

  get plistPath(): string | undefined {
    return this.target
      ? join(this.target.homeDirectory, 'Library', 'LaunchAgents', `${schedulerLabel}.plist`)
      : undefined
  }

  get legacyPlistPath(): string | undefined {
    return this.target
      ? join(this.target.homeDirectory, 'Library', 'LaunchAgents', `${legacySchedulerLabel}.plist`)
      : undefined
  }

  async getStatus(): Promise<SchedulerStatus> {
    await this.mutationTail.catch(() => undefined)
    return this.getStatusImmediately()
  }

  install(): Promise<SchedulerStatus> {
    return this.serialize(() => this.installImmediately())
  }

  uninstall(): Promise<SchedulerStatus> {
    return this.serialize(() => this.uninstallImmediately())
  }

  async repairStaleBundledInstallation(): Promise<void> {
    if (!this.target?.bundled || !this.plistPath || !(await exists(this.plistPath))) {
      return
    }
    const status = await this.getStatus()
    if (status.state === 'repair-needed') {
      await this.install().catch(() => undefined)
    }
  }

  private serialize(operation: () => Promise<SchedulerStatus>): Promise<SchedulerStatus> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result
    return result
  }

  private availability(): SchedulerStatus | undefined {
    if (this.platform !== 'darwin') {
      return unavailable('Background Scheduling is available on macOS only.')
    }
    if (!this.target || this.uid === undefined) {
      return unavailable('The current backend launch cannot be scheduled.')
    }
    return undefined
  }

  private domain(): string {
    return `gui/${this.uid}`
  }

  private serviceTarget(label = schedulerLabel): string {
    return `${this.domain()}/${label}`
  }

  private async unloadService(plistPath: string, label: string): Promise<void> {
    const bootout = await this.runner('/bin/launchctl', ['bootout', this.domain(), plistPath])
    const verification = await this.runner('/bin/launchctl', ['print', this.serviceTarget(label)])
    if (serviceIsMissing(verification)) {
      return
    }
    const detail = (bootout.code !== 0 ? bootout.stderr.trim() : '') || verification.stderr.trim()
    throw new Error(detail || `Could not unload the ${label} background scheduler`)
  }

  private async expectedDocument(): Promise<{ [key: string]: PlistValue }> {
    const target = this.target
    if (!target) {
      throw new Error('The current backend launch cannot be scheduled')
    }
    const hash = await executableHash(target.executablePath)
    const logDirectory = join(target.homeDirectory, '.railgun', 'logs')
    return {
      Label: schedulerLabel,
      ProgramArguments: [target.executablePath, 'scheduler'],
      WorkingDirectory: target.workingDirectory,
      RunAtLoad: true,
      KeepAlive: true,
      ProcessType: 'Background',
      ThrottleInterval: 30,
      StandardOutPath: join(logDirectory, 'scheduler.log'),
      StandardErrorPath: join(logDirectory, 'scheduler.log'),
      EnvironmentVariables: {
        HOME: target.homeDirectory,
        RAILGUN_SCHEDULER_EXECUTABLE_SHA256: hash,
        RAILGUN_SCHEDULER_VERSION: target.version
      }
    }
  }

  private async getStatusImmediately(): Promise<SchedulerStatus> {
    const unavailableStatus = this.availability()
    if (unavailableStatus) {
      return unavailableStatus
    }
    const plistPath = this.plistPath!
    const legacyPath = this.legacyPlistPath!
    if (!(await exists(plistPath))) {
      return { state: 'not-installed', detail: null }
    }

    try {
      const metadata = await lstat(plistPath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
        return {
          state: 'repair-needed',
          detail: 'The LaunchAgent file is not private and regular.'
        }
      }
      if (await exists(legacyPath)) {
        return { state: 'repair-needed', detail: 'A retired background agent still needs cleanup.' }
      }
      const current = asObject(parse(await readFile(plistPath, 'utf8')))
      const expected = await this.expectedDocument()
      const currentEnvironment = asObject(current?.EnvironmentVariables)
      const expectedEnvironment = asObject(expected.EnvironmentVariables)!
      const matches =
        current?.Label === expected.Label &&
        arraysEqual(
          stringArray(current?.ProgramArguments),
          expected.ProgramArguments as string[]
        ) &&
        current?.WorkingDirectory === expected.WorkingDirectory &&
        current?.RunAtLoad === true &&
        current?.KeepAlive === true &&
        currentEnvironment?.HOME === expectedEnvironment.HOME &&
        currentEnvironment?.RAILGUN_SCHEDULER_EXECUTABLE_SHA256 ===
          expectedEnvironment.RAILGUN_SCHEDULER_EXECUTABLE_SHA256 &&
        currentEnvironment?.RAILGUN_SCHEDULER_VERSION ===
          expectedEnvironment.RAILGUN_SCHEDULER_VERSION
      if (!matches) {
        return { state: 'repair-needed', detail: 'The installed LaunchAgent is out of date.' }
      }
    } catch {
      return { state: 'repair-needed', detail: 'The installed LaunchAgent could not be verified.' }
    }

    const result = await this.runner('/bin/launchctl', ['print', this.serviceTarget()])
    return result.code === 0 && /\bstate\s*=\s*running\b/u.test(result.stdout)
      ? { state: 'running', detail: null }
      : { state: 'stopped', detail: null }
  }

  private async installImmediately(): Promise<SchedulerStatus> {
    const unavailableStatus = this.availability()
    if (unavailableStatus) {
      return unavailableStatus
    }
    const target = this.target!
    const plistPath = this.plistPath!
    const legacyPath = this.legacyPlistPath!
    const launchAgentsDirectory = dirname(plistPath)
    const logDirectory = join(target.homeDirectory, '.railgun', 'logs')

    await Promise.all([
      this.unloadService(plistPath, schedulerLabel),
      this.unloadService(legacyPath, legacySchedulerLabel)
    ])
    await unlinkIfPresent(legacyPath)
    await mkdir(launchAgentsDirectory, { recursive: true, mode: 0o700 })
    await mkdir(logDirectory, { recursive: true, mode: 0o700 })
    await chmod(logDirectory, 0o700)

    const temporaryPath = `${plistPath}.tmp-${process.pid}`
    await writeFile(temporaryPath, build(await this.expectedDocument()), { mode: 0o600 })
    await chmod(temporaryPath, 0o600)
    await rename(temporaryPath, plistPath)

    const bootstrapped = await this.runner('/bin/launchctl', [
      'bootstrap',
      this.domain(),
      plistPath
    ])
    if (bootstrapped.code !== 0) {
      throw new Error(bootstrapped.stderr.trim() || 'Could not install the background scheduler')
    }
    const started = await this.runner('/bin/launchctl', ['kickstart', '-k', this.serviceTarget()])
    if (started.code !== 0) {
      throw new Error(started.stderr.trim() || 'Could not start the background scheduler')
    }
    return this.getStatusImmediately()
  }

  private async uninstallImmediately(): Promise<SchedulerStatus> {
    const unavailableStatus = this.availability()
    if (unavailableStatus) {
      return unavailableStatus
    }
    const plistPath = this.plistPath!
    const legacyPath = this.legacyPlistPath!
    await Promise.all([
      this.unloadService(plistPath, schedulerLabel),
      this.unloadService(legacyPath, legacySchedulerLabel)
    ])
    await Promise.all([unlinkIfPresent(plistPath), unlinkIfPresent(legacyPath)])
    return { state: 'not-installed', detail: null }
  }
}
