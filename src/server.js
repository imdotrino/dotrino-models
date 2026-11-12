// La API del gestor, por un socket UNIX en el directorio privado del usuario. Sin puerto: una
// página web abierta en el navegador no puede llegar aquí (los motores avisan de que su CORS
// deja entrar a cualquier origen, y por eso tampoco escuchan en un puerto).
import http from 'node:http'
import { mkdir, chmod, rm, stat } from 'node:fs/promises'
import { declare } from '@dotrino/compat'
import { request } from './uhttp.js'
import { codeError } from './catalog.js'

export const PROTOCOL = 1
const MAX_BODY = 25 * 1024 * 1024

/** Código de error → estado HTTP. Lo que no está aquí es un fallo nuestro (500). */
const STATUS = /** @type {Record<string, number>} */ ({
  'bad-request': 400, 'unknown-task': 400, 'wrong-task': 400, 'unknown-language': 400,
  'unknown-model': 404, 'not-found': 404,
  'not-installed': 409, 'no-model-for-task': 409, 'unsupported-platform': 409, 'engine-unpinned': 409,
  'too-large': 413, 'socket-path-too-long': 500, 'engine-failed': 502, 'engine-error': 502
})

/** @param {http.IncomingMessage} req @returns {Promise<Buffer>} */
function readBody (req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(codeError('too-large', `body over ${MAX_BODY} bytes`)); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** @param {Buffer} b */
function json (b) {
  try { return JSON.parse(b.toString('utf8') || '{}') } catch { throw codeError('bad-request', 'body is not JSON') }
}

/**
 * @param {import('./service.js').Models} models
 * @param {{ version: string }} o
 */
export function createServer (models, { version }) {
  const mine = declare({ product: 'models', version, protocol: PROTOCOL, speaks: [PROTOCOL] })
  return http.createServer(async (req, res) => {
    const send = (/** @type {number} */ status, /** @type {unknown} */ body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)
      const route = `${req.method} /${parts[0] || ''}${parts.length > 2 ? '/:id/' + parts[2] : parts.length > 1 ? '/:id' : ''}`
      const id = decodeURIComponent(parts[1] || '')
      switch (route) {
        case 'GET /status':
          return send(200, { v: mine, ...(await models.status()) })
        case 'POST /models/:id/install':
          models.install(id).catch(() => {})
          return send(202, { ok: true })
        case 'POST /models/:id/cancel':
          models.cancelInstall(id)
          return send(200, { ok: true })
        case 'POST /models/:id/start':
          await models.start(id)
          return send(200, { ok: true })
        case 'POST /models/:id/stop':
          await models.stop(id)
          return send(200, { ok: true })
        case 'DELETE /models/:id':
          await models.remove(id)
          return send(200, { ok: true })
        case 'PUT /tasks/:id': {
          const { model } = json(await readBody(req))
          if (typeof model !== 'string') throw codeError('bad-request', 'body needs "model"')
          await models.assign(id, model)
          return send(200, { ok: true })
        }
        case 'POST /ensure': {
          const { tasks } = json(await readBody(req))
          if (!Array.isArray(tasks)) throw codeError('bad-request', 'body needs "tasks": [...]')
          return send(200, { tasks: await models.ensure(tasks) })
        }
        case 'POST /tasks/:id':
          switch (id) {
            case 'transcribe': {
              const audio = await readBody(req)
              if (!audio.length) throw codeError('bad-request', 'empty audio')
              return send(200, await models.transcribe(audio, { language: url.searchParams.get('language') || 'auto' }))
            }
            case 'translate': {
              const { text, from, to } = json(await readBody(req))
              if (typeof text !== 'string' || typeof to !== 'string') throw codeError('bad-request', 'body needs "text" and "to"')
              if (!text.trim()) return send(200, { text: '' })
              return send(200, await models.translate({ text, from, to }))
            }
            case 'chat': {
              const { messages, temperature, maxTokens } = json(await readBody(req))
              if (!Array.isArray(messages)) throw codeError('bad-request', 'body needs "messages"')
              return send(200, await models.chat({ messages, temperature, maxTokens }))
            }
            default:
              throw codeError('unknown-task', `unknown task ${id}`)
          }
        default:
          throw codeError('not-found', `no route ${req.method} ${url.pathname}`)
      }
    } catch (e) {
      const err = /** @type {Error & { code?: string }} */ (e)
      const status = (err.code && STATUS[err.code]) || 500
      if (status === 500) models.log(`models: ${req.method} ${req.url}: ${err.stack || err.message}`)
      if (!res.headersSent) send(status, { error: err.code || 'internal', message: err.message })
    }
  })
}

/**
 * Prepara el directorio privado y escucha. Si ya hay otro gestor contestando en el socket, no
 * se le pisa: se para y se dice.
 * @param {http.Server} server @param {ReturnType<import('./paths.js').paths>} p
 */
export async function listen (server, p) {
  await mkdir(p.run, { recursive: true, mode: 0o700 })
  await chmod(p.run, 0o700)
  const st = await stat(p.run)
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw codeError('run-dir-not-ours', `${p.run} belongs to another user`)
  }
  try {
    await request({ socket: p.socket, path: '/status', timeoutMs: 1000 })
    throw codeError('already-running', `another dotrino-models is already answering on ${p.socket}`)
  } catch (e) {
    if (/** @type {any} */ (e).code === 'already-running') throw e
  }
  await rm(p.socket, { force: true })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(p.socket, () => { server.off('error', reject); resolve(undefined) })
  })
  await chmod(p.socket, 0o600)
}
