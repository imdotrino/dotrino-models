// Correr el gestor: en primer plano (`serve`, lo que lanza systemd) o suelto (lo que pide la
// ventana cuando no está corriendo).
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openSync, mkdirSync } from 'node:fs'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { watchForUpdate } from '@dotrino/update'
import { paths } from './paths.js'
import { Models } from './service.js'
import { createServer, listen } from './server.js'

const run = promisify(execFile)
const BIN = fileURLToPath(new URL('../bin/dotrino-models.js', import.meta.url))
const UNIT = 'dotrino-models.service'

/** @param {{ version: string }} o */
export async function serve ({ version }) {
  const p = paths()
  const log = (/** @type {string} */ s) => console.log(`${new Date().toISOString()} ${s}`)
  const models = new Models({ paths: p, log })
  const server = createServer(models, { version })
  await listen(server, p)
  log(`models: dotrino-models ${version} listening on ${p.socket}`)
  watchForUpdate({
    current: version, source: 'npm', pkg: '@dotrino/models',
    onNewer: (r) => log(`models: ${r.version} is published (this is ${r.current})`)
  })
  const bye = async () => {
    log('models: shutting down')
    server.close()
    await models.close()
    process.exit(0)
  }
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
}

/** Arranca el gestor sin atarlo a quien lo pide. Si hay unidad de systemd, va por ella. */
export async function startDetached () {
  if (await hasUnit()) {
    await run('systemctl', ['--user', 'start', UNIT])
    return
  }
  const p = paths()
  mkdirSync(p.data, { recursive: true })
  const logFd = openSync(path.join(p.data, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [BIN, 'serve'], { detached: true, stdio: ['ignore', logFd, logFd] })
  child.unref()
}

function unitPath () {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', UNIT)
}

async function hasUnit () {
  try { await run('systemctl', ['--user', 'cat', UNIT]); return true } catch { return false }
}

/** Arranque al iniciar sesión, con systemd de usuario. */
export async function installService () {
  const unit = `[Unit]
Description=Dotrino models (local AI models)

[Service]
ExecStart=${process.execPath} ${BIN} serve
Restart=on-failure

[Install]
WantedBy=default.target
`
  await mkdir(path.dirname(unitPath()), { recursive: true })
  await writeFile(unitPath(), unit)
  await run('systemctl', ['--user', 'daemon-reload'])
  await run('systemctl', ['--user', 'enable', '--now', UNIT])
  return unitPath()
}

export async function uninstallService () {
  await run('systemctl', ['--user', 'disable', '--now', UNIT]).catch(() => {})
  await rm(unitPath(), { force: true })
  await run('systemctl', ['--user', 'daemon-reload'])
}
