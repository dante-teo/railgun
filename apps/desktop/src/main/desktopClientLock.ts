import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { kill } from "node:process";
import { dirname, join } from "node:path";

export const DESKTOP_CLIENT_LOCK_FILENAME = "desktop-client.lock";
const DESKTOP_CLIENT_LOCK_RECOVERY_FILENAME = "desktop-client.lock.recovery";

export interface DesktopClientLockRecord {
  readonly pid: number;
  readonly bundleId: string;
  readonly clientName: string;
  readonly startTime: string;
}

export interface DesktopClientLockOptions {
  readonly directory: string;
  readonly bundleId?: string;
  readonly clientName?: string;
  readonly pid?: number;
  readonly now?: () => string;
  readonly isProcessLive?: (pid: number) => boolean;
}

export class DesktopClientLockConflictError extends Error {
  constructor(readonly record: DesktopClientLockRecord) {
    super(`${record.clientName} (PID ${record.pid}) is already using Railgun data`);
    this.name = "DesktopClientLockConflictError";
  }
}

export class DesktopClientLockInvalidError extends Error {
  constructor() {
    super("The existing desktop-client lock could not be verified safely");
    this.name = "DesktopClientLockInvalidError";
  }
}

const isRecord = (value: unknown): value is DesktopClientLockRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.pid) && (record.pid as number) > 0
    && typeof record.bundleId === "string" && record.bundleId.trim().length > 0
    && typeof record.clientName === "string" && record.clientName.trim().length > 0
    && typeof record.startTime === "string" && record.startTime.trim().length > 0;
};

const defaultIsProcessLive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Railgun Classic's side of the lock shared with RailgunX.
 *
 * Exclusive file creation makes claiming atomic. A record is removed only when
 * its JSON is valid and its PID no longer exists; malformed files remain in
 * place rather than risking a concurrent client on shared user data.
 */
export class DesktopClientLock {
  readonly filePath: string;
  readonly #recoveryFilePath: string;
  readonly #bundleId: string;
  readonly #clientName: string;
  readonly #pid: number;
  readonly #now: () => string;
  readonly #isProcessLive: (pid: number) => boolean;
  #ownedRecord: DesktopClientLockRecord | undefined;

  constructor(options: DesktopClientLockOptions) {
    const pid = options.pid ?? process.pid;
    const bundleId = options.bundleId ?? "sh.railgun.desktop";
    const clientName = options.clientName ?? "Railgun Classic";
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("The client PID must be positive");
    if (bundleId.trim().length === 0 || clientName.trim().length === 0) {
      throw new RangeError("The client identity must not be blank");
    }
    this.filePath = join(options.directory, DESKTOP_CLIENT_LOCK_FILENAME);
    this.#recoveryFilePath = join(options.directory, DESKTOP_CLIENT_LOCK_RECOVERY_FILENAME);
    this.#bundleId = bundleId;
    this.#clientName = clientName;
    this.#pid = pid;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#isProcessLive = options.isProcessLive ?? defaultIsProcessLive;
  }

  acquire(): DesktopClientLockRecord {
    if (this.#ownedRecord !== undefined) return this.#ownedRecord;

    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const startTime = this.#now();
    if (startTime.trim().length === 0) throw new RangeError("The client start time must not be blank");
    const record: DesktopClientLockRecord = {
      pid: this.#pid,
      bundleId: this.#bundleId,
      clientName: this.#clientName,
      startTime,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.#create(this.filePath, record)) {
        this.#ownedRecord = record;
        return record;
      }

      this.#claimRecoveryGuard(record);
      try {
        const existingRecord = this.#readExistingRecord(this.filePath);
        if (this.#isProcessLive(existingRecord.pid)) throw new DesktopClientLockConflictError(existingRecord);
        rmSync(this.filePath);
        if (this.#create(this.filePath, record)) {
          this.#ownedRecord = record;
          return record;
        }
      } finally {
        this.#releaseFileIfOwned(this.#recoveryFilePath, record);
      }
    }

    throw new Error("Could not claim the shared desktop-client lock");
  }

  release(): void {
    const record = this.#ownedRecord;
    this.#ownedRecord = undefined;
    if (record === undefined) return;
    this.#releaseFileIfOwned(this.filePath, record);
  }

  #claimRecoveryGuard(record: DesktopClientLockRecord): void {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.#create(this.#recoveryFilePath, record)) return;
      const existingRecord = this.#readExistingRecord(this.#recoveryFilePath);
      if (this.#isProcessLive(existingRecord.pid)) throw new DesktopClientLockConflictError(existingRecord);
      rmSync(this.#recoveryFilePath);
    }
    throw new Error("Could not claim stale-lock recovery");
  }

  #releaseFileIfOwned(path: string, record: DesktopClientLockRecord): void {
    try {
      const existing = this.#readExistingRecord(path);
      if (
        existing.pid === record.pid
        && existing.bundleId === record.bundleId
        && existing.clientName === record.clientName
        && existing.startTime === record.startTime
      ) {
        rmSync(path);
      }
    } catch {
      // The lock is already gone, malformed, or owned by another client.
    }
  }

  #create(path: string, record: DesktopClientLockRecord): boolean {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(record));
      fsyncSync(descriptor);
      const openDescriptor = descriptor;
      descriptor = undefined;
      closeSync(openDescriptor);
      return true;
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* Best effort before removal. */ }
        try { rmSync(path); } catch { /* The next acquisition will safely inspect it. */ }
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  #readExistingRecord(path: string): DesktopClientLockRecord {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new DesktopClientLockInvalidError();
    }
    if (!isRecord(value)) throw new DesktopClientLockInvalidError();
    return value;
  }
}
