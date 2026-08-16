<h1 align="center">Fastify</h1>

## Erste Schritte

Hallo! Danke, dass Sie sich Fastify ansehen!

Dieses Dokument soll eine sanfte Einführung in das Framework und seine
Funktionen bieten. Es ist ein elementares Vorwort mit Beispielen und Links zu
anderen Teilen der Dokumentation.

Los geht's!

### Installation
<a id="install"></a>

Installation mit npm:
```sh
npm i fastify
```

Installation mit yarn:
```sh
yarn add fastify
```

### Ihr erster Server
<a id="first-server"></a>

Schreiben wir unseren ersten Server:
```js
// Require the framework and instantiate it

// ESM
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})
// CommonJs
const fastify = require('fastify')({
  logger: true
})

// Declare a route
fastify.get('/', function (request, reply) {
  reply.send({ hello: 'world' })
})

// Run the server!
fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is now listening on ${address}
})
```

> Wenn Sie in Ihrem Projekt ECMAScript-Module (ESM) verwenden, achten Sie darauf,
> "type": "module" in Ihre package.json aufzunehmen.
>```js
>{
>  "type": "module"
>}
>```

Bevorzugen Sie `async/await`? Fastify unterstützt das von Haus aus.

```js
// ESM
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true
})
// CommonJs
const fastify = require('fastify')({
  logger: true
})

fastify.get('/', async (request, reply) => {
  return { hello: 'world' }
})

/**
 * Run the server!
 */
const start = async () => {
  try {
    await fastify.listen({ port: 3000 })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()
```

Großartig, das war unkompliziert.

Leider erfordert das Schreiben einer komplexen Anwendung deutlich mehr Code als
dieses Beispiel. Ein klassisches Problem beim Aufbau einer neuen Anwendung ist
der Umgang mit mehreren Dateien, asynchronem Bootstrapping und der Architektur
Ihres Codes.

Fastify bietet eine Plattform, die dabei hilft, alle oben genannten Probleme zu
lösen – und mehr!

> **Hinweis**
> Die obigen Beispiele und die weiteren Beispiele in diesem Dokument lauschen
> standardmäßig *nur* auf der Localhost-Schnittstelle `127.0.0.1`. Um auf allen
> verfügbaren IPv4-Schnittstellen zu lauschen, sollte das Beispiel so angepasst
> werden, dass es auf `0.0.0.0` lauscht:
>
> ```js
> fastify.listen({ port: 3000, host: '0.0.0.0' }, function (err, address) {
>   if (err) {
>     fastify.log.error(err)
>     process.exit(1)
>   }
>   fastify.log.info(`server listening on ${address}`)
> })
> ```
>
> Analog geben Sie `::1` an, um nur lokale Verbindungen über IPv6 anzunehmen.
> Oder geben Sie `::` an, um Verbindungen auf allen IPv6-Adressen anzunehmen und,
> sofern das Betriebssystem das unterstützt, auch auf allen IPv4-Adressen.
>
> Beim Deployment in einen Docker-Container (oder einen anderen Containertyp) ist
> `0.0.0.0` oder `::` der einfachste Weg, die Anwendung nach außen verfügbar zu machen.
>
> Beachten Sie, dass bei Verwendung von `0.0.0.0` die im obigen Callback-Argument
> gelieferte Adresse die erste Adresse ist, auf die der Platzhalter verweist.

### Ihr erstes Plugin
<a id="first-plugin"></a>

Wie in JavaScript alles ein Objekt ist, ist in Fastify alles ein Plugin.

Bevor wir tiefer einsteigen, schauen wir uns an, wie es funktioniert!

Deklarieren wir unseren einfachen Server, aber statt die Route im Einstiegspunkt
zu deklarieren, deklarieren wir sie in einer externen Datei (siehe die
Dokumentation zur [Routendeklaration](../Reference/Routes.md)).
```js
// ESM
import Fastify from 'fastify'
import routes from './our-first-routes.js'
/**
 * @type {import('fastify').FastifyInstance} Instance of Fastify
 */
const fastify = Fastify({
  logger: true
})

fastify.register(routes)

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is now listening on ${address}
})
```

```js
// CommonJs
/**
 * @type {import('fastify').FastifyInstance} Instance of Fastify
 */
const fastify = require('fastify')({
  logger: true
})

fastify.register(require('./our-first-routes'))

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is now listening on ${address}
})
```


