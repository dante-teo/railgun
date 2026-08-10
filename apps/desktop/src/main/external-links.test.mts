import assert from 'node:assert/strict'
import test from 'node:test'

import { handleExternalWindowOpen, validateExternalUrl } from './external-links.mts'

test('external links permit only bounded credential-free HTTP(S) URLs', () => {
  assert.equal(
    validateExternalUrl('https://example.com/docs?q=railgun'),
    'https://example.com/docs?q=railgun'
  )
  assert.equal(validateExternalUrl('http://localhost:3000/path'), 'http://localhost:3000/path')

  for (const value of [
    'file:///tmp/secret',
    'javascript:alert(1)',
    'https://user:password@example.com',
    ' https://example.com',
    'https://example.com\nunsafe',
    'x'.repeat(4_097)
  ]) {
    assert.equal(validateExternalUrl(value), undefined)
  }
})

test('the window-open handler delegates validated links externally and denies renderer windows', async () => {
  const opened: string[] = []
  const openExternal = async (url: string): Promise<void> => {
    opened.push(url)
  }

  assert.deepEqual(handleExternalWindowOpen(openExternal, 'https://example.com/docs'), {
    action: 'deny'
  })
  assert.deepEqual(handleExternalWindowOpen(openExternal, 'file:///tmp/private'), {
    action: 'deny'
  })
  await Promise.resolve()
  assert.deepEqual(opened, ['https://example.com/docs'])
})
