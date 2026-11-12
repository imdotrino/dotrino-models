// El gestor: junta el catálogo, lo instalado, lo encendido y lo que el usuario eligió.
import { loadCatalog, getModel, defaultFor, codeError, TASKS } from './catalog.js'
import { installEngine, installModelFile, removeModelFile, modelFile, engineDir, exists, pruneEngines } from './install.js'
import { readSettings, writeSettings } from './settings.js'
import { Engines } from './engines.js'
import * as tasks from './tasks.js'

/**
 * @typedef {{ phase: 'engine' | 'model', done: number, total: number, error?: string,
 *   promise: Promise<void>, abort: AbortController }} Install
 */

export class Models {
  /**
   * @param {{ paths: ReturnType<import('./paths.js').paths>, idleMs?: number,
   *   catalog?: import('./catalog.js').Catalog, log?: (s: string) => void }} o
   */
  constructor ({ paths, idleMs, catalog = loadCatalog(), log = () => {} }) {
    this.paths = paths
    this.catalog = catalog
    this.log = log
    this.engines = new Engines({ runDir: paths.run, idleMs, log })
    /** @type {Map<string, Install>} */
    this.installs = new Map()
    /** @type {Map<string, string>} los errores de instalación, hasta el siguiente intento */
    this.failedInstalls = new Map()
    /** @type {Promise<unknown>} los cambios de ajustes van de uno en uno */
    this.settingsQueue = Promise.resolve()
  }

  /**
   * Leer, cambiar y escribir los ajustes sin que dos cambios a la vez se pisen (dos
   * instalaciones que terminan juntas eligiendo cada una su tarea).
   * @param {(s: import('./settings.js').Settings) => boolean | void} change  true/undefined = escribir
   */
  updateSettings (change) {
    const next = this.settingsQueue.then(async () => {
      const s = await readSettings(this.paths.settings)
      if (change(s) !== false) await writeSettings(this.paths.settings, s)
    })
    this.settingsQueue = next.catch(() => {})
    return next
  }

  /** @param {string} id */
  async isInstalled (id) {
    const m = getModel(this.catalog, id)
    const { bin } = engineDir(this.catalog, m.engine, this.paths)
    return (await exists(modelFile(m, this.paths))) && (await exists(bin))
  }

  async status () {
    const settings = await readSettings(this.paths.settings)
    const models = []
    for (const m of this.catalog.models) {
      const inst = this.installs.get(m.id)
      /** @type {string} */
      let state
      /** @type {string | undefined} */
      let error
      /** @type {{ phase: string, done: number, total: number } | undefined} */
      let progress
      /** @type {boolean | Error} */
      let installed
      try { installed = await this.isInstalled(m.id) } catch (e) { installed = /** @type {Error} */ (e) }
      if (inst) {
        state = 'installing'
        progress = { phase: inst.phase, done: inst.done, total: inst.total }
      } else if (installed instanceof Error) {
        // Sin build para esta máquina, o el motor sin hash fijado: no se puede instalar.
        state = 'unavailable'
        error = installed.message
      } else if (!installed) {
        state = 'absent'
        error = this.failedInstalls.get(m.id)
      } else {
        const e = this.engines.state(m.id)
        state = e.state
        error = e.error
      }
      models.push({
        id: m.id, name: m.name, tasks: m.tasks, engine: m.engine, size: m.file.size, vramMB: m.vramMB,
        languages: m.languages, tested: m.tested, local: true, state, error, progress
      })
    }
    return { tasks: settings.tasks, models }
  }

  /**
   * Bajar el motor (si falta) y el modelo. Vuelve enseguida: el progreso se ve en `status`.
   * @param {string} id
   */
  install (id) {
    const m = getModel(this.catalog, id)
    const running = this.installs.get(id)
    if (running) return running.promise
    this.failedInstalls.delete(id)
    const abort = new AbortController()
    /** @type {Install} */
    const inst = { phase: 'engine', done: 0, total: 0, abort, promise: Promise.resolve() }
    const progress = (/** @type {number} */ done, /** @type {number} */ total) => { inst.done = done; inst.total = total }
    inst.promise = (async () => {
      try {
        await installEngine(this.catalog, m.engine, this.paths, progress, abort.signal)
        inst.phase = 'model'
        inst.done = 0
        inst.total = m.file.size || 0
        await installModelFile(m, this.paths, progress, abort.signal)
        // Si la tarea no tenía modelo elegido, el primero que se instala para ella la atiende:
        // instalarlo ya es una decisión del usuario.
        await this.updateSettings((s) => {
          let changed = false
          for (const t of m.tasks) if (!s.tasks[t]) { s.tasks[t] = m.id; changed = true }
          return changed
        })
        this.log(`models: ${id} installed`)
      } catch (e) {
        const msg = /** @type {Error} */ (e).message
        this.failedInstalls.set(id, msg)
        this.log(`models: install of ${id} failed: ${msg}`)
        throw e
      } finally {
        this.installs.delete(id)
      }
    })()
    this.installs.set(id, inst)
    inst.promise.catch(() => {})
    return inst.promise
  }