```js
// our-first-routes.js

/**
 * Encapsulates the routes
 * @param {FastifyInstance} fastify  Encapsulated Fastify Instance
 * @param {Object} options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
async function routes (fastify, options) {
  fastify.get('/', async (request, reply) => {
    return { hello: 'world' }
  })
}

//ESM
export default routes;

// CommonJs
module.exports = routes
```
In diesem Beispiel haben wir die `register`-API verwendet, die den Kern des
Fastify-Frameworks bildet. Sie ist der einzige Weg, um Routen, Plugins und so
weiter hinzuzufügen.

Zu Beginn dieses Leitfadens haben wir angemerkt, dass Fastify eine Grundlage
bietet, die beim asynchronen Bootstrapping Ihrer Anwendung hilft. Warum ist das
wichtig?

Stellen Sie sich das Szenario vor, dass eine Datenbankverbindung nötig ist, um
Daten zu speichern. Die Datenbankverbindung muss verfügbar sein, bevor der
Server Verbindungen annimmt. Wie gehen wir dieses Problem an?

Eine typische Lösung besteht in einem komplexen Callback oder in Promises – einem
System, das die Framework-API mit anderen Bibliotheken und dem Anwendungscode
vermischt.

Fastify erledigt das intern, mit minimalem Aufwand!

Schreiben wir das obige Beispiel mit einer Datenbankverbindung um.


Installieren Sie zunächst `fastify-plugin` und `@fastify/mongodb`:

```sh
npm i fastify-plugin @fastify/mongodb
```

**server.js**
```js
// ESM
import Fastify from 'fastify'
import dbConnector from './our-db-connector.js'
import routes from './our-first-routes.js'

/**
 * @type {import('fastify').FastifyInstance} Instance of Fastify
 */
const fastify = Fastify({
  logger: true
})
fastify.register(dbConnector)
fastify.register(routes)

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is now listening on ${address}
})
```

```js
// CommonJs
/**
 * @type {import('fastify').FastifyInstance} Instance of Fastify
 */
const fastify = require('fastify')({
  logger: true
})

fastify.register(require('./our-db-connector'))
fastify.register(require('./our-first-routes'))

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
  // Server is now listening on ${address}
})

```

**our-db-connector.js**
```js
// ESM
import fastifyPlugin from 'fastify-plugin'
import fastifyMongo from '@fastify/mongodb'

/**
 * @param {FastifyInstance} fastify
 * @param {Object} options
 */
async function dbConnector (fastify, options) {
  fastify.register(fastifyMongo, {
    url: 'mongodb://localhost:27017/test_database'
  })
}

// Wrapping a plugin function with fastify-plugin exposes the decorators
// and hooks, declared inside the plugin to the parent scope.
export default fastifyPlugin(dbConnector)

```

```js
// CommonJs
/**
 * @type {import('fastify-plugin').FastifyPlugin}
 */
const fastifyPlugin = require('fastify-plugin')


/**
 * Connects to a MongoDB database
 * @param {FastifyInstance} fastify Encapsulated Fastify Instance
 * @param {Object} options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
async function dbConnector (fastify, options) {
  fastify.register(require('@fastify/mongodb'), {
    url: 'mongodb://localhost:27017/test_database'
  })
}

// Wrapping a plugin function with fastify-plugin exposes the decorators
// and hooks, declared inside the plugin to the parent scope.
module.exports = fastifyPlugin(dbConnector)

```

**our-first-routes.js**
```js
/**
 * A plugin that provide encapsulated routes
 * @param {FastifyInstance} fastify encapsulated fastify instance
 * @param {Object} options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
async function routes (fastify, options) {
  const collection = fastify.mongo.db.collection('test_collection')

  fastify.get('/', async (request, reply) => {
    return { hello: 'world' }
  })

  fastify.get('/animals', async (request, reply) => {
    const result = await collection.find().toArray()
    if (result.length === 0) {
      throw new Error('No documents found')
    }
    return result
  })

  fastify.get('/animals/:animal', async (request, reply) => {
    const result = await collection.findOne({ animal: request.params.animal })
    if (!result) {
      throw new Error('Invalid value')
    }
    return result
  })

  const animalBodyJsonSchema = {
    type: 'object',
    required: ['animal'],
    properties: {
      animal: { type: 'string' },
    },
  }

  const schema = {
    body: animalBodyJsonSchema,
  }

  fastify.post('/animals', { schema }, async (request, reply) => {
    // we can use the `request.body` object to get the data sent by the client
    const result = await collection.insertOne({ animal: request.body.animal })
    return result
  })
}

module.exports = routes
```

