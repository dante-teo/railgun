import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  BackendProcessManager,
  resolveBackendLaunch,
  type BackendLaunch
} from './backend-process.mts'

function nodeLaunch(source: string): BackendLaunch {
  return {
    executablePath: process.execPath,
    arguments: ['--eval', source],
    currentDirectory: process.cwd()
  }
}

function stopAfterTest(context: TestContext, manager: BackendProcessManager): void {
  context.after(async () => manager.stop(100))
}

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

test('BackendProcessManager initializes from fragmented JSONL and correlates concurrent requests', async (context): Promise<void> => {
  const manager = new BackendProcessManager()
  stopAfterTest(context, manager)
  manager.start(
    nodeLaunch(`
      let buffered = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\\n')) >= 0) {
          const request = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          const response = JSON.stringify({
            type: 'response', id: request.id, command: request.type, success: true,
            data: request.type === 'initialize'
              ? { version: 1, capabilities: ['sessions'] }
              : { marker: request.marker }
          }) + '\\n';
          const delay = request.marker === 'first' ? 25 : 0;
          setTimeout(() => {
            const split = Math.max(1, Math.floor(response.length / 2));
            process.stdout.write(response.slice(0, split));
            setTimeout(() => process.stdout.write(response.slice(split)), 2);
          }, delay);
        }
      });
    `)
  )

  assert.equal(manager.isReady, false)
  await manager.waitUntilReady()
  assert.equal(manager.isReady, true)

  const first = manager.request('session_list', { marker: 'first' })
  const second = manager.request('session_archive', { marker: 'second', sessionId: 'task-2' })
  assert.deepEqual(await second, { marker: 'second' })
  assert.deepEqual(await first, { marker: 'first' })
})

test('BackendProcessManager publishes non-response frames and cleans up subscriptions', async (context): Promise<void> => {
  const manager = new BackendProcessManager()
  stopAfterTest(context, manager)
  const frames: Array<Record<string, unknown>> = []
  const unsubscribe = manager.subscribeFrames((frame) => frames.push(frame))
  manager.start(
    nodeLaunch(`
      let count = 0;
      process.stdin.on('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim());
        process.stdout.write(JSON.stringify({
          type: 'response', id: request.id, command: request.type, success: true,
          data: { version: 1, capabilities: [] }
        }) + '\\n');
        if (count++ === 0) {
          process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
          setTimeout(() => process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n'), 5);
        }
      });
      process.stdin.resume();
    `)
  )

  await manager.waitUntilReady()
  await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  unsubscribe()
  await manager.request('get_state')

  assert.deepEqual(frames, [{ type: 'agent_start' }, { type: 'agent_end' }])
})

test('BackendProcessManager rejects initialization failures', async (context): Promise<void> => {
  const manager = new BackendProcessManager()
  stopAfterTest(context, manager)
  manager.start(
    nodeLaunch(`
      process.stdin.once('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim());
        process.stdout.write(JSON.stringify({
          type: 'response', id: request.id, command: request.type,
          success: false, error: 'mock protocol mismatch'
        }) + '\\n');
      });
      process.stdin.resume();
    `)
  )

  await assert.rejects(manager.waitUntilReady(), /mock protocol mismatch/)
  assert.equal(manager.isReady, false)
})

test('BackendProcessManager rejects oversized unterminated JSONL frames', async (context): Promise<void> => {
  const manager = new BackendProcessManager({
    initializationTimeoutMilliseconds: 200,
    maximumFrameBytes: 64
  })
  stopAfterTest(context, manager)
  manager.start(
    nodeLaunch(`
      process.stdin.once('data', () => {
        process.stdout.write('x'.repeat(65));
      });
      process.stdin.resume();
    `)
  )

  await assert.rejects(manager.waitUntilReady(), /oversized JSONL frame/)
  assert.equal(manager.isReady, false)
})

