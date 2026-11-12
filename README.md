# dotrino-models

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

Los modelos de IA que usa Dotrino, en tu computadora. Un **catálogo de modelos que Dotrino
probó**; las apps piden una **tarea** (voz a texto, traducir, conversar) y el gestor baja el
modelo que la atiende, lo enciende cuando hace falta y lo apaga cuando nadie lo usa.

Dos piezas, igual que la bóveda:

| | Qué es |
|---|---|
| `dotrino-models` (npm `@dotrino/models`) | el gestor: servicio de usuario en Node, CLI y cliente para otras piezas de Node |
| `desktop/` | la ventana (Rust + iced): lanza `dotrino-models bridge` y le habla por tuberías |

Uso para el usuario: [wiki.dotrino.com/herramientas/modelos](https://wiki.dotrino.com/herramientas/modelos/).

## Cómo funciona

- **El catálogo viaja en el código** (`src/catalog.json`). Cada archivo, motor o modelo,
  lleva su sha256 fijado ahí: lo bajado se comprueba antes de usarse, y un catálogo nuevo es
  una versión nueva (CONVENCIONES §14).
- **Motores**: whisper.cpp (voz a texto) y llama.cpp (traducir, conversar), con **Vulkan**, como
  procesos aparte. llama.cpp viene de su release oficial; whisper.cpp lo compila
  `.github/workflows/engines.yml` (no publica Vulkan para Linux) con un parche para escuchar en
  un socket UNIX (`engines/whisper.cpp/unix-socket.patch`).
- **Sin puertos.** El gestor y cada motor escuchan en sockets UNIX dentro de
  `$XDG_RUNTIME_DIR/dotrino-models/` (0700). Los motores traen un CORS abierto a cualquier
  origen: en un puerto, cualquier página web abierta en el navegador podría usarlos.
- **Se enciende al pedirlo, se apaga sin uso** (10 min): la memoria de video no se queda
  ocupada.
- **Las tareas**: `transcribe`, `translate`, `chat`. Qué modelo atiende cada una lo elige el
  usuario; el primero que se instala para una tarea sin elegir la atiende.

## API (HTTP por el socket)

```
GET    /status                       catálogo + estado + versión (@dotrino/compat)
POST   /ensure {tasks:[...]}         lo que pide una app al instalarse: baja lo que falte
POST   /models/:id/install|cancel|start|stop
DELETE /models/:id
PUT    /tasks/:task {model}
POST   /tasks/transcribe?language=   cuerpo: WAV 16 kHz mono → {text}
POST   /tasks/translate {text, from, to} → {text}
POST   /tasks/chat {messages} → {text}
```

Los errores son `{ error: <código>, message }` (`no-model-for-task`, `not-installed`,
`checksum-mismatch`, `unknown-language`…). Desde Node: `import { createClient } from '@dotrino/models'`.

## Desarrollo

```sh
npm install
npm test && npm run type-check
node bin/dotrino-models.js serve            # el gestor
cd desktop && cargo run                      # la ventana (DOTRINO_MODELS_BIN=… para usar el checkout)
```

Pendiente: Windows y macOS; los conectores (Claude, DeepSeek… con la llave en la bóveda).
