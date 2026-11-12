// Un motor de mentira con la misma cara que whisper-server y llama-server: escucha en el socket
// que le pasan con --host y contesta lo justo para probar el gestor sin GPU ni modelos.
import http from 'node:http'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const sock = args[args.indexOf('--host') + 1]
const model = readFileSync(args[args.indexOf('-m') + 1], 'utf8').trim()

http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') return res.end('{"status":"ok"}')
    if (req.url === '/inference') return res.end(JSON.stringify({ text: ` ${model} heard ${body.includes('RIFF') ? 'audio' : 'nothing'} \n` }))
    if (req.url === '/v1/chat/completions') {
      const { messages } = JSON.parse(body)
      return res.end(JSON.stringify({ choices: [{ message: { content: ` [${model}] ${messages.at(-1).content} ` } }] }))
    }
    res.statusCode = 404
    res.end('{}')
  })
}).listen(sock)
