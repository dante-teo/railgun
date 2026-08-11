import assert from 'node:assert/strict'
import test from 'node:test'

import { startAutomaticUpdates, type AutomaticUpdater } from './automatic-updates.mts'

function stubUpdater(check: () => Promise<unknown> = async () => undefined): AutomaticUpdater & {
  checks: number
  errorListener?: (error: Error) => void
} {
  return {
    allowPrerelease: true,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checks: 0,
    async checkForUpdatesAndNotify(): Promise<unknown> {
      this.checks += 1
      return check()
    },
    on(_event, listener): void {
      this.errorListener = listener
    }
  }
}

test('automatic updates stay disabled outside packaged builds', (): void => {
  const updater = stubUpdater()
  startAutomaticUpdates({
    isPackaged: false,
    reportError: () => assert.fail('development update errors must not be registered'),
    updater,
    version: '1.0.0'
  })

  assert.equal(updater.checks, 0)
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.errorListener, undefined)
})

test('stable packaged builds download updates and reject prerelease channels', (): void => {
  const updater = stubUpdater()
  startAutomaticUpdates({
    isPackaged: true,
    reportError: () => undefined,
    updater,
    version: '1.0.0'
  })

  assert.equal(updater.checks, 1)
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, true)
  assert.equal(updater.allowPrerelease, false)
  assert.equal(typeof updater.errorListener, 'function')
})

test('prerelease builds follow prerelease updates and report rejected checks', async (): Promise<void> => {
  const failure = new Error('update service unavailable')
  const emittedFailure = new Error('download service unavailable')
  const reported: unknown[] = []
  const updater = stubUpdater(async () => Promise.reject(failure))

  startAutomaticUpdates({
    isPackaged: true,
    reportError: (error) => reported.push(error),
    updater,
    version: '1.0.0-rc.1'
  })
  await new Promise((resolveWait) => setImmediate(resolveWait))
  updater.errorListener?.(emittedFailure)

  assert.equal(updater.allowPrerelease, true)
  assert.deepEqual(reported, [failure, emittedFailure])
})
