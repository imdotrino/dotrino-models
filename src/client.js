// Cliente del gestor para programas de Node (la CLI, el puente de la ventana, otras piezas).
// Las apps de escritorio en otro lenguaje hablan la misma API por el mismo socket.
import { request, requestJson } from './uhttp.js'
import { paths } from './paths.js'

export class ModelsError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor (code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** @param {{ socket?: string }} [o] */
export function createClient ({ socket } = {}) {
  const sock = socket || paths().socket

  /** @param {string} method @param {string} path @param {unknown} [body] */
  async function call (method, path, body) {
    let r
    try {
      r = await requestJson({ socket: sock, method, path, json: body })
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code
      // Que no conteste nadie no es lo mismo que un error del gestor: se arregla arrancándolo.
      if (code === 'ENOENT' || code === 'ECONNREFUSED') throw new ModelsError('not-running', `dotrino-models is not running (${sock})`)
      throw e
    }
    if (r.status >= 400) throw new ModelsError(r.data?.error || 'internal', r.data?.message || `HTTP ${r.status}`, r.status)
    return r.data
  }

  const enc = encodeURIComponent
  return {
    socket: sock,
    status: () => call('GET', '/status'),
    install: (/** @type {string} */ id) => call('POST', `/models/${enc(id)}/install`),
    cancel: (/** @type {string} */ id) => call('POST', `/models/${enc(id)}/cancel`),
    start: (/** @type {string} */ id) => call('POST', `/models/${enc(id)}/start`),
    stop: (/** @type {string} */ id) => call('POST', `/models/${enc(id)}/stop`),
    remove: (/** @type {string} */ id) => call('DELETE', `/models/${enc(id)}`),
    assign: (/** @type {string} */ task, /** @type {string} */ model) => call('PUT', `/tasks/${enc(task)}`, { model }),
    ensure: (/** @type {string[]} */ tasks) => call('POST', '/ensure', { tasks }),
    translate: (/** @type {{ text: string, from?: string, to: string }} */ o) => call('POST', '/tasks/translate', o),
    chat: (/** @type {{ messages: Array<{ role: string, content: string }>, temperature?: number, maxTokens?: number }} */ o) =>
      call('POST', '/tasks/chat', o),
    /** @param {Buffer} wav @param {{ language?: string }} [o] */
    async transcribe (wav, { language = 'auto' } = {}) {
      let r
      try {
        r = await request({ socket: sock, method: 'POST', path: `/tasks/transcribe?language=${enc(language)}`, body: wav, headers: { 'content-type': 'audio/wav' } })
      } catch (e) {
        const code = /** @type {NodeJS.ErrnoException} */ (e).code
        if (code === 'ENOENT' || code === 'ECONNREFUSED') throw new ModelsError('not-running', `dotrino-models is not running (${sock})`)
        throw e
      }
      const data = JSON.parse(r.body.toString('utf8'))
      if (r.status >= 400) throw new ModelsError(data.error || 'internal', data.message || `HTTP ${r.status}`, r.status)
      return data
    }
  }
}
