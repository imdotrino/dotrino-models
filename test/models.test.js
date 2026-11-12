import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { platformKey, validate, loadCatalog } from '../src/catalog.js'
import { paths } from '../src/paths.js'
import { Models } from '../src/service.js'
import { createServer, listen } from '../src/server.js'
import { createClient } from '../src/client.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-engine.js', import.meta.url))
const sha = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex')

/** @type {string} */ let tmp
/** @type {http.Server} */ let files
/** @type {Record<string, Buffer>} */ const served = {}
/** @type {any} */ let catalog
/** @type {ReturnType<typeof paths>} */ let p

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'dotrino-models-test-'))
  // Un tarball por motor, con un lanzador que corre el motor de mentira.
  for (const name of ['whisper.cpp', 'llama.cpp']) {
    const dir = path.join(tmp, 'pack', name, `${name}-fake`)
    await mkdir(dir, { recursive: true })
    const bin = name === 'whisper.cpp' ? 'whisper-server' : 'llama-server'
    await writeFile(path.join(dir, bin), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
    await chmod(path.join(dir, bin), 0o755)
    execFileSync('tar', ['czf', path.join(tmp, `${name}.tgz`), '-C', path.join(tmp, 'pack', name), `${name}-fake`])
    served[`/${name}.tgz`] = await readFile(path.join(tmp, `${name}.tgz`))
  }
  served['/asr.bin'] = Buffer.from('asr-model')
  served['/llm.gguf'] = Buffer.from('llm-model')
  served['/bad.gguf'] = Buffer.from('tampered')
  files = http.createServer((req, res) => {
    const b = served[req.url || '']
    if (!b) { res.statusCode = 404; return res.end() }
    res.setHeader('content-length', b.length)
    res.end(b)
  })
  await new Promise((resolve) => files.listen(0, '127.0.0.1', () => resolve(undefined)))
  const base = `http://127.0.0.1:${/** @type {any} */ (files.address()).port}`
  const build = (/** @type {string} */ name) => ({
    version: '1', bin: name === 'whisper.cpp' ? 'whisper-server' : 'llama-server',
    builds: { [platformKey()]: { url: `${base}/${name}.tgz`, sha256: sha(served[`/${name}.tgz`]), dir: `${name}-fake` } }
  })
  const file = (/** @type {string} */ f, /** @type {Buffer} */ b) => ({ url: `${base}${f}`, sha256: sha(b), size: b.length })
  const tested = { es: 'x', en: 'x' }
  catalog = {
    engines: { 'whisper.cpp': build('whisper.cpp'), 'llama.cpp': build('llama.cpp') },
    models: [
      { id: 'asr', name: 'ASR', tasks: ['transcribe'], default: ['transcribe'], engine: 'whisper.cpp', file: file('/asr.bin', served['/asr.bin']), vramMB: 1, languages: 'x', tested },
      { id: 'llm', name: 'LLM', tasks: ['translate', 'chat'], default: ['translate', 'chat'], engine: 'llama.cpp', file: file('/llm.gguf', served['/llm.gguf']), vramMB: 1, languages: 'x', tested },
      // El hash fijado no es el de lo que sirve el servidor: tiene que negarse a instalarlo.
      { id: 'evil', name: 'Evil', tasks: ['chat'], engine: 'llama.cpp', file: { ...file('/bad.gguf', served['/bad.gguf']), sha256: sha(Buffer.from('original')) }, vramMB: 1, languages: 'x', tested }
    ]
  }
  validate(catalog)
  p = paths({ XDG_DATA_HOME: path.join(tmp, 'data'), XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_RUNTIME_DIR: path.join(tmp, 'run') })
})

after(async () => {
  files.close()
  await rm(tmp, { recursive: true, force: true })
})

test('the shipped catalog is valid', () => {
  assert.ok(loadCatalog().models.length > 0)
})

test('install, ensure, run tasks through the socket, stop on idle', async () => {
  const models = new Models({ paths: p, catalog, idleMs: 50 })
  const server = createServer(models, { version: '0.0.0-test' })
  await listen(server, p)
  const c = createClient({ socket: p.socket })
  try {
    const st0 = await c.status()
    assert.equal(st0.v.product, 'models')
    assert.deepEqual(st0.tasks, {})
    assert.equal(st0.models.find((/** @type {any} */ m) => m.id === 'asr').state, 'absent')

    // Sin modelo elegido, la tarea se niega con un código que se puede buscar.
    await assert.rejects(c.translate({ text: 'hola', to: 'en' }), { code: 'no-model-for-task' })

    // Lo que hace una app al instalarse: pide tareas, y se bajan los modelos por defecto.
    assert.deepEqual((await c.ensure(['transcribe', 'translate'])).tasks, { transcribe: 'asr', translate: 'llm' })
    await models.installs.get('asr')?.promise
    await models.installs.get('llm')?.promise
    const st1 = await c.status()
    assert.deepEqual(st1.tasks, { transcribe: 'asr', translate: 'llm', chat: 'llm' })

    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(100)])
    assert.equal((await c.transcribe(wav, { language: 'es' })).text, 'asr-model heard audio')
    assert.equal((await c.translate({ text: 'hola', from: 'es', to: 'en' })).text, '[llm-model] hola')
    assert.equal((await c.status()).models.find((/** @type {any} */ m) => m.id === 'llm').state, 'running')

    await assert.rejects(c.translate({ text: 'x', to: 'xx' }), { code: 'unknown-language' })

    // Sin uso, se apaga solo.
    models.engines.sweep()
    await new Promise((resolve) => setTimeout(resolve, 100))
    models.engines.sweep()
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal((await c.status()).models.find((/** @type {any} */ m) => m.id === 'llm').state, 'stopped')

    // Y se vuelve a encender al pedirlo.
    assert.equal((await c.chat({ messages: [{ role: 'user', content: 'otra' }] })).text, '[llm-model] otra')
  } finally {
    server.close()
    await models.close()
  }
})

test('a file whose hash does not match the catalog is not installed', async () => {
  const models = new Models({ paths: p, catalog })
  await assert.rejects(models.install('evil'), { code: 'checksum-mismatch' })
  assert.equal(await models.isInstalled('evil'), false)
  const st = await models.status()
  assert.match(st.models.find((m) => m.id === 'evil')?.error || '', /sha256/)
  await models.close()
})

test('a second manager does not take over the socket', async () => {
  const models = new Models({ paths: p, catalog })
  const s1 = createServer(models, { version: '0' })
  await listen(s1, p)
  await assert.rejects(listen(createServer(models, { version: '0' }), p), { code: 'already-running' })
  s1.close()
  await models.close()
})

test('remove deletes the model, its task assignment and the unused engine', async () => {
  const models = new Models({ paths: p, catalog })
  await models.install('asr')
  await models.remove('asr')
  assert.equal(await models.isInstalled('asr'), false)
  assert.equal((await models.status()).tasks.transcribe, undefined)
  await models.close()
})

test('unreadable settings stop instead of falling back to defaults', async () => {
  await mkdir(path.dirname(p.settings), { recursive: true })
  await writeFile(p.settings, '{ not json')
  const models = new Models({ paths: p, catalog })
  await assert.rejects(models.status(), { code: 'settings-unreadable' })
  await rm(p.settings)
  await models.close()
})
