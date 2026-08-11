import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const publicKey = process.env.RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY
  if (!publicKey || publicKey !== publicKey.trim() || /[\r\n]/u.test(publicKey)) {
    throw new Error('RAILGUNX_SPARKLE_PUBLIC_EDDSA_KEY must be a non-empty single-line value')
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const infoPlist = join(context.appOutDir, appName, 'Contents', 'Info.plist')
  await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    `Add :SUPublicEDKey string ${publicKey}`,
    infoPlist
  ])
}
