import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const script = fileURLToPath(new URL('./release/validate-build-number.sh', import.meta.url))

async function validate(candidate, previous, previousTag, currentTag) {
  return execFileAsync(script, [
    '--candidate',
    String(candidate),
    '--previous',
    String(previous),
    '--previous-tag',
    previousTag,
    '--current-tag',
    currentTag
  ])
}

test('new release tags require a strictly increasing build number', async () => {
  const { stdout } = await validate(102, 101, 'v0.10.16', 'v0.10.17')
  assert.match(stdout, /validated release build 102/u)

  await assert.rejects(
    validate(101, 101, 'v0.10.16', 'v0.10.17'),
    /must exceed previous build 101/u
  )
})

test('rerunning the current release tag accepts its existing build number', async () => {
  const { stdout } = await validate(101, 101, 'v0.10.17', 'v0.10.17')
  assert.match(stdout, /validated release build 101/u)

  await assert.rejects(
    validate(100, 101, 'v0.10.17', 'v0.10.17'),
    /cannot be lower than existing build 101/u
  )
})
