import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'

const defaultMockScenario = 'ready-idle'

export interface BackendLaunch {
  executablePath: string
  arguments: string[]
  currentDirectory: string
}

function configuredValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[key]?.trim()
  return value ? value : undefined
}

export function resolveBackendLaunch(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): BackendLaunch | undefined {
  const mode = configuredValue(environment, 'RAILGUNX_BACKEND_MODE')
  if (!mode || mode === 'bundled') {
    return undefined
  }

  if (mode !== 'mock') {
    throw new Error(`Unsupported Electron backend mode: ${mode}`)
  }

  const configuredRoot = configuredValue(environment, 'RAILGUNX_SOURCE_ROOT')
  if (!configuredRoot) {
    throw new Error('RAILGUNX_SOURCE_ROOT is required when the mock backend is enabled')
  }

  const sourceRoot = resolve(configuredRoot)
  const executableName = platform === 'win32' ? 'railgun-mock-backend.exe' : 'railgun-mock-backend'

  return {
    executablePath: join(sourceRoot, 'target', 'debug', executableName),
    arguments: [configuredValue(environment, 'RAILGUNX_MOCK_SCENARIO') ?? defaultMockScenario],
    currentDirectory: sourceRoot
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

export class BackendProcessManager {
  private child: ChildProcessWithoutNullStreams | undefined

  get isRunning(): boolean {
    return this.child !== undefined && !hasExited(this.child)
  }

  start(launch: BackendLaunch): ChildProcessWithoutNullStreams {
    if (this.isRunning) {
      throw new Error('The backend process is already running')
    }

    accessSync(launch.executablePath, constants.X_OK)

    const child = spawn(launch.executablePath, launch.arguments, {
      cwd: launch.currentDirectory,
      stdio: 'pipe'
    })
    this.child = child

    child.stderr.pipe(process.stderr, { end: false })
    const clearChild = (): void => {
      if (this.child === child) {
        this.child = undefined
      }
    }
    child.once('error', clearChild)
    child.once('exit', clearChild)

    return child
  }

  async stop(gracePeriodMilliseconds = 2_000): Promise<void> {
    const child = this.child
    if (!child || hasExited(child)) {
      this.child = undefined
      return
    }

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
}
