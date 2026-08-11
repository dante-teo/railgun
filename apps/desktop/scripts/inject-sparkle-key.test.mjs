import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { afterPack } from './inject-sparkle-key.mjs'

const execFileAsync = promisify(execFile)

const emptyPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict></dict></plist>
`

async function withPublicKey(value, operation) {
  const previous = process.env.RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY
  if (value === undefined) {
    delete process.env.RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY
  } else {
    process.env.RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY = value
  }
  try {
    await operation()
  } finally {
    if (previous === undefined) {
      delete process.env.RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY
    } else {
      process.env.RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY = previous
    }
  }
}

test('afterPack injects the configured Sparkle public key into the macOS application', async (context) => {
  const output = await mkdtemp(join(tmpdir(), 'railgun-after-pack-'))
  context.after(() => rm(output, { force: true, recursive: true }))
  const contents = join(output, 'Railgun.app', 'Contents')
  await mkdir(contents, { recursive: true })
  const infoPlist = join(contents, 'Info.plist')
  await writeFile(infoPlist, emptyPlist)

  await withPublicKey('fixture-public-key', () =>
    afterPack({
      appOutDir: output,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Railgun' } }
    })
  )

  const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :SUPublicEDKey',
    infoPlist
  ])
  assert.equal(stdout.trim(), 'fixture-public-key')
  assert.match(await readFile(infoPlist, 'utf8'), /SUPublicEDKey/u)
})

test('afterPack rejects missing or multiline public keys for macOS packages', async () => {
  await withPublicKey(undefined, async () => {
    await assert.rejects(
      () => afterPack({ electronPlatformName: 'darwin' }),
      /must be a non-empty single-line value/u
    )
  })
  await withPublicKey('bad\nkey', async () => {
    await assert.rejects(
      () => afterPack({ electronPlatformName: 'darwin' }),
      /must be a non-empty single-line value/u
    )
  })
})

test('afterPack ignores non-macOS packages without requiring the compatibility key', async () => {
  await withPublicKey(undefined, () => afterPack({ electronPlatformName: 'linux' }))
})
