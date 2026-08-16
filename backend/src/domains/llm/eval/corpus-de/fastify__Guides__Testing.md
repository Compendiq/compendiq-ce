<h1 style="text-align: center;">Fastify</h1>

# Testen
<a id="testing"></a>

Testen ist einer der wichtigsten Teile der Anwendungsentwicklung. Fastify ist
beim Testen sehr flexibel und mit den meisten Test-Frameworks kompatibel (etwa
mit dem [Node Test Runner](https://nodejs.org/api/test.html), der in den
folgenden Beispielen verwendet wird).

## Anwendung

Wechseln wir mit `cd` in ein frisches Verzeichnis namens 'testing-example' und
geben `npm init -y` in unser Terminal ein.

Führen Sie `npm i fastify && npm i pino-pretty -D` aus.

### Die Trennung der Zuständigkeiten macht das Testen einfach

Zuerst trennen wir unseren Anwendungscode vom Servercode:

**app.js**:

```js
'use strict'

const fastify = require('fastify')

function build(opts={}) {
  const app = fastify(opts)
  app.get('/', async function (request, reply) {
    return { hello: 'world' }
  })

  return app
}

module.exports = build
```

**server.js**:

```js
'use strict'

const server = require('./app')({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty'
    }
  }
})

server.listen({ port: 3000 }, (err, address) => {
  if (err) {
    server.log.error(err)
    process.exit(1)
  }
})
```

### Vorteile von fastify.inject()

Fastify bringt dank
[`light-my-request`](https://github.com/fastify/light-my-request) eingebaute
Unterstützung für simulierte HTTP-Injektion mit.

Bevor wir irgendwelche Tests einführen, verwenden wir die Methode `.inject`, um
einen simulierten Request an unsere Route zu senden:

**app.test.js**:

```js
'use strict'

const build = require('./app')

const test = async () => {
  const app = build()

  const response = await app.inject({
    method: 'GET',
    url: '/'
  })

  console.log('status code: ', response.statusCode)
  console.log('body: ', response.body)
}
test()
```

Zunächst läuft unser Code innerhalb einer asynchronen Funktion, wodurch wir
Zugriff auf async/await haben.

`.inject` stellt sicher, dass alle registrierten Plugins hochgefahren sind und
unsere Anwendung bereit zum Testen ist. Schließlich übergeben wir die
gewünschte Request-Methode und eine Route. Mit await können wir die Response
ohne Callback speichern.



Führen Sie die Testdatei in Ihrem Terminal aus: `node app.test.js`

```sh
status code:  200
body:  {"hello":"world"}
```



### Testen mit HTTP-Injektion

Jetzt können wir unsere `console.log`-Aufrufe durch echte Tests ersetzen!

Ändern Sie in Ihrer `package.json` das "test"-Skript zu:

`"test": "node --test --watch"`

**app.test.js**:

```js
'use strict'

const { test } = require('node:test')
const build = require('./app')

test('requests the "/" route', async t => {
  t.plan(1)
  const app = build()

  const response = await app.inject({
    method: 'GET',
    url: '/'
  })
  t.assert.strictEqual(response.statusCode, 200, 'returns a status code of 200')
})
```

Führen Sie schließlich `npm test` im Terminal aus und sehen Sie sich Ihre
Testergebnisse an!

Die Methode `inject` kann weit mehr als einen einfachen GET-Request an eine URL:
```js
fastify.inject({
  method: String,
  url: String,
  query: Object,
  payload: Object,
  headers: Object,
  cookies: Object
}, (error, response) => {
  // your tests
})
```

`.inject`-Methoden lassen sich auch verketten, indem man die Callback-Funktion
weglässt:

```js
fastify
  .inject()
  .get('/')
  .headers({ foo: 'bar' })
  .query({ foo: 'bar' })
  .end((err, res) => { // the .end call will trigger the request
    console.log(res.payload)
  })
```

oder in der Promise-Variante

```js
fastify
  .inject({
    method: String,
    url: String,
    query: Object,
    payload: Object,
    headers: Object,
    cookies: Object
  })
  .then(response => {
    // your tests
  })
  .catch(err => {
    // handle error
  })
```

Async/await wird ebenfalls unterstützt!
```js
try {
  const res = await fastify.inject({ method: String, url: String, payload: Object, headers: Object })
  // your tests
} catch (err) {
  // handle error
}
```

#### Ein weiteres Beispiel:

**app.js**
```js
const Fastify = require('fastify')

function buildFastify () {
  const fastify = Fastify()

  fastify.get('/', function (request, reply) {
    reply.send({ hello: 'world' })
  })

  return fastify
}

module.exports = buildFastify
```

**test.js**
```js
const { test } = require('node:test')
const buildFastify = require('./app')

test('GET `/` route', t => {
  t.plan(4)

  const fastify = buildFastify()

  // At the end of your tests it is highly recommended to call `.close()`
  // to ensure that all connections to external services get closed.
  t.after(() => fastify.close())

  fastify.inject({
    method: 'GET',
    url: '/'
  }, (err, response) => {
    t.assert.ifError(err)
    t.assert.strictEqual(response.statusCode, 200)
    t.assert.strictEqual(response.headers['content-type'], 'application/json; charset=utf-8')
    t.assert.deepStrictEqual(response.json(), { hello: 'world' })
  })
})
```

### Testen mit laufendem Server
Fastify kann auch getestet werden, nachdem der Server mit `fastify.listen()`
gestartet oder Routes und Plugins mit `fastify.ready()` initialisiert wurden.

#### Beispiel:

Verwendet **app.js** aus dem vorherigen Beispiel.

**test-listen.js** (Testen mit [`undici`](https://www.npmjs.com/package/undici))
```js
const { test } = require('node:test')
const { Client } = require('undici')
const buildFastify = require('./app')

test('should work with undici', async t => {
  t.plan(2)

  const fastify = buildFastify()

  await fastify.listen()

   const client = new Client(
    'http://localhost:' + fastify.server.address().port, {
      keepAliveTimeout: 10,
      keepAliveMaxTimeout: 10
    }
  )

  t.after(() => {
    fastify.close()
    client.close()
  })

  const response = await client.request({ method: 'GET', path: '/' })

  t.assert.strictEqual(await response.body.text(), '{"hello":"world"}')
  t.assert.strictEqual(response.statusCode, 200)
})
```

Alternativ kann ab Node.js 18
[`fetch`](https://nodejs.org/docs/latest-v18.x/api/globals.html#fetch)
ohne zusätzliche Abhängigkeiten verwendet werden:

**test-listen.js**
```js
const { test } = require('node:test')
const buildFastify = require('./app')

test('should work with fetch', async t => {
  t.plan(3)

  const fastify = buildFastify()

  t.after(() => fastify.close())

  await fastify.listen()

  const response = await fetch(
    'http://localhost:' + fastify.server.address().port
  )

  t.assert.strictEqual(response.status, 200)
  t.assert.strictEqual(
    response.headers.get('content-type'),
    'application/json; charset=utf-8'
  )
  const jsonResult = await response.json()
  t.assert.strictEqual(jsonResult.hello, 'world')
})
```

**test-ready.js** (Testen mit
[`SuperTest`](https://www.npmjs.com/package/supertest))
```js
const { test } = require('node:test')
const supertest = require('supertest')
const buildFastify = require('./app')

test('GET `/` route', async (t) => {
  const fastify = buildFastify()

  t.after(() => fastify.close())

  await fastify.ready()

  const response = await supertest(fastify.server)
    .get('/')
    .expect(200)
    .expect('Content-Type', 'application/json; charset=utf-8')
  t.assert.deepStrictEqual(response.body, { hello: 'world' })
})
```

### Wie man Node-Tests inspiziert
1. Isolieren Sie Ihren Test, indem Sie die Option `{only: true}` übergeben
```javascript
test('should ...', {only: true}, t => ...)
```
2. Führen Sie `node --test` aus
```bash
> node --test --test-only --inspect-brk test/<test-file.test.js>
```
- `--test-only` gibt an, dass Tests mit aktivierter `only`-Option ausgeführt werden
- `--inspect-brk` startet den Node-Debugger
3. Erstellen und starten Sie in VS Code eine Debug-Konfiguration
   `Node.js: Attach`. Es sollten keine Anpassungen nötig sein.

Nun sollten Sie in Ihrem Code-Editor schrittweise durch Ihre Testdatei (und den
Rest von `Fastify`) gehen können.



## Plugins
Wechseln wir mit `cd` in ein frisches Verzeichnis namens
'testing-plugin-example' und geben `npm init -y` in unser Terminal ein.

Führen Sie `npm i fastify fastify-plugin` aus.

**plugin/myFirstPlugin.js**:

```js
const fP = require("fastify-plugin")

async function myPlugin(fastify, options) {
    fastify.decorateRequest("helloRequest", "Hello World")
    fastify.decorate("helloInstance", "Hello Fastify Instance")
}

module.exports = fP(myPlugin)
```

Ein einfaches Beispiel für ein Plugin. Siehe [Plugin-Guide](./Plugins-Guide.md)

**test/myFirstPlugin.test.js**:

```js
const Fastify = require("fastify");
const { test } = require("node:test");
const myPlugin = require("../plugin/myFirstPlugin");

test("Test the Plugin Route", async t => {
    // Create a mock fastify application to test the plugin
    const fastify = Fastify()

    fastify.register(myPlugin)

    // Add an endpoint of your choice
    fastify.get("/", async (request, reply) => {
        return ({ message: request.helloRequest })
    })

    // Use fastify.inject to fake a HTTP Request
    const fastifyResponse = await fastify.inject({
        method: "GET",
        url: "/"
    })

  console.log('status code: ', fastifyResponse.statusCode)
  console.log('body: ', fastifyResponse.body)
})
```
Erfahren Sie mehr über [```fastify.inject()```](#benefits-of-using-fastifyinject).
Führen Sie die Testdatei in Ihrem Terminal aus: `node test/myFirstPlugin.test.js`

```sh
status code:  200
body:  {"message":"Hello World"}
```

Jetzt können wir unsere `console.log`-Aufrufe durch echte Tests ersetzen!

Ändern Sie in Ihrer `package.json` das "test"-Skript zu:

`"test": "node --test --watch"`

Erstellen Sie den Test für den Endpunkt.

**test/myFirstPlugin.test.js**:

```js
const Fastify = require("fastify");
const { test } = require("node:test");
const myPlugin = require("../plugin/myFirstPlugin");

test("Test the Plugin Route", async t => {
    // Specifies the number of test
    t.plan(2)

    const fastify = Fastify()

    fastify.register(myPlugin)

    fastify.get("/", async (request, reply) => {
        return ({ message: request.helloRequest })
    })

    const fastifyResponse = await fastify.inject({
        method: "GET",
        url: "/"
    })

    t.assert.strictEqual(fastifyResponse.statusCode, 200)
    t.assert.deepStrictEqual(JSON.parse(fastifyResponse.body), { message: "Hello World" })
})
```

Führen Sie schließlich `npm test` im Terminal aus und sehen Sie sich Ihre
Testergebnisse an!

Testen Sie ```.decorate()``` und ```.decorateRequest()```.

**test/myFirstPlugin.test.js**:

```js
const Fastify = require("fastify");
const { test }= require("node:test");
const myPlugin = require("../plugin/myFirstPlugin");

test("Test the Plugin Route", async t => {
    t.plan(5)
    const fastify = Fastify()

    fastify.register(myPlugin)

    fastify.get("/", async (request, reply) => {
        // Testing the fastify decorators
        t.assert.ifError(request.helloRequest)
        t.assert.ok(request.helloRequest, "Hello World")
        t.assert.ok(fastify.helloInstance, "Hello Fastify Instance")
        return ({ message: request.helloRequest })
    })

    const fastifyResponse = await fastify.inject({
        method: "GET",
        url: "/"
    })
    t.assert.strictEqual(fastifyResponse.statusCode, 200)
    t.assert.deepStrictEqual(JSON.parse(fastifyResponse.body), { message: "Hello World" })
})
```
