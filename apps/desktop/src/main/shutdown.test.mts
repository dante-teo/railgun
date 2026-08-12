import assert from 'node:assert/strict'
import test from 'node:test'

import { createShutdownCoordinator } from './shutdown.mts'

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

test('normal quit prevents the first event, stops once, then resumes app quit', async (): Promise<void> => {
  const order: string[] = []
  let prevented = 0
  const coordinator = createShutdownCoordinator({
    quitAndInstall: () => order.push('install'),
    quitApp: () => order.push('quit'),
    stopBackend: async () => {
      order.push('stop')
    }
  })

  coordinator.handleBeforeQuit({ preventDefault: () => (prevented += 1) })
  coordinator.handleBeforeQuit({ preventDefault: () => (prevented += 1) })
  await coordinator.whenSettled()

  assert.equal(prevented, 2)
  assert.deepEqual(order, ['stop', 'quit'])

  coordinator.handleBeforeQuit({ preventDefault: () => assert.fail('final quit must continue') })
})

test('backend stop is deduplicated and updater restart wins a shutdown race', async (): Promise<void> => {
  const stopping = deferred()
  let stops = 0
  let quits = 0
  let installs = 0
  const coordinator = createShutdownCoordinator({
    quitAndInstall: () => (installs += 1),
    quitApp: () => (quits += 1),
    stopBackend: () => {
      stops += 1
      return stopping.promise
    }
  })

  const quit = coordinator.quitNormally()
  const install = coordinator.restartToInstall()
  const repeatedInstall = coordinator.restartToInstall()
  assert.equal(stops, 1)

  stopping.resolve()
  await Promise.all([quit, install, repeatedInstall])

  assert.equal(stops, 1)
  assert.equal(quits, 0)
  assert.equal(installs, 1)
})

test('shutdown continues after a backend stop failure and reports it once', async (): Promise<void> => {
  const failure = new Error('backend did not stop cleanly')
  const reported: unknown[] = []
  let installs = 0
  const coordinator = createShutdownCoordinator({
    quitAndInstall: () => (installs += 1),
    quitApp: () => assert.fail('update restart should take precedence'),
    reportError: (error) => reported.push(error),
    stopBackend: async () => Promise.reject(failure)
  })

  await coordinator.restartToInstall()

  assert.deepEqual(reported, [failure])
  assert.equal(installs, 1)
})
