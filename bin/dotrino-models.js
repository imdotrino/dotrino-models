#!/usr/bin/env node
// dotrino-models: los modelos de IA de Dotrino en tu computadora.
import { readFileSync } from 'node:fs'
import { printUpdateNotice } from '@dotrino/update/notice'
import { createClient } from '../src/client.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const es = /^es/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '')

const HELP = es
  ? `dotrino-models ${VERSION} — los modelos de IA de Dotrino en tu computadora

  serve                         corre el gestor (lo lanza el servicio)
  service install|uninstall     arrancarlo al iniciar sesión (systemd de usuario)
  status                        el catálogo: qué está instalado y encendido
  install <modelo>              bajar un modelo (y su motor)
  remove <modelo>               borrarlo del disco
  start <modelo> | stop <modelo>
  use <tarea> <modelo>          qué modelo atiende una tarea (transcribe, translate, chat)
  ensure <tarea>...             lo que pide una app al instalarse
  transcribe <archivo.wav> [--lang es]
  translate --to es [--from en] <texto>
  version`
  : `dotrino-models ${VERSION} — Dotrino's AI models on your computer

  serve                         run the manager (the service launches it)
  service install|uninstall     start it at login (systemd user unit)
  status                        the catalog: what is installed and running
  install <model>               download a model (and its engine)
  remove <model>                delete it from disk
  start <model> | stop <model>
  use <task> <model>            which model serves a task (transcribe, translate, chat)
  ensure <task>...              what an app asks for when it is installed
  transcribe <file.wav> [--lang es]
  translate --to es [--from en] <text>
  version`

/** @param {string[]} args @param {string} name */
function flag (args, name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

/** @param {number} n */
function mb (n) { return `${Math.round(n / 1e6)} MB` }

async function main () {
  const [cmd, ...args] = process.argv.slice(2)
  const client = createClient()
  switch (cmd) {
    case 'serve': {
      const { serve } = await import('../src/daemon.js')
      return serve({ version: VERSION })
    }
    case 'bridge': {
      const { runBridge } = await import('../src/bridge.js')
      return runBridge({ version: VERSION })
    }
    case 'service': {
      const d = await import('../src/daemon.js')
      if (args[0] === 'install') console.log(await d.installService())
      else if (args[0] === 'uninstall') await d.uninstallService()
      else throw usage()
      break
    }
    case 'status': {
      const s = await client.status()
      console.log(`dotrino-models ${s.v.version}`)
      for (const [t, id] of Object.entries(s.tasks)) console.log(`  ${t} → ${id}`)
      for (const m of s.models) {
        const prog = m.progress ? ` ${m.progress.phase} ${mb(m.progress.done)}/${mb(m.progress.total)}` : ''
        console.log(`${m.id.padEnd(26)} ${m.state}${prog}  [${m.tasks.join(', ')}] ${mb(m.size)}${m.error ? `  ! ${m.error}` : ''}`)
      }
      break
    }
    case 'install': await client.install(need(args[0])); console.log(es ? 'bajando; mira «status»' : 'downloading; see "status"'); break
    case 'remove': await client.remove(need(args[0])); break
    case 'start': await client.start(need(args[0])); break
    case 'stop': await client.stop(need(args[0])); break
    case 'use': await client.assign(need(args[0]), need(args[1])); break
    case 'ensure': console.log(JSON.stringify((await client.ensure(args)).tasks)); break
    case 'transcribe': {
      const lang = flag(args, '--lang')
      const r = await client.transcribe(readFileSync(need(args[0])), { language: lang })
      console.log(r.text)
      break
    }
    case 'translate': {
      const to = flag(args, '--to')
      const from = flag(args, '--from')
      const r = await client.translate({ text: args.join(' '), from, to: need(to) })
      console.log(r.text)
      break
    }
    case 'version': case '--version': console.log(VERSION); break
    case undefined: case 'help': case '--help': console.log(HELP); break
    default: throw usage()
  }
  await printUpdateNotice({ current: VERSION, source: 'npm', pkg: '@dotrino/models', how: 'npm i -g @dotrino/models' })
}

function usage () { return Object.assign(new Error(HELP), { code: 'usage' }) }
/** @param {string | undefined} v */
function need (v) { if (!v) throw usage(); return v }

main().catch((e) => {
  if (e.code === 'usage') { console.error(e.message); process.exit(2) }
  console.error(`dotrino-models: ${e.code ? `[${e.code}] ` : ''}${e.message}`)
  process.exit(1)
})