Wow, das ging schnell!

Fassen wir zusammen, was wir hier getan haben, denn wir haben einige neue
Konzepte eingeführt.

Wie Sie sehen, haben wir `register` sowohl für den Datenbank-Connector als auch
für die Registrierung der Routen verwendet.

Das ist eine der besten Eigenschaften von Fastify: Es lädt Ihre Plugins in
derselben Reihenfolge, in der Sie sie deklarieren, und es lädt das nächste Plugin
erst, wenn das aktuelle geladen ist. Auf diese Weise können wir den
Datenbank-Connector im ersten Plugin registrieren und im zweiten verwenden
*(lesen Sie [hier](../Reference/Plugins.md#handle-the-scope), um zu verstehen,
wie sich der Scope eines Plugins handhaben lässt)*.

Das Laden der Plugins beginnt, wenn Sie `fastify.listen()`, `fastify.inject()`
oder `fastify.ready()` aufrufen.

Das MongoDB-Plugin verwendet die `decorate`-API, um der Fastify-Instanz eigene
Objekte hinzuzufügen und sie damit überall verfügbar zu machen. Die Verwendung
dieser API wird empfohlen, um einfache Wiederverwendung von Code zu erleichtern
und Code- bzw. Logikduplizierung zu verringern.

Um tiefer zu verstehen, wie Fastify-Plugins funktionieren, wie man neue Plugins
entwickelt und wie man die gesamte Fastify-API nutzt, um die Komplexität des
asynchronen Bootstrappings einer Anwendung zu bewältigen, lesen Sie [the
hitchhiker's guide to plugins](./Plugins-Guide.md).

### Ladereihenfolge Ihrer Plugins
<a id="plugin-loading-order"></a>

Um konsistentes und vorhersagbares Verhalten Ihrer Anwendung zu gewährleisten,
empfehlen wir dringend, Ihren Code stets wie unten gezeigt zu laden:
```
└── plugins (from the Fastify ecosystem)
└── your plugins (your custom plugins)
└── decorators
└── hooks
└── your services
```
Auf diese Weise haben Sie immer Zugriff auf alle im aktuellen Scope deklarierten
Eigenschaften.

Wie zuvor besprochen bietet Fastify ein solides Kapselungsmodell, das Ihnen hilft,
Ihre Anwendung als unabhängige Services aufzubauen. Wenn Sie ein Plugin nur für
eine Teilmenge von Routen registrieren möchten, müssen Sie lediglich die obige
Struktur nachbilden.
```
└── plugins (from the Fastify ecosystem)
└── your plugins (your custom plugins)
└── decorators
└── hooks
└── your services
    │
    └──  service A
    │     └── plugins (from the Fastify ecosystem)
    │     └── your plugins (your custom plugins)
    │     └── decorators
    │     └── hooks
    │     └── your services
    │
    └──  service B
          └── plugins (from the Fastify ecosystem)
          └── your plugins (your custom plugins)
          └── decorators
          └── hooks
          └── your services
```

### Validieren Sie Ihre Daten
<a id="validate-data"></a>

Datenvalidierung ist außerordentlich wichtig und ein zentrales Konzept des
Frameworks.

Zur Validierung eingehender Requests verwendet Fastify [JSON
Schema](https://json-schema.org/).

Sehen wir uns ein Beispiel an, das die Validierung für Routen zeigt:
```js
/**
 * @type {import('fastify').RouteShorthandOptions}
 * @const
 */
const opts = {
  schema: {
    body: {
      type: 'object',
      properties: {
        someKey: { type: 'string' },
        someOtherKey: { type: 'number' }
      }
    }
  }
}

fastify.post('/', opts, async (request, reply) => {
  return { hello: 'world' }
})
```
Dieses Beispiel zeigt, wie man der Route ein Options-Objekt übergibt, das einen
Schlüssel `schema` akzeptiert, der alle Schemas für die Route, `body`,
`querystring`, `params` und `headers` enthält.

Lesen Sie [Validation and
Serialization](../Reference/Validation-and-Serialization.md), um mehr zu erfahren.

### Serialisieren Sie Ihre Daten
<a id="serialize-data"></a>

Fastify bietet erstklassige Unterstützung für JSON. Es ist stark darauf
optimiert, JSON-Bodies zu parsen und JSON-Ausgaben zu serialisieren.

Um die JSON-Serialisierung zu beschleunigen (ja, sie ist langsam!), verwenden Sie
den Schlüssel `response` der Schema-Option wie im folgenden Beispiel:
```js
/**
 * @type {import('fastify').RouteShorthandOptions}
 * @const
 */
const opts = {
  schema: {
    response: {
      200: {
        type: 'object',
        properties: {
          hello: { type: 'string' }
        }
      }
    }
  }
}

fastify.get('/', opts, async (request, reply) => {
  return { hello: 'world' }
})
```
Indem Sie ein Schema wie gezeigt angeben, können Sie die Serialisierung um den
Faktor 2 bis 3 beschleunigen. Das hilft außerdem, das Durchsickern potenziell
sensibler Daten zu verhindern, da Fastify nur die im Response-Schema
enthaltenen Daten serialisiert. Lesen Sie
[Validation and Serialization](../Reference/Validation-and-Serialization.md), um
mehr zu erfahren.

### Request-Payloads parsen
<a id="request-payload"></a>

Fastify parst Request-Payloads mit `'application/json'` und `'text/plain'`
nativ; das Ergebnis ist über das [Fastify-Request-Objekt](../Reference/Request.md)
unter `request.body` zugänglich.

Das folgende Beispiel gibt den geparsten Body eines Requests an den Client zurück:

```js
/**
 * @type {import('fastify').RouteShorthandOptions}
 */
const opts = {}
fastify.post('/', opts, async (request, reply) => {
  return request.body
})
```

Lesen Sie [Content-Type Parser](../Reference/ContentTypeParser.md), um mehr über
die standardmäßige Parsing-Funktionalität von Fastify und die Unterstützung
weiterer Content-Typen zu erfahren.

### Erweitern Sie Ihren Server
<a id="extend-server"></a>

Fastify ist darauf ausgelegt, äußerst erweiterbar und minimal zu sein; wir
glauben, dass ein schlankes Framework alles ist, was nötig ist, um großartige
Anwendungen zu ermöglichen.

Mit anderen Worten: Fastify ist kein "Batteries included"-Framework und setzt auf
ein großartiges [Ökosystem](./Ecosystem.md)!

### Testen Sie Ihren Server
<a id="test-server"></a>

Fastify bietet kein Testframework, wir empfehlen aber eine Vorgehensweise zum
Schreiben Ihrer Tests, die die Funktionen und die Architektur von Fastify nutzt.

Lesen Sie die Dokumentation zum [Testen](./Testing.md), um mehr zu erfahren!

### Ihren Server über die CLI starten
<a id="cli"></a>

Fastify verfügt außerdem über eine CLI-Integration via
[fastify-cli](https://github.com/fastify/fastify-cli),
einem separaten Werkzeug zum Gerüstbau und zur Verwaltung von Fastify-Projekten.

Installieren Sie zunächst `fastify-cli`:

```sh
npm i fastify-cli
```

Sie können es mit `-g` auch global installieren.

Fügen Sie dann die folgenden Zeilen in Ihre `package.json` ein:
```json
{
  "scripts": {
    "start": "fastify start server.js"
  }
}
```

Und legen Sie Ihre Serverdatei(en) an:
```js
// server.js
'use strict'

module.exports = async function (fastify, opts) {
  fastify.get('/', async (request, reply) => {
    return { hello: 'world' }
  })
}
```

Starten Sie Ihren Server anschließend mit:
```bash
npm start
```

### Folien und Videos
<a id="slides"></a>

- Folien
  - [Take your HTTP server to ludicrous
    speed](https://mcollina.github.io/take-your-http-server-to-ludicrous-speed/)
    von [@mcollina](https://github.com/mcollina)
  - [What if I told you that HTTP can be
    fast](https://delvedor.dev/What-if-I-told-you-that-HTTP-can-be-fast/)
    von [@delvedor](https://github.com/delvedor)

- Videos
  - [Take your HTTP server to ludicrous
    speed](https://www.youtube.com/watch?v=5z46jJZNe8k) von
    [@mcollina](https://github.com/mcollina)
  - [What if I told you that HTTP can be
    fast](https://www.webexpo.net/prague2017/talk/what-if-i-told-you-that-http-can-be-fast/)
    von [@delvedor](https://github.com/delvedor)
