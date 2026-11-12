// Los ajustes del usuario: qué modelo atiende cada tarea. Un archivo que no existe es «nada
// elegido todavía»; uno que existe y no se puede leer NO es eso: se para y se dice.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { codeError } from './catalog.js'

/** @typedef {{ tasks: Record<string, string> }} Settings */

/** @param {string} file @returns {Promise<Settings>} */
export async function readSettings (file) {
  let text
  try { text = await readFile(file, 'utf8') } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return { tasks: {} }
    throw e
  }
  /** @type {any} */
  let s
  try { s = JSON.parse(text) } catch {
    throw codeError('settings-unreadable', `${file} is not valid JSON`)
  }
  if (!s || typeof s !== 'object' || !s.tasks || typeof s.tasks !== 'object') {
    throw codeError('settings-unreadable', `${file} has no "tasks" object`)
  }
  return { tasks: { ...s.tasks } }
}

/** @param {string} file @param {Settings} s */
export async function writeSettings (file, s) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n')
  await rename(tmp, file)
}
