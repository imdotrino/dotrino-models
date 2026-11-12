// El catálogo: los modelos que Dotrino probó y los motores que los corren.
//
// Viaja DENTRO de la versión (src/catalog.json), igual que la lista de compatibilidad (§14):
// se cambia publicando una versión nueva, y nada en marcha lo puede cambiar a distancia. Cada
// archivo lleva su sha256 fijado aquí, así que lo que se baja se comprueba contra el código,
// no contra lo que diga el servidor de donde viene.
import { readFileSync } from 'node:fs'

export const TASKS = ['transcribe', 'translate', 'chat']

const SHA256 = /^[0-9a-f]{64}$/

/** @typedef {{ url: string, sha256: string, size?: number }} CatalogFile */
/** @typedef {{ url: string, sha256: string, dir: string }} EngineBuild */
/** @typedef {{ version: string, bin: string, builds: Record<string, EngineBuild> }} Engine */
/**
 * @typedef {{ id: string, name: string, tasks: string[], default?: string[], engine: string,
 *   file: CatalogFile, vramMB: number, languages: string, tested: { es: string, en: string } }} Model
 */
/** @typedef {{ engines: Record<string, Engine>, models: Model[] }} Catalog */

/** @returns {Catalog} */
export function loadCatalog () {
  const raw = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))
  validate(raw)
  return raw
}

/** @param {Catalog} c */
export function validate (c) {
  const ids = new Set()
  for (const m of c.models) {
    if (ids.has(m.id)) throw new Error(`catalog: duplicated model id ${m.id}`)
    ids.add(m.id)
    if (!c.engines[m.engine]) throw new Error(`catalog: ${m.id} uses unknown engine ${m.engine}`)
    for (const t of m.tasks) if (!TASKS.includes(t)) throw new Error(`catalog: ${m.id} has unknown task ${t}`)
    for (const t of m.default || []) if (!m.tasks.includes(t)) throw new Error(`catalog: ${m.id} is default for ${t} but does not do it`)
    if (!SHA256.test(m.file.sha256)) throw new Error(`catalog: ${m.id} has no valid sha256`)
  }
  for (const t of TASKS) {
    const defs = c.models.filter((m) => (m.default || []).includes(t))
    if (defs.length > 1) throw new Error(`catalog: more than one default model for ${t}`)
  }
}

/** La plataforma tal como la nombra el catálogo (`linux-x64`). */
export function platformKey (platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/**
 * La build de un motor para esta máquina. Sin build, o con un hash que aún no se fijó, se para:
 * bajar algo que no se puede comprobar no es una opción.
 * @param {Catalog} c @param {string} engineId
 */
export function engineBuild (c, engineId, platform = platformKey()) {
  const e = c.engines[engineId]
  if (!e) throw codeError('unknown-engine', `unknown engine ${engineId}`)
  const b = e.builds[platform]
  if (!b) throw codeError('unsupported-platform', `${engineId} has no build for ${platform}`)
  if (!SHA256.test(b.sha256)) throw codeError('engine-unpinned', `${engineId} ${e.version} has no pinned sha256 for ${platform}`)
  return { ...b, version: e.version, bin: e.bin }
}

/** @param {Catalog} c @param {string} id */
export function getModel (c, id) {
  const m = c.models.find((x) => x.id === id)
  if (!m) throw codeError('unknown-model', `unknown model ${id}`)
  return m
}

/** @param {Catalog} c @param {string} task */
export function defaultFor (c, task) {
  return c.models.find((m) => (m.default || []).includes(task)) || null
}

/** @param {string} code @param {string} message */
export function codeError (code, message) {
  const e = /** @type {Error & { code: string }} */ (new Error(message))
  e.code = code
  return e
}
