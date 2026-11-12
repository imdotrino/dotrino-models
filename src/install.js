// Bajar y comprobar. Todo lo que se baja se compara contra el sha256 que fija el catálogo
// ANTES de dejarlo donde se usa: se escribe en un .part y solo se renombra si coincide.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { engineBuild, codeError } from './catalog.js'

const run = promisify(execFile)

/**
 * @param {string} url @param {string} dest @param {string} sha256
 * @param {(done: number, total: number) => void} [onProgress]
 * @param {AbortSignal} [signal]
 */
export async function download (url, dest, sha256, onProgress, signal) {
  await mkdir(path.dirname(dest), { recursive: true })
  const part = dest + '.part'
  const res = await fetch(url, { redirect: 'follow', signal })
  if (!res.ok || !res.body) throw codeError('download-failed', `GET ${url}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let done = 0
  const body = Readable.fromWeb(/** @type {any} */ (res.body))
  body.on('data', (/** @type {Buffer} */ chunk) => {
    hash.update(chunk)
    done += chunk.length
    onProgress?.(done, total)
  })
  try {
    await pipeline(body, createWriteStream(part), { signal })
  } catch (e) {
    await rm(part, { force: true })
    throw e
  }
  const got = hash.digest('hex')
  if (got !== sha256) {
    await rm(part, { force: true })
    throw codeError('checksum-mismatch', `${url}: sha256 ${got}, the catalog pins ${sha256}`)
  }
  await rename(part, dest)
}

/** @param {string} p */
export async function exists (p) {
  try { await stat(p); return true } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return false
    throw e
  }
}

/** @param {import('./catalog.js').Catalog} catalog @param {string} engineId @param {ReturnType<import('./paths.js').paths>} p */
export function engineDir (catalog, engineId, p) {
  const b = engineBuild(catalog, engineId)
  return { dir: path.join(p.engines, engineId, b.version), bin: path.join(p.engines, engineId, b.version, b.dir, b.bin), build: b }
}

/** @param {import('./catalog.js').Model} m @param {ReturnType<import('./paths.js').paths>} p */
export function modelFile (m, p) {
  return path.join(p.models, m.id, path.basename(new URL(m.file.url).pathname))
}

/**
 * El motor, si falta. Se baja el .tar.gz entero, se comprueba y solo entonces se descomprime.
 * @param {import('./catalog.js').Catalog} catalog @param {string} engineId
 * @param {ReturnType<import('./paths.js').paths>} p
 * @param {(done: number, total: number) => void} [onProgress] @param {AbortSignal} [signal]
 */
export async function installEngine (catalog, engineId, p, onProgress, signal) {
  const { dir, bin, build } = engineDir(catalog, engineId, p)
  if (await exists(bin)) return bin
  const tgz = path.join(dir, path.basename(new URL(build.url).pathname))
  await download(build.url, tgz, build.sha256, onProgress, signal)
  await run('tar', ['xzf', tgz, '-C', dir])
  await rm(tgz)
  if (!(await exists(bin))) throw codeError('engine-layout', `${engineId}: ${build.bin} is not where the catalog says (${bin})`)
  return bin
}

/**
 * @param {import('./catalog.js').Model} m @param {ReturnType<import('./paths.js').paths>} p
 * @param {(done: number, total: number) => void} [onProgress] @param {AbortSignal} [signal]
 */
export async function installModelFile (m, p, onProgress, signal) {
  const file = modelFile(m, p)
  if (await exists(file)) return file
  await download(m.file.url, file, m.file.sha256, onProgress, signal)
  return file
}

/** @param {import('./catalog.js').Model} m @param {ReturnType<import('./paths.js').paths>} p */
export async function removeModelFile (m, p) {
  await rm(path.join(p.models, m.id), { recursive: true, force: true })
}

/**
 * Motores que ya no usa ningún modelo instalado, o de otra versión que la del catálogo.
 * @param {import('./catalog.js').Catalog} catalog @param {ReturnType<import('./paths.js').paths>} p
 * @param {Set<string>} inUse
 */
export async function pruneEngines (catalog, p, inUse) {
  if (!(await exists(p.engines))) return
  for (const id of await readdir(p.engines)) {
    const keep = inUse.has(id) && catalog.engines[id]
    for (const v of await readdir(path.join(p.engines, id))) {
      if (!keep || v !== catalog.engines[id].version) await rm(path.join(p.engines, id, v), { recursive: true, force: true })
    }
  }
}
