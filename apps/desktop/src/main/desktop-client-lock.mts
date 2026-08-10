import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

import { asObject } from './value-validation.mts'

const lockFilename = 'desktop-client.lock'
const recoveryFilename = 'desktop-client.lock.recovery'
const maximumProcessID = 2_147_483_647
const acquisitionAttempts = 3

export interface DesktopClientLockRecord {
  pid: number
  bundleId: string
  clientName: string
  startTime: string
}

export interface DesktopClientLockHandle {
  filePath: string
  record: DesktopClientLockRecord
}

interface DesktopClientLockOptions {
  processID?: number
  startTime?: string
  isProcessLive?: (pid: number) => boolean
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function readRecord(filePath: string): DesktopClientLockRecord {
  const fields = asObject(JSON.parse(readFileSync(filePath, 'utf8')))
  if (
    !fields ||
    !Number.isInteger(fields.pid) ||
    (fields.pid as number) <= 0 ||
    (fields.pid as number) > maximumProcessID ||
    !nonemptyString(fields.bundleId) ||
    !nonemptyString(fields.clientName) ||
    !nonemptyString(fields.startTime)
  ) {
    throw new Error('Invalid desktop-client lock record')
  }

  return {
    pid: fields.pid as number,
    bundleId: fields.bundleId,
    clientName: fields.clientName,
    startTime: fields.startTime
  }
}

function recordsEqual(left: DesktopClientLockRecord, right: DesktopClientLockRecord): boolean {
  return (
    left.pid === right.pid &&
    left.bundleId === right.bundleId &&
    left.clientName === right.clientName &&
    left.startTime === right.startTime
  )
}

function hasCode(error: unknown, code: string): boolean {
  return asObject(error)?.code === code
}

function invalidExistingLock(): Error {
  return new Error('The existing Railgun desktop-client lock is invalid and cannot be recovered')
}

function conflict(record: DesktopClientLockRecord): Error {
  return new Error(`Railgun data is already in use by ${record.clientName} (PID ${record.pid})`)
}

function filesystemFailure(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`Could not manage the shared Railgun desktop-client lock: ${detail}`)
}

function defaultIsProcessLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (hasCode(error, 'ESRCH')) {
      return false
    }
    return true
  }
}

function createFile(filePath: string, record: DesktopClientLockRecord): void {
  const descriptor = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  )
  let needsClose = true

  try {
    const data = Buffer.from(JSON.stringify(record))
    let offset = 0
    while (offset < data.length) {
      const written = writeSync(descriptor, data, offset, data.length - offset)
      if (written <= 0) {
        throw new Error('Could not write the desktop-client lock record')
      }
      offset += written
    }
    fsyncSync(descriptor)
    closeSync(descriptor)
    needsClose = false
  } catch (error) {
    if (needsClose) {
      try {
        closeSync(descriptor)
      } catch {
        // The original write failure is more useful than a second close failure.
      }
    }
    try {
      rmSync(filePath)
    } catch {
      // Acquisition still fails even if cleanup cannot remove our incomplete record.
    }
    throw error
  }
}

function releaseExactRecord(filePath: string, record: DesktopClientLockRecord): void {
  try {
    if (recordsEqual(readRecord(filePath), record)) {
      rmSync(filePath)
    }
  } catch {
    // Never remove a file that cannot be proven to contain our exact record.
  }
}

function claimRecoveryGuard(
  recoveryPath: string,
  record: DesktopClientLockRecord,
  isProcessLive: (pid: number) => boolean
): void {
  for (let attempt = 0; attempt < acquisitionAttempts; attempt += 1) {
    try {
      createFile(recoveryPath, record)
      return
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw filesystemFailure(error)
      }
    }

    let existingRecord: DesktopClientLockRecord
    try {
      existingRecord = readRecord(recoveryPath)
    } catch {
      throw invalidExistingLock()
    }
    if (isProcessLive(existingRecord.pid)) {
      throw conflict(existingRecord)
    }
    try {
      rmSync(recoveryPath)
    } catch (error) {
      throw filesystemFailure(error)
    }
  }

  throw new Error('Could not claim stale Railgun desktop-client lock recovery')
}

export function acquireDesktopClientLock(
  directory: string,
  options: DesktopClientLockOptions = {}
): DesktopClientLockHandle {
  const processID = options.processID ?? process.pid
  if (!Number.isInteger(processID) || processID <= 0 || processID > maximumProcessID) {
    throw new Error('The desktop client process ID must be a positive 32-bit integer')
  }

  const record: DesktopClientLockRecord = {
    pid: processID,
    bundleId: 'io.anvia.railgun',
    clientName: 'Railgun',
    startTime: options.startTime ?? new Date().toISOString()
  }
  const filePath = join(directory, lockFilename)
  const recoveryPath = join(directory, recoveryFilename)
  const isProcessLive = options.isProcessLive ?? defaultIsProcessLive

  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    throw filesystemFailure(error)
  }

  for (let attempt = 0; attempt < acquisitionAttempts; attempt += 1) {
    try {
      createFile(filePath, record)
      return { filePath, record }
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw filesystemFailure(error)
      }
    }

    claimRecoveryGuard(recoveryPath, record, isProcessLive)
    try {
      let existingRecord: DesktopClientLockRecord
      try {
        existingRecord = readRecord(filePath)
      } catch {
        throw invalidExistingLock()
      }
      if (isProcessLive(existingRecord.pid)) {
        throw conflict(existingRecord)
      }

      try {
        rmSync(filePath)
      } catch (error) {
        throw filesystemFailure(error)
      }

      try {
        createFile(filePath, record)
        return { filePath, record }
      } catch (error) {
        if (hasCode(error, 'EEXIST')) {
          continue
        }
        throw filesystemFailure(error)
      }
    } finally {
      releaseExactRecord(recoveryPath, record)
    }
  }

  throw new Error('Could not claim the shared Railgun desktop-client lock')
}

export function releaseDesktopClientLock(handle: DesktopClientLockHandle): void {
  releaseExactRecord(handle.filePath, handle.record)
}
