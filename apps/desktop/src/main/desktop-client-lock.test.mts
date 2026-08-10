import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  acquireDesktopClientLock,
  releaseDesktopClientLock,
  type DesktopClientLockRecord
} from './desktop-client-lock.mts'

const liveRecord: DesktopClientLockRecord = {
  pid: 4242,
  bundleId: 'io.anvia.other-railgun',
  clientName: 'Other Railgun client',
  startTime: '2026-07-18T11:00:00Z'
}

function lockDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'railgun-electron-lock-'))
  context.after(() => rmSync(directory, { force: true, recursive: true }))
  return directory
}

test('desktop client lock creates and releases the shared record', (context): void => {
  const directory = lockDirectory(context)
  context.after(() => releaseDesktopClientLock(handle))
  const handle = acquireDesktopClientLock(directory, {
    processID: 4243,
    startTime: '2026-07-18T12:00:00Z'
  })

  assert.deepEqual(JSON.parse(readFileSync(handle.filePath, 'utf8')), handle.record)
  assert.equal(statSync(handle.filePath).mode & 0o777, 0o600)

  releaseDesktopClientLock(handle)
  assert.throws(() => readFileSync(handle.filePath), /ENOENT/)
})

test('desktop client lock rejects live and malformed records without deleting them', (context): void => {
  const directory = lockDirectory(context)
  const filePath = join(directory, 'desktop-client.lock')
  const owner = acquireDesktopClientLock(directory, {
    processID: liveRecord.pid,
    startTime: liveRecord.startTime
  })
  writeFileSync(filePath, JSON.stringify(liveRecord))

  assert.throws(
    () =>
      acquireDesktopClientLock(directory, {
        processID: 4243,
        isProcessLive: (pid) => pid === liveRecord.pid
      }),
    /already in use by Other Railgun client.*PID 4242/
  )
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), liveRecord)

  writeFileSync(filePath, 'not JSON')
  assert.throws(
    () => acquireDesktopClientLock(directory, { processID: 4243 }),
    /invalid.*cannot be recovered/i
  )
  assert.equal(readFileSync(filePath, 'utf8'), 'not JSON')
  releaseDesktopClientLock(owner)
})

test('desktop client lock recovers stale records and never removes a replacement', (context): void => {
  const directory = lockDirectory(context)
  const initial = acquireDesktopClientLock(directory, {
    processID: liveRecord.pid,
    startTime: liveRecord.startTime
  })
  const recoveryPath = join(directory, 'desktop-client.lock.recovery')
  writeFileSync(initial.filePath, JSON.stringify(liveRecord))
  writeFileSync(recoveryPath, JSON.stringify(liveRecord))

  const handle = acquireDesktopClientLock(directory, {
    processID: 4243,
    startTime: '2026-07-18T12:00:00Z',
    isProcessLive: (pid) => pid === 4243
  })
  assert.equal(handle.record.pid, 4243)

  writeFileSync(handle.filePath, JSON.stringify(liveRecord))
  releaseDesktopClientLock(handle)
  assert.deepEqual(JSON.parse(readFileSync(handle.filePath, 'utf8')), liveRecord)
})