test('BackendProcessManager times out a request and cleans up for later requests', async (context): Promise<void> => {
  const manager = new BackendProcessManager({ requestTimeoutMilliseconds: 30 })
  stopAfterTest(context, manager)
  manager.start(
    nodeLaunch(`
      let buffered = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\\n')) >= 0) {
          const request = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (request.type === 'never_respond') continue;
          process.stdout.write(JSON.stringify({
            type: 'response', id: request.id, command: request.type, success: true,
            data: request.type === 'initialize'
              ? { version: 1, capabilities: [] }
              : { recovered: true }
          }) + '\\n');
        }
      });
    `)
  )
  await manager.waitUntilReady()

  await assert.rejects(manager.request('never_respond'), /timed out/)
  assert.deepEqual(await manager.request('session_list'), { recovered: true })
})

test('BackendProcessManager supports timeout-free mutation requests', async (context): Promise<void> => {
  const manager = new BackendProcessManager({ requestTimeoutMilliseconds: 20 })
  stopAfterTest(context, manager)
  manager.start(
    nodeLaunch(`
      let buffered = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\\n')) >= 0) {
          const request = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          const response = JSON.stringify({
            type: 'response', id: request.id, command: request.type, success: true,
            data: request.type === 'initialize'
              ? { version: 1, capabilities: [] }
              : { archived: true }
          }) + '\\n';
          setTimeout(() => process.stdout.write(response), request.type === 'initialize' ? 0 : 50);
        }
      });
    `)
  )
  await manager.waitUntilReady()

  assert.deepEqual(
    await manager.request('session_archive', { sessionId: 'task-1' }, { timeout: 'none' }),
    { archived: true }
  )
})

test('BackendProcessManager rejects pending requests when the process terminates', async (context): Promise<void> => {
  const manager = new BackendProcessManager()
  stopAfterTest(context, manager)
  manager.start(
    nodeLaunch(`
      let count = 0;
      process.stdin.on('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim());
        if (count++ === 0) {
          process.stdout.write(JSON.stringify({
            type: 'response', id: request.id, command: request.type, success: true,
            data: { version: 1, capabilities: [] }
          }) + '\\n');
        } else {
          process.exit(23);
        }
      });
      process.stdin.resume();
    `)
  )
  await manager.waitUntilReady()

  await assert.rejects(manager.request('session_list'), /stopped unexpectedly with exit code 23/)
  assert.equal(manager.isRunning, false)
})

test('BackendProcessManager rejects invalid correlated responses', async (context): Promise<void> => {
  const manager = new BackendProcessManager()
  stopAfterTest(context, manager)
  manager.start(
    nodeLaunch(`
      let count = 0;
      process.stdin.on('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim());
        process.stdout.write(JSON.stringify(count++ === 0 ? {
          type: 'response', id: request.id, command: request.type, success: true,
          data: { version: 1, capabilities: [] }
        } : {
          type: 'response', id: request.id, command: request.type, success: 'yes'
        }) + '\\n');
      });
      process.stdin.resume();
    `)
  )
  await manager.waitUntilReady()

  await assert.rejects(manager.request('session_list'), /invalid response for session_list/)
  assert.equal(manager.isReady, false)
})

test('BackendProcessManager owns child startup and shutdown', async (): Promise<void> => {
  const manager = new BackendProcessManager()
  const child = manager.start(
    nodeLaunch(`
      process.stdin.once('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim());
        process.stdout.write(JSON.stringify({
          type: 'response', id: request.id, command: request.type, success: true,
          data: { version: 1, capabilities: [] }
        }) + '\\n');
      });
      process.stdin.resume();
    `)
  )

  await once(child, 'spawn')
  await manager.waitUntilReady()
  assert.equal(manager.isRunning, true)

  await manager.stop(100)

  assert.equal(manager.isRunning, false)
  assert.notEqual(child.exitCode ?? child.signalCode, null)
})
