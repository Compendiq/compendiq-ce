<h1 align="center">Fastify</h1>

# Verzögerte Annahme von Requests

## Einleitung

Fastify bietet verschiedene [Hooks](../Reference/Hooks.md), die für eine Vielzahl von Situationen nützlich sind. Eine davon ist der [`onReady`](../Reference/Hooks.md#onready) Hook, der nützlich ist, um Aufgaben *gerade bevor* der Server beginnt, neue Requests anzunehmen. Es gibt jedoch keinen direkten Mechanismus, um Szenarien zu behandeln, in denen Sie möchten, dass der Server **bestimmte** Requests annimmt und alle anderen ablehnt, zumindest bis zu einem gewissen Punkt.

Nehmen wir zum Beispiel an, Ihr Server muss sich bei einem OAuth-Provider authentifizieren, um Requests bedienen zu können. Dazu müsste er den [OAuth Authorization Code Flow](https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow) durchführen, was erfordern würde, dass er zwei Requests vom Authentifizierungsanbieter abhört:

1. den Authorization Code Webhook
2. den Tokens Webhook

Bis der Authentifizierungsprozess abgeschlossen ist, können Sie keine Kundenanfragen bedienen. Was tun dann?

Es gibt verschiedene Lösungen für dieses Verhalten. Hier stellen wir eine solche Technik vor und hoffen, dass Sie schnell loslegen können!

## Lösung

### Überblick

Die vorgeschlagene Lösung ist eine von vielen möglichen Arten, mit diesem Szenario und vielen ähnlichen Problemen umzugehen. Sie basiert ausschließlich auf Fastify, sodass keine ausgefallenen Infrastrukturtricks oder Drittanbieterbibliotheken erforderlich sind.

Um die Sache zu vereinfachen, befassen wir uns nicht mit einem präzisen OAuth-Flow, sondern simulieren stattdessen ein Szenario, in dem ein Schlüssel benötigt wird, um einen Request zu bedienen, und dieser Schlüssel kann erst zur Laufzeit durch Authentifizierung bei einem externen Anbieter abgerufen werden.

Das Hauptziel besteht darin, Requests abzulehnen, die ansonsten fehlschlagen würden, und zwar **so früh wie möglich** und mit einem **sinnvollen Kontext**. Das ist sowohl für den Server nützlich (weniger Ressourcen für eine Aufgabe, die scheitern wird) als auch für den Client (er erhält sinnvolle Informationen und muss nicht lange warten).

Dies wird erreicht, indem wir in ein benutzerdefiniertes Plugin zwei Hauptfunktionen einpacken:

1. den Mechanismus zur Authentifizierung beim Anbieter
[Decorating](../Reference/Decorators.md) des `fastify`-Objekts mit dem Authentifizierungsschlüssel (`magicKey` von hier an)
1. den Mechanismus zur Ablehnung von Requests, die ansonsten fehlschlagen würden

### Praxisbeispiel

Für diese Beispielösung verwenden wir Folgendes:

- `node.js v16.14.2`
- `npm 8.5.0`
- `fastify 4.0.0-rc.1`
- `fastify-plugin 3.0.1`
- `undici 5.0.0`

Nehmen wir an, wir haben zunächst diesen Basisserver eingerichtet:
```js
const Fastify = require('fastify')

const provider = require('./provider')

const server = Fastify({ logger: true })
const USUAL_WAIT_TIME_MS = 5000

server.get('/ping', function (request, reply) {
  reply.send({ error: false, ready: request.server.magicKey !== null })
})

server.post('/webhook', function (request, reply) {
  // It's good practice to validate webhook requests come from
  // who you expect. This is skipped in this sample for the sake
  // of simplicity

  const { magicKey } = request.body
  request.server.magicKey = magicKey
  request.log.info('Ready for customer requests!')

  reply.send({ error: false })
})

server.get('/v1*', async function (request, reply) {
  try {
    const data = await provider.fetchSensitiveData(request.server.magicKey)
    return { customer: true, error: false }
  } catch (error) {
    request.log.error({
      error,
      message: 'Failed at fetching sensitive data from provider',
    })

    reply.statusCode = 500
    return { customer: null, error: true }
  }
})

server.decorate('magicKey')

server.listen({ port: '1234' }, () => {
  provider.thirdPartyMagicKeyGenerator(USUAL_WAIT_TIME_MS)
    .catch((error) => {
      server.log.error({
        error,
        message: 'Got an error while trying to get the magic key!'
      })

      // Since we won't be able to serve requests, might as well wrap
      // things up
      server.close(() => process.exit(1))
    })
})
```
Unser Code richtet einfach einen Fastify-Server mit einigen Routen ein:

- eine `/ping`-Route, die angibt, ob der Dienst bereit ist oder nicht, Anfragen zu bedienen, indem sie prüft, ob `magicKey` eingerichtet wurde
- ein `/webhook`-Endpunkt für unseren Anbieter, um uns zu erreichen, wenn er bereit ist, `magicKey` mitzuteilen. Der `magicKey` wird dann in den zuvor auf dem `fastify`-Objekt gesetzten Decorator gespeichert
- eine Catchall-Route `/v1*`, um zu simulieren, was kundeninitiierte Anfragen gewesen wären. Diese Anfragen sind davon abhängig, dass wir einen gültigen `magicKey` haben

Die Datei `provider.js`, die die Aktionen eines externen Anbieters simuliert, lautet wie folgt:
```js
const { fetch } = require('undici')
const { setTimeout } = require('node:timers/promises')

const MAGIC_KEY = '12345'

const delay = setTimeout

exports.thirdPartyMagicKeyGenerator = async (ms) => {
  // Simulate processing delay
  await delay(ms)

  // Simulate webhook request to our server
  const { status } = await fetch(
    'http://localhost:1234/webhook',
    {
      body: JSON.stringify({ magicKey: MAGIC_KEY }),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    },
  )

  if (status !== 200) {
    throw new Error('Failed to fetch magic key')
  }
}

exports.fetchSensitiveData = async (key) => {
  // Simulate processing delay
  await delay(700)
  const data = { sensitive: true }

  if (key === MAGIC_KEY) {
    return data
  }

  throw new Error('Invalid key')
}
```
Der wichtigste Snippet hier ist die Funktion `thirdPartyMagicKeyGenerator`,
die 5 Sekunden warten und dann die POST-Anfrage an unseren `/webhook`-
Endpunkt sendet.

Wenn unser Server hochfährt, beginnen wir, auf neue Verbindungen zu hören, ohne dass
unser `magicKey` eingerichtet ist. Bis wir die Webhook-Anfrage von unserem externen
Provider erhalten (in diesem Beispiel simulieren wir eine 5-sekündige Verzögerung), schlagen alle unsere Anfragen unter dem Pfad `/v1*` (Kundenanfragen) fehl. Schlimmer noch: Sie schlagen fehl, nachdem wir unseren Provider mit einem ungültigen Schlüssel kontaktiert und von ihm eine Fehlermeldung erhalten haben. Das war verschwendete Zeit und Ressourcen für uns und unsere Kunden.
Abhängig von der Art der Anwendung, die wir ausführen, und der erwarteten Anforderungsrate ist diese Verzögerung nicht akzeptabel oder zumindest sehr nervig.

Natürlich könnte dies einfach dadurch gemildert werden, dass wir prüfen, ob der
`magicKey` eingerichtet ist, bevor wir den Provider im `/v1*`-Handler erreichen.
Sicher, aber das würde zu Code-Aufblähung führen. Und stellen Sie sich vor, wir haben Dutzende verschiedener Routen mit verschiedenen Controllern, die diesen Schlüssel benötigen. Sollen wir diese Prüfung wiederholt in alle einbauen? Das ist fehleranfällig, und es gibt elegantere Lösungen.

Was wir tun werden, um dieses Setup insgesamt zu verbessern, ist die Erstellung eines
[`Plugin`](../Reference/Plugins.md), das allein dafür verantwortlich sein wird, dass wir beide:

- keine Anfragen akzeptieren, die ansonsten fehlschlagen würden, bis wir bereit sind
- sicherstellen, dass wir unseren Provider so schnell wie möglich kontaktieren

Auf diese Weise stellen wir sicher, dass unsere gesamte Einrichtung bezüglich dieser spezifischen Geschäftsregel auf eine einzige Entität gelegt wird, anstatt über unsere gesamte Codebasis verstreut zu sein.

Mit den Änderungen zur Verbesserung dieses Verhaltens wird der Code wie folgt aussehen:

##### index.js
```js
const Fastify = require('fastify')

const customerRoutes = require('./customer-routes')
const { setup, delay } = require('./delay-incoming-requests')

const server = new Fastify({ logger: true })

server.register(setup)

// Non-blocked URL
server.get('/ping', function (request, reply) {
  reply.send({ error: false, ready: request.server.magicKey !== null })
})

// Webhook to handle the provider's response - also non-blocked
server.post('/webhook', function (request, reply) {
  // It's good practice to validate webhook requests really come from
  // whoever you expect. This is skipped in this sample for the sake
  // of simplicity

  const { magicKey } = request.body
  request.server.magicKey = magicKey
  request.log.info('Ready for customer requests!')

  reply.send({ error: false })
})

// Blocked URLs
// Mind we're building a new plugin by calling the `delay` factory with our
// customerRoutes plugin
server.register(delay(customerRoutes), { prefix: '/v1' })

server.listen({ port: '1234' })
```
##### provider.js
```js
const { fetch } = require('undici')
const { setTimeout } = require('node:timers/promises')

const MAGIC_KEY = '12345'

const delay = setTimeout

exports.thirdPartyMagicKeyGenerator = async (ms) => {
  // Simulate processing delay
  await delay(ms)

  // Simulate webhook request to our server
  const { status } = await fetch(
    'http://localhost:1234/webhook',
    {
      body: JSON.stringify({ magicKey: MAGIC_KEY }),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    },
  )

  if (status !== 200) {
    throw new Error('Failed to fetch magic key')
  }
}

exports.fetchSensitiveData = async (key) => {
  // Simulate processing delay
  await delay(700)
  const data = { sensitive: true }

  if (key === MAGIC_KEY) {
    return data
  }

  throw new Error('Invalid key')
}
```
##### delay-incoming-requests.js
```js
const fp = require('fastify-plugin')

const provider = require('./provider')

const USUAL_WAIT_TIME_MS = 5000

async function setup(fastify) {
  // As soon as we're listening for requests, let's work our magic
  fastify.server.on('listening', doMagic)

  // Set up the placeholder for the magicKey
  fastify.decorate('magicKey')

  // Our magic -- important to make sure errors are handled. Beware of async
  // functions outside `try/catch` blocks
  // If an error is thrown at this point and not captured it'll crash the
  // application
  function doMagic() {
    fastify.log.info('Doing magic!')

    provider.thirdPartyMagicKeyGenerator(USUAL_WAIT_TIME_MS)
      .catch((error) => {
        fastify.log.error({
          error,
          message: 'Got an error while trying to get the magic key!'
        })

        // Since we won't be able to serve requests, might as well wrap
        // things up
        fastify.close(() => process.exit(1))
      })
  }
}

const delay = (routes) =>
  function (fastify, opts, done) {
    // Make sure customer requests won't be accepted if the magicKey is not
    // available
    fastify.addHook('onRequest', function (request, reply, next) {
      if (!request.server.magicKey) {
        reply.statusCode = 503
        reply.header('Retry-After', USUAL_WAIT_TIME_MS)
        reply.send({ error: true, retryInMs: USUAL_WAIT_TIME_MS })
      }

      next()
    })

    // Register to-be-delayed routes
    fastify.register(routes, opts)

    done()
  }

module.exports = {
  setup: fp(setup),
  delay,
}
```
##### customer-routes.js
```js
const fp = require('fastify-plugin')

const provider = require('./provider')

module.exports = fp(async function (fastify) {
  fastify.get('*', async function (request ,reply) {
    try {
      const data = await provider.fetchSensitiveData(request.server.magicKey)
      return { customer: true, error: false }
    } catch (error) {
      request.log.error({
        error,
        message: 'Failed at fetching sensitive data from provider',
      })

      reply.statusCode = 500
      return { customer: null, error: true }
    }
  })
})
```
Es gibt eine sehr spezifische Änderung an den zuvor existierenden Dateien, die erwähnt werden sollte: Bisher verwendeten wir das `server.listen`-Callback, um den Authentifizierungsprozess mit dem externen Anbieter zu starten, und wir dekorierten das `server`-Objekt direkt vor der Serverinitialisierung. Das hat unser Serverinitialisierungsschema mit unnötigem Code aufgebläht und hatte nicht viel mit dem Start des Fastify-Servers zu tun. Es war eine Geschäftslogik, die keinen spezifischen Platz in der Codebasis hatte.

Jetzt haben wir das `delayIncomingRequests`-Plugin in der Datei `delay-incoming-requests.js` implementiert. Das ist eigentlich ein Modul, das in zwei verschiedene Plugins unterteilt ist und auf einen einzigen Anwendungsfall hinausläuft. Das ist das Gehirn unseres Vorgangs. Lassen Sie uns durchgehen, was die Plugins tun:

##### setup

Das `setup`-Plugin ist dafür verantwortlich sicherzustellen, dass wir so schnell wie möglich unseren Anbieter kontaktieren und den `magicKey` an einem Ort speichern, der allen unseren Handlern zugänglich ist.
```js
  fastify.server.on('listening', doMagic)
```
Sobald der Server beginnt zu lauschen (sehr ähnliches Verhalten wie das Hinzufügen eines Codeabschnitts zur Callback-Funktion von `server.listen`) wird ein `listening`-Ereignis ausgelöst (für weitere Informationen siehe https://nodejs.org/api/net.html#event-listening). Wir nutzen dies, um so schnell wie möglich unseren Provider mit der `doMagic`-Funktion zu kontaktieren.
```js
  fastify.decorate('magicKey')
```
Die `magicKey`-Dekoration ist jetzt auch Teil des Plugins. Wir initialisieren sie mit einem Platzhalter und warten auf den gültigen Wert, bis dieser abgerufen wird.

##### delay

`delay` ist kein Plugin selbst. Es ist eigentlich ein Plugin-*Factory*. Es erwartet ein Fastify-Plugin mit `routes` und exportiert das eigentliche Plugin, das diese Routes mit einem `onRequest`-Hook umhüllt, der sicherstellt, dass keine Anfragen bearbeitet werden, bis wir bereit dafür sind.
```js
const delay = (routes) =>
  function (fastify, opts, done) {
    // Make sure customer requests won't be accepted if the magicKey is not
    // available
    fastify.addHook('onRequest', function (request, reply, next) {
      if (!request.server.magicKey) {
        reply.statusCode = 503
        reply.header('Retry-After', USUAL_WAIT_TIME_MS)
        reply.send({ error: true, retryInMs: USUAL_WAIT_TIME_MS })
      }

      next()
    })

    // Register to-be-delayed routes
    fastify.register(routes, opts)

    done()
  }
```
Anstatt jeden einzelnen Controller zu aktualisieren, der die `magicKey` verwenden könnte, stellen wir einfach sicher, dass keine Route, die Kundenanfragen betrifft, bedient wird, bis wir alles bereit haben. Und es gibt noch mehr: Wir schlagen **SCHNELL** fehl und haben die Möglichkeit, dem Kunden aussagekräftige Informationen zu geben, wie lange er warten sollte, bevor er die Anfrage erneut sendet. Noch weitergehend, indem wir einen [`503` Statuscode](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/503) ausgeben, signalisieren wir unseren Infrastrukturkomponenten (nämlich Load Balancern), dass wir noch nicht bereit sind, eingehende Anfragen entgegenzunehmen, und diese sollten den Verkehr auf andere Instanzen umleiten, falls verfügbar. Zusätzlich stellen wir einen `Retry-After`-Header mit der Zeit in Millisekunden bereit, die der Client warten sollte, bevor er erneut versucht.

Es ist erwähnenswert, dass wir den `fastify-plugin`-Wrapper in der `delay`-Fabrik nicht verwendet haben. Das liegt daran, dass wir wollten, dass der `onRequest`-Hook nur in diesem spezifischen Scope gesetzt wird und nicht im Scope, der ihn aufgerufen hat (in unserem Fall das Hauptobjekt `server`, das in `index.js` definiert ist). `fastify-plugin` setzt die versteckte Eigenschaft `skip-override`, was praktisch dazu führt, dass alle Änderungen, die wir an unserem `fastify`-Objekt vornehmen, für den oberen Scope sichtbar sind. Deshalb haben wir es auch mit dem `customerRoutes`-Plugin verwendet: Wir wollten, dass diese Routen für seinen aufrufenden Scope, das `delay`-Plugin, verfügbar sind. Für weitere Informationen zu diesem Thema siehe [Plugins](../Reference/Plugins.md#handle-the-scope).

Sehen wir uns an, wie sich das in Aktion verhält. Wenn wir unseren Server mit `node index.js` hochgefahren und einige Anfragen gesendet haben, um Dinge zu testen. Dies waren die Protokolle, die wir gesehen hätten (einige Ballast wurde entfernt, um es einfacher zu machen):

<!-- markdownlint-disable -->
```sh
{"time":1650063793316,"msg":"Doing magic!"}
{"time":1650063793316,"msg":"Server listening at http://127.0.0.1:1234"}
{"time":1650063795030,"reqId":"req-1","req":{"method":"GET","url":"/v1","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51928},"msg":"incoming request"}
{"time":1650063795033,"reqId":"req-1","res":{"statusCode":503},"responseTime":2.5721680000424385,"msg":"request completed"}
{"time":1650063796248,"reqId":"req-2","req":{"method":"GET","url":"/ping","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51930},"msg":"incoming request"}
{"time":1650063796248,"reqId":"req-2","res":{"statusCode":200},"responseTime":0.4802369996905327,"msg":"request completed"}
{"time":1650063798377,"reqId":"req-3","req":{"method":"POST","url":"/webhook","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51932},"msg":"incoming request"}
{"time":1650063798379,"reqId":"req-3","msg":"Ready for customer requests!"}
{"time":1650063798379,"reqId":"req-3","res":{"statusCode":200},"responseTime":1.3567829988896847,"msg":"request completed"}
{"time":1650063799858,"reqId":"req-4","req":{"method":"GET","url":"/v1","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51934},"msg":"incoming request"}
{"time":1650063800561,"reqId":"req-4","res":{"statusCode":200},"responseTime":702.4662979990244,"msg":"request completed"}
```
<!-- markdownlint-enable -->

Konzentrieren wir uns auf einige Teile:
```sh
{"time":1650063793316,"msg":"Doing magic!"}
{"time":1650063793316,"msg":"Server listening at http://127.0.0.1:1234"}
```
Dies sind die ersten Logs, die wir sehen würden, sobald der Server gestartet wurde. Wir wenden uns so früh wie möglich an den externen Anbieter innerhalb eines gültigen Zeitfensters (wir konnten dies nicht tun, bevor der Server bereit war, Verbindungen anzunehmen).

Solange der Server noch nicht bereit ist, werden einige Anfragen versucht:
```sh
{"time":1650063795030,"reqId":"req-1","req":{"method":"GET","url":"/v1","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51928},"msg":"incoming request"}
{"time":1650063795033,"reqId":"req-1","res":{"statusCode":503},"responseTime":2.5721680000424385,"msg":"request completed"}
{"time":1650063796248,"reqId":"req-2","req":{"method":"GET","url":"/ping","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51930},"msg":"incoming request"}
{"time":1650063796248,"reqId":"req-2","res":{"statusCode":200},"responseTime":0.4802369996905327,"msg":"request completed"}
```
Der erste (`req-1`) war ein `GET /v1`, der mit unserem Statuscode `503` und den aussagekräftigen Informationen in der Antwort fehlgeschlagen ist. Nachstehend finden Sie die Antwort für diese Anfrage:
```sh
HTTP/1.1 503 Service Unavailable
Connection: keep-alive
Content-Length: 31
Content-Type: application/json; charset=utf-8
Date: Fri, 15 Apr 2022 23:03:15 GMT
Keep-Alive: timeout=5
Retry-After: 5000

{
    "error": true,
    "retryInMs": 5000
}
```
Anschließend versuchten wir eine neue Anfrage (`req-2`), nämlich einen `GET /ping`. Wie erwartet, da dies nicht zu den Anfragen gehörte, die wir unseren Plugin zur Filterung gegeben hatten, war sie erfolgreich. Dies könnte auch als Mittel dienen, einer interessierten Partei mitzuteilen, ob wir bereit waren, Anfragen mit dem Feld `ready` entgegenzunehmen. Obwohl `/ping` eher mit *Liveness*-Checks in Verbindung gebracht wird und dies die Aufgabe eines *Readiness*-Checks wäre. Der neugierige Leser kann mehr über diese Begriffe in dem Artikel erfahren:
["Kubernetes best practices: Setting up health checks with readiness and liveness probes"](
https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-setting-up-health-checks-with-readiness-and-liveness-probes).

Nachstehend finden Sie die Antwort auf diese Anfrage:
```sh
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 29
Content-Type: application/json; charset=utf-8
Date: Fri, 15 Apr 2022 23:03:16 GMT
Keep-Alive: timeout=5

{
    "error": false,
    "ready": false
}
```
Danach gab es noch interessante Log-Nachrichten:

<!-- markdownlint-disable -->
```sh
{"time":1650063798377,"reqId":"req-3","req":{"method":"POST","url":"/webhook","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51932},"msg":"incoming request"}
{"time":1650063798379,"reqId":"req-3","msg":"Ready for customer requests!"}
{"time":1650063798379,"reqId":"req-3","res":{"statusCode":200},"responseTime":1.3567829988896847,"msg":"request completed"}
```
Diesmal war es unser simulierter externer Provider, der uns meldete, dass die Authentifizierung erfolgreich war und uns unseren `magicKey` mitteilte. Wir speicherten diesen in unserem `magicKey`-Decorator und feierten dies mit einer Log-Nachricht, die besagte, dass wir nun bereit seien für Kundenanfragen!
```sh
{"time":1650063799858,"reqId":"req-4","req":{"method":"GET","url":"/v1","hostname":"localhost:1234","remoteAddress":"127.0.0.1","remotePort":51934},"msg":"incoming request"}
{"time":1650063800561,"reqId":"req-4","res":{"statusCode":200},"responseTime":702.4662979990244,"msg":"request completed"}
```
<!-- markdownlint-enable -->

Schließlich wurde eine finale `GET /v1`-Anfrage gesendet und diesmal war sie erfolgreich. Ihre Antwort lautete wie folgt:
```sh
HTTP/1.1 200 OK
Connection: keep-alive
Content-Length: 31
Content-Type: application/json; charset=utf-8
Date: Fri, 15 Apr 2022 23:03:20 GMT
Keep-Alive: timeout=5

{
    "customer": true,
    "error": false
}
```
## Fazit

Die Details der Implementierung werden von Problem zu Problem variieren, aber das Hauptziel dieses Leitfadens war es, einen sehr spezifischen Anwendungsfall für ein Problem zu zeigen, das im Fastify-Ökosystem gelöst werden konnte.

Dieser Leitfaden ist ein Tutorial zur Verwendung von Plugins, Decorators und Hooks, um das Problem zu lösen, bestimmte Anfragen in unserer Anwendung verzögert zu bedienen. Er ist nicht produktionsreif, da er lokalen Zustand (`magicKey`) beibehält und nicht horizontal skalierbar ist (wir wollen unseren Provider doch nicht überfluten, oder?). Eine Möglichkeit zur Verbesserung wäre die Speicherung des `magicKey` an einem anderen Ort (vielleicht in einer Cache-Datenbank?).

Die Schlüsselwörter hier waren [Decorators](../Reference/Decorators.md), [Hooks](../Reference/Hooks.md) und [Plugins](../Reference/Plugins.md). Die Kombination dessen, was Fastify zu bieten hat, kann sehr geniale und kreative Lösungen für eine Vielzahl von Problemen liefern. Lasst uns kreativ sein! :)