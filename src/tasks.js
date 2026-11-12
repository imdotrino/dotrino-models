// Lo que las apps piden: una TAREA, no un modelo. Qué modelo atiende cada tarea lo decide el
// usuario en el gestor; la app no se entera.
import { request, requestJson, multipart } from './uhttp.js'
import { codeError } from './catalog.js'

export const LANGUAGE_NAMES = /** @type {Record<string, string>} */ ({
  es: 'Spanish', en: 'English', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian',
  nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi', ca: 'Catalan', gl: 'Galician', eu: 'Basque'
})

/** @param {string} code */
export function languageName (code) {
  const n = LANGUAGE_NAMES[code]
  if (!n) throw codeError('unknown-language', `unknown language ${code}`)
  return n
}

/**
 * Voz a texto con whisper.cpp. `audio` es un WAV de 16 kHz mono.
 * @param {string} socket @param {Buffer} audio @param {{ language?: string }} [o]
 * @returns {Promise<{ text: string }>}
 */
export async function transcribe (socket, audio, { language = 'auto' } = {}) {
  const { body, contentType } = multipart([
    { name: 'file', value: audio, filename: 'audio.wav', type: 'audio/wav' },
    { name: 'response_format', value: 'json' },
    { name: 'language', value: language }
  ])
  const r = await request({ socket, method: 'POST', path: '/inference', body, headers: { 'content-type': contentType } })
  const text = r.body.toString('utf8')
  if (r.status !== 200) throw codeError('engine-error', `whisper.cpp: HTTP ${r.status}: ${text.slice(0, 200)}`)
  /** @type {{ text?: string, error?: string }} */
  const data = JSON.parse(text)
  if (typeof data.text !== 'string') throw codeError('engine-error', `whisper.cpp: ${data.error || 'no text in the answer'}`)
  return { text: data.text.replace(/\s+/g, ' ').trim() }
}

/**
 * Chat con llama.cpp (API compatible con OpenAI).
 * @param {string} socket @param {Array<{ role: string, content: string }>} messages
 * @param {{ temperature?: number, maxTokens?: number }} [o]
 * @returns {Promise<{ text: string }>}
 */
export async function chat (socket, messages, { temperature = 0.7, maxTokens = 1024 } = {}) {
  const r = await requestJson({
    socket, method: 'POST', path: '/v1/chat/completions',
    json: { messages, temperature, max_tokens: maxTokens }
  })
  const text = r.data?.choices?.[0]?.message?.content
  if (r.status !== 200 || typeof text !== 'string') {
    throw codeError('engine-error', `llama.cpp: HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`)
  }
  return { text: text.trim() }
}

/**
 * Traducción de subtítulos. El aviso de «deja las frases a medias a medias» es lo que permite
 * traducir trozos de 3 s sin que el modelo invente el final (medido el 2026-11-12).
 * @param {string} socket @param {{ text: string, from?: string, to: string }} o
 */
export async function translate (socket, { text, from = 'auto', to }) {
  const src = from === 'auto' ? 'the source language' : languageName(from)
  const system = `You translate live subtitles from ${src} to ${languageName(to)}. ` +
    'Reply with the translation only, no quotes, no notes. Keep unfinished sentences unfinished.'
  return chat(socket, [{ role: 'system', content: system }, { role: 'user', content: text }], { temperature: 0, maxTokens: 256 })
}
