// Dónde vive cada cosa. Lo bajado, en datos del usuario; los ajustes, en su configuración; los
// sockets, en su directorio de ejecución, que solo él puede abrir.
import path from 'node:path'
import os from 'node:os'
import { codeError } from './catalog.js'

/** @param {NodeJS.ProcessEnv} env */
export function paths (env = process.env) {
  const home = os.homedir()
  const data = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'dotrino', 'models')
  const config = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'dotrino')
  return {
    data,
    engines: path.join(data, 'engines'),
    models: path.join(data, 'models'),
    settings: path.join(config, 'models.json'),
    get run () { return runDir(env) },
    get socket () { return path.join(runDir(env), 'models.sock') }
  }
}

/**
 * El directorio de los sockets. Sin XDG_RUNTIME_DIR no se inventa otro: uno en /tmp lo podría
 * preparar otro usuario antes que nosotros, y ese es justo el agujero que el socket evita.
 * @param {NodeJS.ProcessEnv} env
 */
export function runDir (env = process.env) {
  if (env.DOTRINO_MODELS_RUN_DIR) return env.DOTRINO_MODELS_RUN_DIR
  if (!env.XDG_RUNTIME_DIR) throw codeError('no-runtime-dir', 'XDG_RUNTIME_DIR is not set: there is no private place for the sockets')
  return path.join(env.XDG_RUNTIME_DIR, 'dotrino-models')
}
