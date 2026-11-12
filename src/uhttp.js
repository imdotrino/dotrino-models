// HTTP sobre un socket UNIX: con el servicio y con los motores. Nada de esto escucha en un
// puerto, así que ninguna página web abierta en el navegador puede llegar.
import http from 'node:http'
import { codeError } from './catalog.js'

/**
 * @param {{ socket: string, method?: string, path: string, headers?: Record<string, string>,
 *   body?: Buffer | string, timeoutMs?: number }} o
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: Buffer }>}
 */
export function request ({ socket, method = 'GET', path, headers = {}, body, timeoutMs = 120_000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path, headers: { host: 'localhost', ...headers } }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(codeError('timeout', `${method} ${path}: no answer in ${timeoutMs} ms`)))
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

/** @param {Parameters<typeof request>[0] & { json?: unknown }} o */
export async function requestJson (o) {
  const body = o.json === undefined ? o.body : JSON.stringify(o.json)
  const headers = o.json === undefined ? o.headers : { 'content-type': 'application/json', ...o.headers }
  const r = await request({ ...o, body, headers })
  const text = r.body.toString('utf8')
  /** @type {any} */
  let data
  try { data = text ? JSON.parse(text) : null } catch {
    throw codeError('bad-response', `${o.method || 'GET'} ${o.path}: HTTP ${r.status}, not JSON: ${text.slice(0, 200)}`)
  }
  return { status: r.status, data }
}

/**
 * multipart/form-data a mano: el fetch de Node no habla con sockets UNIX sin una dependencia.
 * @param {Array<{ name: string, value: string | Buffer, filename?: string, type?: string }>} fields
 */
export function multipart (fields) {
  const boundary = '----dotrino' + Math.random().toString(16).slice(2)
  /** @type {Buffer[]} */
  const parts = []
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`
    if (f.filename) head += `; filename="${f.filename}"\r\nContent-Type: ${f.type || 'application/octet-stream'}`
    parts.push(Buffer.from(head + '\r\n\r\n'), Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value), Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}
