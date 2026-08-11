import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parse } from 'plist'

import {
  legacySchedulerLabel,
  SchedulerService,
  schedulerLabel,
  type LaunchctlRunner
} from './scheduler.mts'

async function schedulerWithInstalledPlist(
  runner: LaunchctlRunner
): Promise<{ service: SchedulerService; plistPath: string }> {
  const home = await mkdtemp(join(tmpdir(), 'railgun-scheduler-uninstall-'))
  const executablePath = join(home, 'railgun-backend')
  await writeFile(executablePath, 'version-one')
  await chmod(executablePath, 0o700)
  const service = new SchedulerService({
    platform: 'darwin',
    runner,
    target: {
      bundled: true,
      executablePath,
      homeDirectory: home,
      version: '1.0.0',
      workingDirectory: home
    },
    uid: 501
  })
  const plistPath = service.plistPath!
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  await writeFile(plistPath, '<plist/>')
  return { service, plistPath }
}

test('scheduler installs, detects executable drift, repairs legacy state, and uninstalls', async () => {
  const home = await mkdtemp(join(tmpdir(), 'railgun-scheduler-'))
  const executablePath = join(home, 'railgun-backend')
  await writeFile(executablePath, 'version-one')
  await chmod(executablePath, 0o700)
  let loaded = false
  const calls: string[][] = []
  const runner: LaunchctlRunner = async (_executable, arguments_) => {
    calls.push([...arguments_])
    if (arguments_[0] === 'bootstrap') loaded = true
    if (arguments_[0] === 'bootout') loaded = false
    return {
      code: arguments_[0] === 'print' && !loaded ? 113 : 0,
      stdout: arguments_[0] === 'print' && loaded ? 'state = running' : '',
      stderr: ''
    }
  }
  const service = new SchedulerService({
    platform: 'darwin',
    runner,
    target: {
      bundled: true,
      executablePath,
      homeDirectory: home,
      version: '1.0.0',
      workingDirectory: home
    },
    uid: 501
  })

  assert.equal((await service.getStatus()).state, 'not-installed')
  assert.equal((await service.install()).state, 'running')
  const document = parse(await readFile(service.plistPath!, 'utf8')) as Record<string, unknown>
  assert.deepEqual(document.ProgramArguments, [executablePath, 'scheduler'])
  assert.equal((await stat(service.plistPath!)).mode & 0o777, 0o600)

  await writeFile(executablePath, 'version-two')
  assert.equal((await service.getStatus()).state, 'repair-needed')
  const legacyPath = join(home, 'Library', 'LaunchAgents', `${legacySchedulerLabel}.plist`)
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  await writeFile(legacyPath, '<plist/>')
  assert.equal((await service.install()).state, 'running')
  assert.equal((await service.uninstall()).state, 'not-installed')
  assert(
    calls.some((call) => call.some((argument) => argument.endsWith(`${schedulerLabel}.plist`)))
  )
})

test('scheduler remains unavailable for mock or unconfigured launches', async () => {
  assert.equal(
    (await new SchedulerService({ platform: 'darwin', uid: 501 }).getStatus()).state,
    'unavailable'
  )
})

test('scheduler keeps its plist when launchctl still reports the service loaded', async () => {
  const runner: LaunchctlRunner = async (_executable, arguments_) => {
    const currentService = arguments_.some((argument) => argument.endsWith(schedulerLabel))
    return arguments_[0] === 'print' && currentService
      ? { code: 0, stdout: 'state = running', stderr: '' }
      : { code: 5, stdout: '', stderr: 'Boot-out failed' }
  }
  const { service, plistPath } = await schedulerWithInstalledPlist(runner)

  await assert.rejects(service.uninstall(), /Boot-out failed|Could not unload/)
  assert.equal(await readFile(plistPath, 'utf8'), '<plist/>')
})

test('scheduler tolerates bootout failure when launchctl confirms it is already unloaded', async () => {
  const runner: LaunchctlRunner = async (_executable, arguments_) =>
    arguments_[0] === 'print'
      ? { code: 113, stdout: '', stderr: 'Could not find service' }
      : { code: 5, stdout: '', stderr: 'Boot-out failed' }
  const { service, plistPath } = await schedulerWithInstalledPlist(runner)

  assert.equal((await service.uninstall()).state, 'not-installed')
  await assert.rejects(readFile(plistPath), (error: unknown) => {
    assert(error instanceof Error && 'code' in error)
    return error.code === 'ENOENT'
  })
})
