// El puente de la ventana: la ventana (Rust + iced) lo lanza y le habla por sus tuberías, una
// línea JSON por mensaje, como la de la bóveda. Así la ventana no sabe nada de HTTP ni de
// sockets, y todo lo que hace pasa por el mismo cliente que la CLI.
//
//   salida:  {"t":"status","v":{...}}   cada vez que cambia el estado
//            {"t":"error","op":"install","msg":"..."}
//   entrada: {"op":"install","id":"..."} · cancel · start · stop · remove · {"op":"assign","task","id"} · {"op":"serve"}
import { createInterface } from 'node:readline'
import { createClient } from './client.js'
import { startDetached } from './daemon.js'

/** @param {{ version: string }} o */
export async function runBridge ({ version }) {
  const client = createClient()
  const out = (/** @type {unknown} */ msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  let last = ''
  let stopped = false

  const poll = async () => {
    /** @type {unknown} */
    let v
    try {
      v = { daemon: true, bridgeVersion: version, ...(await client.status()) }
    } catch (e) {
      const err = /** @type {Error & { code?: string }} */ (e)
      v = { daemon: false, bridgeVersion: version, code: err.code, error: err.message }
    }
    const s = JSON.stringify(v)
    if (s !== last) { last = s; out({ t: 'status', v }) }
  }

  const ops = /** @type {Record<string, (m: any) => Promise<unknown>>} */ ({
    install: (m) => client.install(m.id),
    cancel: (m) => client.cancel(m.id),
    start: (m) => client.start(m.id),
    stop: (m) => client.stop(m.id),
    remove: (m) => client.remove(m.id),
    assign: (m) => client.assign(m.task, m.id),
    serve: async () => startDetached()
  })

  const rl = createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    /** @type {any} */
    let m
    try { m = JSON.parse(line) } catch { return out({ t: 'error', op: '?', msg: 'bad JSON from the window' }) }
    const fn = ops[m?.op]
    if (!fn) return out({ t: 'error', op: String(m?.op), msg: `unknown op ${m?.op}` })
    try { await fn(m) } catch (e) { out({ t: 'error', op: m.op, id: m.id, msg: /** @type {Error} */ (e).message }) }
    await poll()
  })
  // La ventana se cerró: se cierra el puente. El gestor sigue corriendo para las demás apps.
  rl.on('close', () => { stopped = true; process.exit(0) })

  while (!stopped) {
    await poll()
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}
