<h1 align="center">Fastify</h1>

## HTTP/2

_Fastify_ unterstützt HTTP/2 über HTTPS (h2) oder im Klartext (h2c).

Derzeit sind keine der HTTP/2-spezifischen APIs über _Fastify_ verfügbar, aber
auf Nodes `req` und `res` kann über die Interfaces `Request` und `Reply`
zugegriffen werden. PRs sind willkommen.

### Gesichert (HTTPS)

HTTP/2 wird in allen modernen Browsern __ausschließlich über eine gesicherte Verbindung__ unterstützt:

```js
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const fastify = require('fastify')({
  http2: true,
  https: {
    key: fs.readFileSync(path.join(__dirname, '..', 'https', 'fastify.key')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'https', 'fastify.cert'))
  }
})

fastify.get('/', function (request, reply) {
  reply.code(200).send({ hello: 'world' })
})

fastify.listen({ port: 3000 })
```

Die [ALPN-Aushandlung](https://datatracker.ietf.org/doc/html/rfc7301) ermöglicht
sowohl HTTPS als auch HTTP/2 über denselben Socket.
Die `req`- und `res`-Objekte des Node-Kerns können entweder
[HTTP/1](https://nodejs.org/api/http.html) oder
[HTTP/2](https://nodejs.org/api/http2.html) sein. _Fastify_ unterstützt beides ohne
zusätzlichen Aufwand:

```js
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const fastify = require('fastify')({
  http2: true,
  https: {
    allowHTTP1: true, // fallback support for HTTP1
    key: fs.readFileSync(path.join(__dirname, '..', 'https', 'fastify.key')),
    cert: fs.readFileSync(path.join(__dirname, '..', 'https', 'fastify.cert'))
  }
})

// This route can be accessed through both protocols
fastify.get('/', function (request, reply) {
  reply.code(200).send({ hello: 'world' })
})

fastify.listen({ port: 3000 })
```

Testen Sie den Server mit:

```
$ npx h2url https://localhost:3000
```

### Klartext oder ungesichert

Für Microservices kann HTTP/2 im Klartext verbinden, was jedoch von Browsern
nicht unterstützt wird.

```js
'use strict'

const fastify = require('fastify')({
  http2: true
})

fastify.get('/', function (request, reply) {
  reply.code(200).send({ hello: 'world' })
})

fastify.listen({ port: 3000 })
```

Testen Sie den neuen Server mit:

```
$ npx h2url http://localhost:3000
```