  /** @param {string} id */
  cancelInstall (id) {
    this.installs.get(id)?.abort.abort()
  }

  /** @param {string} id */
  async remove (id) {
    const m = getModel(this.catalog, id)
    this.cancelInstall(id)
    await this.engines.stop(id)
    await removeModelFile(m, this.paths)
    await this.updateSettings((s) => {
      let changed = false
      for (const [t, mid] of Object.entries(s.tasks)) if (mid === id) { delete s.tasks[t]; changed = true }
      return changed
    })
    const inUse = new Set()
    for (const x of this.catalog.models) if (await exists(modelFile(x, this.paths))) inUse.add(x.engine)
    await pruneEngines(this.catalog, this.paths, inUse)
  }

  /** @param {string} id */
  async start (id) {
    const m = getModel(this.catalog, id)
    if (!(await this.isInstalled(id))) throw codeError('not-installed', `${id} is not installed`)
    const { bin } = engineDir(this.catalog, m.engine, this.paths)
    return this.engines.ensure(id, m.engine, bin, modelFile(m, this.paths))
  }

  /** @param {string} id */
  stop (id) { return this.engines.stop(id) }

  /** @param {string} task @param {string} id */
  async assign (task, id) {
    if (!TASKS.includes(task)) throw codeError('unknown-task', `unknown task ${task}`)
    const m = getModel(this.catalog, id)
    if (!m.tasks.includes(task)) throw codeError('wrong-task', `${id} does not do ${task}`)
    await this.updateSettings((s) => { s.tasks[task] = id })
  }

  /**
   * Lo que llama una app al instalarse: «necesito estas tareas». La tarea sin modelo elegido
   * se queda con el modelo por defecto del catálogo y se baja. Vuelve enseguida.
   * @param {string[]} wanted
   */
  async ensure (wanted) {
    const s = await readSettings(this.paths.settings)
    /** @type {Record<string, string>} */
    const out = {}
    for (const t of wanted) {
      if (!TASKS.includes(t)) throw codeError('unknown-task', `unknown task ${t}`)
      const id = s.tasks[t] || defaultFor(this.catalog, t)?.id
      if (!id) throw codeError('no-model-for-task', `the catalog has no default model for ${t}`)
      out[t] = id
      if (!(await this.isInstalled(id))) this.install(id).catch(() => {})
    }
    return out
  }

  /** @param {string} task */
  async socketFor (task) {
    const s = await readSettings(this.paths.settings)
    const id = s.tasks[task]
    if (!id) throw codeError('no-model-for-task', `no model chosen for ${task}`)
    return { id, socket: await this.start(id) }
  }

  /** @param {Buffer} audio @param {{ language?: string }} o */
  async transcribe (audio, o) {
    const { id, socket } = await this.socketFor('transcribe')
    try { return await tasks.transcribe(socket, audio, o) } finally { this.engines.touch(id) }
  }

  /** @param {{ text: string, from?: string, to: string }} o */
  async translate (o) {
    // El idioma se comprueba antes de encender nada.
    if (o.from && o.from !== 'auto') tasks.languageName(o.from)
    tasks.languageName(o.to)
    const { id, socket } = await this.socketFor('translate')
    try { return await tasks.translate(socket, o) } finally { this.engines.touch(id) }
  }

  /** @param {{ messages: Array<{ role: string, content: string }>, temperature?: number, maxTokens?: number }} o */
  async chat (o) {
    const { id, socket } = await this.socketFor('chat')
    try { return await tasks.chat(socket, o.messages, o) } finally { this.engines.touch(id) }
  }

  async close () {
    for (const i of this.installs.values()) i.abort.abort()
    await this.engines.stopAll()
  }
}
