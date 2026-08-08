import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { BackendProcessManager, resolveBackendLaunch } from './backend-process.mts'

test('resolveBackendLaunch ignores the default bundled mode', (): void => {
  assert.equal(resolveBackendLaunch({}), undefined)
  assert.equal(resolveBackendLaunch({ RAILGUNX_BACKEND_MODE: 'bundled' }), undefined)
})

test('resolveBackendLaunch configures the requested mock scenario', (): void => {
  const sourceRoot = resolve('fixture-repository')

  assert.deepEqual(
    resolveBackendLaunch({
      RAILGUNX_BACKEND_MODE: ' mock ',
      RAILGUNX_MOCK_SCENARIO: ' approval ',
      RAILGUNX_SOURCE_ROOT: sourceRoot
    }),
    {
      executablePath: join(sourceRoot, 'target', 'debug', 'railgun-mock-backend'),
      arguments: ['approval'],
      currentDirectory: sourceRoot
    }
  )
})

test('resolveBackendLaunch requires a source root for mock mode', (): void => {
  assert.throws(
    () => resolveBackendLaunch({ RAILGUNX_BACKEND_MODE: 'mock' }),
    /RAILGUNX_SOURCE_ROOT is required/
  )
})

test('BackendProcessManager owns child startup and shutdown', async (): Promise<void> => {
  const manager = new BackendProcessManager()
  const child = manager.start({
    executablePath: process.execPath,
    arguments: ['--eval', 'process.stdin.resume()'],
    currentDirectory: process.cwd()
  })

  await once(child, 'spawn')
  assert.equal(manager.isRunning, true)

  await manager.stop(100)

  assert.equal(manager.isRunning, false)
  assert.notEqual(child.exitCode ?? child.signalCode, null)
})
