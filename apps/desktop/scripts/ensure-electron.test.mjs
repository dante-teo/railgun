import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { ensureElectronBinary, resolveElectronExecutable } from './ensure-electron.mjs'

async function temporaryPackage(t) {
  const packageRoot = await mkdtemp(join(tmpdir(), 'railgun-electron-preflight-'))
  t.after(() => rm(packageRoot, { force: true, recursive: true }))
  return packageRoot
}

async function createExecutable(packageRoot, relativePath = 'Electron') {
  const executablePath = join(packageRoot, 'dist', relativePath)
  await mkdir(dirname(executablePath), { recursive: true })
  await writeFile(executablePath, '')
  await chmod(executablePath, 0o755)
  await writeFile(join(packageRoot, 'path.txt'), relativePath)
  return executablePath
}

test('resolveElectronExecutable rejects incomplete installations', async (t) => {
  const packageRoot = await temporaryPackage(t)

  assert.equal(await resolveElectronExecutable(packageRoot), undefined)

  await writeFile(join(packageRoot, 'path.txt'), 'Electron')
  assert.equal(await resolveElectronExecutable(packageRoot), undefined)
})

test('resolveElectronExecutable rejects directories and non-executable files', async (t) => {
  const packageRoot = await temporaryPackage(t)
  const executablePath = join(packageRoot, 'dist', 'Electron')

  await mkdir(executablePath, { recursive: true })
  await writeFile(join(packageRoot, 'path.txt'), 'Electron')
  assert.equal(await resolveElectronExecutable(packageRoot), undefined)

  await rm(executablePath, { recursive: true })
  await writeFile(executablePath, '', { mode: 0o644 })
  if (process.platform !== 'win32') {
    assert.equal(await resolveElectronExecutable(packageRoot), undefined)
  }
})

test('ensureElectronBinary leaves a healthy installation untouched', async (t) => {
  const packageRoot = await temporaryPackage(t)
  const executablePath = await createExecutable(packageRoot)
  let installCount = 0

  const result = await ensureElectronBinary({
    packageRoot,
    install: async () => {
      installCount += 1
    }
  })

  assert.deepEqual(result, { executablePath, repaired: false })
  assert.equal(installCount, 0)
})

test('ensureElectronBinary repairs an incomplete installation once', async (t) => {
  const packageRoot = await temporaryPackage(t)
  const staleFile = join(packageRoot, 'dist', 'stale-binary')
  const messages = []
  let installCount = 0

  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await writeFile(staleFile, '')
  await writeFile(join(packageRoot, 'path.txt'), 'missing-binary')

  const result = await ensureElectronBinary({
    packageRoot,
    install: async (root) => {
      installCount += 1
      await assert.rejects(access(staleFile), { code: 'ENOENT' })
      await createExecutable(root)
    },
    log: (message) => messages.push(message)
  })

  assert.equal(result.repaired, true)
  assert.equal(installCount, 1)
  assert.equal(messages.length, 2)
})
