// Encender y apagar los motores. Cada modelo encendido es un proceso del motor escuchando en
// su propio socket UNIX dentro del directorio privado del servicio. Se enciende cuando una
// app lo pide y se apaga cuando lleva un rato sin uso: así la memoria de video no se queda
// ocupada por algo que nadie está usando.
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { request } from './uhttp.js'
import { codeError } from './catalog.js'

/** Argumentos de cada motor. `sock` es el socket donde tiene que escuchar. */
const ARGS = {
  'llama.cpp': (/** @type {string} */ file, /** @type {string} */ sock) =>
    ['-m', file, '--host', sock, '-ngl', '99', '-c', '4096', '--no-webui'],
  'whisper.cpp': (/** @type {string} */ file, /** @type {string} */ sock) =>
    ['-m', file, '--host', sock, '-l', 'auto']
}

/** Qué ruta contesta cuando el motor ya cargó el modelo. */
const READY = { 'llama.cpp': '/health', 'whisper.cpp': '/' }

/**
 * @typedef {{ state: 'starting' | 'running' | 'stopping' | 'failed', engine: string, socket: string,
 *   child?: import('node:child_process').ChildProcess, lastUsed: number, error?: string,
 *   log: string[], starting?: Promise<string>, stopping?: Promise<void> }} Running
 */

export class Engines {
  /** @param {{ runDir: string, idleMs?: number, readyTimeoutMs?: number, log?: (s: string) => void }} o */
  constructor ({ runDir, idleMs = 10 * 60_000, readyTimeoutMs = 180_000, log = () => {} }) {
    this.runDir = runDir
    this.idleMs = idleMs
    this.readyTimeoutMs = readyTimeoutMs
    this.log = log
    /** @type {Map<string, Running>} */
    this.running = new Map()
    this.sweeper = setInterval(() => this.sweep(), 30_000)
    this.sweeper.unref()
  }

  /** @param {string} id */
  state (id) {
    const r = this.running.get(id)
    if (!r) return { state: 'stopped' }
    return { state: r.state, error: r.error, lastUsed: r.lastUsed }
  }

  /**
   * El socket del modelo, encendiéndolo si hace falta. Dos peticiones a la vez esperan al mismo
   * arranque.
   * @param {string} id @param {string} engine @param {string} bin @param {string} file
   */
  async ensure (id, engine, bin, file) {
    const r = this.running.get(id)
    if (r?.state === 'running') { r.lastUsed = Date.now(); return r.socket }
    if (r?.state === 'starting' && r.starting) return r.starting
    // Se está apagando: se espera a que suelte el socket antes de volver a encender.
    if (r?.state === 'stopping' && r.stopping) await r.stopping
    return this.start(id, engine, bin, file)
  }

  /** @param {string} id @param {string} engine @param {string} bin @param {string} file */
  start (id, engine, bin, file) {
    const args = ARGS[/** @type {keyof typeof ARGS} */ (engine)]
    if (!args) throw codeError('unknown-engine', `no launcher for engine ${engine}`)
    const socket = path.join(this.runDir, `${id}.sock`)
    // sun_path tiene 108 bytes en Linux (104 en macOS): una ruta más larga no se puede abrir, y el
    // motor solo dice «couldn't bind».
    if (Buffer.byteLength(socket) > 103) throw codeError('socket-path-too-long', `socket path over 103 bytes: ${socket}`)
    /** @type {Running} */
    const r = { state: 'starting', engine, socket, lastUsed: Date.now(), log: [] }
    this.running.set(id, r)
    r.starting = (async () => {
      await rm(socket, { force: true })
      const child = spawn(bin, args(file, socket), { stdio: ['ignore', 'pipe', 'pipe'] })
      r.child = child
      const keep = (/** @type {Buffer} */ b) => {
        for (const line of b.toString('utf8').split('\n')) if (line.trim()) r.log.push(line)
        if (r.log.length > 40) r.log.splice(0, r.log.length - 40)
      }
      child.stdout?.on('data', keep)
      child.stderr?.on('data', keep)
      child.on('exit', (code, signal) => {
        if (this.running.get(id) !== r) return
        if (r.state === 'stopping') return
        r.state = 'failed'
        r.error = `${engine} exited (${signal || code}): ${r.log.slice(-3).join(' | ')}`
        this.log(`models: ${id} ${r.error}`)
      })
      child.on('error', (e) => { r.state = 'failed'; r.error = `${engine}: ${e.message}` })
      await this.waitReady(r, READY[/** @type {keyof typeof READY} */ (engine)])
      r.state = 'running'
      r.lastUsed = Date.now()
      this.log(`models: ${id} running on ${socket}`)
      return socket
    })()
    r.starting.catch(() => {})
    return r.starting
  }

  /** @param {Running} r @param {string} readyPath */
  async waitReady (r, readyPath) {
    const until = Date.now() + this.readyTimeoutMs
    while (Date.now() < until) {
      if (r.state === 'failed') throw codeError('engine-failed', r.error || 'engine failed')
      try {
        const res = await request({ socket: r.socket, path: readyPath, timeoutMs: 2000 })
        if (res.status === 200) return
      } catch { /* todavía no escucha: se vuelve a mirar */ }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    r.child?.kill('SIGKILL')
    r.state = 'failed'
    r.error = `not ready after ${this.readyTimeoutMs} ms`
    throw codeError('engine-failed', r.error)
  }

  /** @param {string} id */
  async stop (id) {
    const r = this.running.get(id)
    if (!r) return
    if (r.state === 'stopping' && r.stopping) return r.stopping
    if (!r.child || r.child.exitCode !== null || r.state === 'failed') { this.running.delete(id); return }
    r.state = 'stopping'
    const child = r.child
    r.stopping = (async () => {
      const gone = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const t = setTimeout(() => child.kill('SIGKILL'), 5000)
      await gone
      clearTimeout(t)
      if (this.running.get(id) === r) this.running.delete(id)
      await rm(r.socket, { force: true })
      this.log(`models: ${id} stopped`)
    })()
    return r.stopping
  }

  /** @param {string} id */
  touch (id) {
    const r = this.running.get(id)
    if (r) r.lastUsed = Date.now()
  }

  sweep () {
    const now = Date.now()
    for (const [id, r] of this.running) {
      if (r.state === 'running' && now - r.lastUsed > this.idleMs) {
        this.log(`models: ${id} idle for ${Math.round((now - r.lastUsed) / 60_000)} min, stopping`)
        this.stop(id).catch((e) => this.log(`models: could not stop ${id}: ${e.message}`))
      }
    }
  }

  async stopAll () {
    clearInterval(this.sweeper)
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)))
  }
}
