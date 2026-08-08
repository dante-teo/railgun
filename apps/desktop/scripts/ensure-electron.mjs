import { constants } from 'node:fs'
import { access, readFile, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

function electronPackageRoot() {
  return dirname(require.resolve('electron/package.json'))
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }

    throw error
  }
}

async function executableFileExists(path) {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile()) {
      return false
    }

    await access(path, constants.X_OK)
    return true
  } catch (error) {
    if (['EACCES', 'ENOENT', 'ENOTDIR'].includes(error?.code)) {
      return false
    }

    throw error
  }
}

export async function resolveElectronExecutable(packageRoot) {
  const pathFile = join(packageRoot, 'path.txt')

  if (!(await fileExists(pathFile))) {
    return undefined
  }

  const relativePath = (await readFile(pathFile, 'utf8')).trim()
  if (!relativePath) {
    return undefined
  }

  const executablePath = join(packageRoot, 'dist', relativePath)
  return (await executableFileExists(executablePath)) ? executablePath : undefined
}

async function installElectronBinary(packageRoot) {
  const installerPath = join(packageRoot, 'install.js')
  if (!(await fileExists(installerPath))) {
    throw new Error(`Electron installer was not found at ${installerPath}`)
  }

  await new Promise((resolveInstall, rejectInstall) => {
    const installer = spawn(process.execPath, [installerPath], {
      stdio: 'inherit'
    })

    installer.once('error', rejectInstall)
    installer.once('exit', (code, signal) => {
      if (code === 0) {
        resolveInstall()
        return
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      rejectInstall(new Error(`Electron installer failed with ${reason}`))
    })
  })
}

export async function ensureElectronBinary({
  packageRoot = electronPackageRoot(),
  install = installElectronBinary,
  log = (message) => process.stderr.write(`${message}\n`)
} = {}) {
  const existingExecutable = await resolveElectronExecutable(packageRoot)
  if (existingExecutable) {
    return { executablePath: existingExecutable, repaired: false }
  }

  log('Electron binary is incomplete; repairing it before startup...')
  await Promise.all([
    rm(join(packageRoot, 'dist'), { force: true, recursive: true }),
    rm(join(packageRoot, 'path.txt'), { force: true })
  ])
  await install(packageRoot)

  const repairedExecutable = await resolveElectronExecutable(packageRoot)
  if (!repairedExecutable) {
    throw new Error('Electron installation completed without producing an executable')
  }

  log(`Electron binary repaired at ${repairedExecutable}`)
  return { executablePath: repairedExecutable, repaired: true }
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMainModule) {
  try {
    await ensureElectronBinary()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`error: ${message}\n`)
    process.exitCode = 1
  }
}
