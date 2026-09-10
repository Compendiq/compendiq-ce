<h1 align="center">Fastify</h1>

## Hooks

Hooks werden mit der Methode `fastify.addHook` registriert und erlauben es dir,
auf bestimmte Ereignisse in der Anwendung oder im Request-/Response-Lebenszyklus
zu lauschen. Du musst einen Hook registrieren, bevor das Ereignis ausgelöst wird,
sonst geht das Ereignis verloren.

Mit Hooks kannst du direkt mit dem Lebenszyklus von Fastify interagieren. Es gibt
Request-/Reply-Hooks und Anwendungs-Hooks:

- [Request-/Reply-Hooks](#requestreply-hooks)
  - [onRequest](#onrequest)
  - [preParsing](#preparsing)
  - [preValidation](#prevalidation)
  - [preHandler](#prehandler)
  - [preSerialization](#preserialization)
  - [onError](#onerror)
  - [onSend](#onsend)
  - [onResponse](#onresponse)
  - [onTimeout](#ontimeout)
  - [onRequestAbort](#onrequestabort)
  - [Fehler aus einem Hook behandeln](#manage-errors-from-a-hook)
  - [Aus einem Hook auf einen Request antworten](#respond-to-a-request-from-a-hook)
- [Anwendungs-Hooks](#application-hooks)
  - [onReady](#onready)
  - [onListen](#onlisten)
  - [onClose](#onclose)
  - [preClose](#preclose)
  - [onRoute](#onroute)
  - [onRegister](#onregister)
- [Geltungsbereich](#scope)
- [Hooks auf Routen-Ebene](#route-level-hooks)
- [Hooks nutzen, um eigene Eigenschaften einzuschleusen](#using-hooks-to-inject-custom-properties)
- [Diagnostics-Channel-Hooks](#diagnostics-channel-hooks)

> ℹ️ Hinweis:
> Der `done`-Callback steht nicht zur Verfügung, wenn `async`/`await` verwendet
> oder ein `Promise` zurückgegeben wird. Wenn du in dieser Situation dennoch einen
> `done`-Callback aufrufst, kann unerwartetes Verhalten auftreten, z. B. das
> doppelte Aufrufen von Handlern.

## Request-/Reply-Hooks

[Request](./Request.md) und [Reply](./Reply.md) sind die zentralen Fastify-Objekte.

`done` ist die Funktion, mit der der [Lebenszyklus](./Lifecycle.md) fortgesetzt wird.

Wo jeder Hook ausgeführt wird, lässt sich leicht anhand der
[Lebenszyklus-Seite](./Lifecycle.md) nachvollziehen.

Hooks sind von der Kapselung in Fastify betroffen und können daher auf
ausgewählte Routen angewendet werden. Weitere Informationen findest du im
Abschnitt [Geltungsbereiche](#scope).

Es gibt zehn verschiedene Hooks, die du in Request/Reply verwenden kannst *(in
Ausführungsreihenfolge)*:

### onRequest
```js
fastify.addHook('onRequest', (request, reply, done) => {
  // Some code
  done()
})
```
Oder mit `async/await`:
```js
fastify.addHook('onRequest', async (request, reply) => {
  // Some code
  await asyncMethod()
})
```

> ℹ️ Hinweis:
> Im Hook [onRequest](#onrequest) ist `request.body` immer
> `undefined`, weil das Parsen des Bodys vor dem Hook
> [preValidation](#prevalidation) stattfindet.

### preParsing

Wenn du den Hook `preParsing` verwendest, kannst du den Payload-Stream des
Requests transformieren, bevor er geparst wird. Er erhält wie andere Hooks die
Request- und Reply-Objekte sowie einen Stream mit dem aktuellen Request-Payload.

Gibt er einen Wert zurück (per `return` oder über die Callback-Funktion), muss
dieser ein Stream sein.

Du kannst zum Beispiel den Request-Body dekomprimieren:

```js
fastify.addHook('preParsing', (request, reply, payload, done) => {
  // Some code
  done(null, newPayload)
})
```
Oder mit `async/await`:
```js
fastify.addHook('preParsing', async (request, reply, payload) => {
  // Some code
  await asyncMethod()
  return newPayload
})
```

> ℹ️ Hinweis:
> Im Hook [preParsing](#preparsing) ist `request.body` immer
> `undefined`, weil das Parsen des Bodys vor dem Hook
> [preValidation](#prevalidation) stattfindet.

> ℹ️ Hinweis:
> Du solltest dem zurückgegebenen Stream außerdem eine Eigenschaft
> `receivedEncodedLength` hinzufügen. Diese Eigenschaft wird verwendet, um den
> Request-Payload korrekt mit dem Wert des `Content-Length`-Headers abzugleichen.
> Idealerweise sollte sie bei jedem empfangenen Chunk aktualisiert werden.

> ℹ️ Hinweis:
> Die Größe des zurückgegebenen Streams wird daraufhin geprüft, dass sie das in
> der Option [`bodyLimit`](./Server.md#bodylimit) gesetzte Limit nicht überschreitet.

### preValidation

Wenn du den Hook `preValidation` verwendest, kannst du den Payload ändern, bevor
er validiert wird. Zum Beispiel:

```js
fastify.addHook('preValidation', (request, reply, done) => {
  request.body = { ...request.body, importantKey: 'randomString' }
  done()
})
```
Oder mit `async/await`:
```js
fastify.addHook('preValidation', async (request, reply) => {
  const importantKey = await generateRandomString()
  request.body = { ...request.body, importantKey }
})
```

### preHandler

Der Hook `preHandler` erlaubt es dir, eine Funktion anzugeben, die vor dem
Handler einer Route ausgeführt wird.

```js
fastify.addHook('preHandler', (request, reply, done) => {
  // some code
  done()
})
```
Oder mit `async/await`:
```js
fastify.addHook('preHandler', async (request, reply) => {
  // Some code
  await asyncMethod()
})
```
### preSerialization

Wenn du den Hook `preSerialization` verwendest, kannst du den Payload ändern
(oder ersetzen), bevor er serialisiert wird. Zum Beispiel:

```js
fastify.addHook('preSerialization', (request, reply, payload, done) => {
  const err = null
  const newPayload = { wrapped: payload }
  done(err, newPayload)
})
```
Oder mit `async/await`:
```js
fastify.addHook('preSerialization', async (request, reply, payload) => {
  return { wrapped: payload }
})
```

> ℹ️ Hinweis:
> Der Hook wird NICHT aufgerufen, wenn der Payload ein `string`, ein `Buffer`,
> ein `stream` oder `null` ist.

### onError
```js
fastify.addHook('onError', (request, reply, error, done) => {
  // Some code
  done()
})
```
Oder mit `async/await`:
```js
fastify.addHook('onError', async (request, reply, error) => {
  // Useful for custom error logging
  // You should not use this hook to update the error
})
```
Dieser Hook ist nützlich, wenn du eigenes Fehler-Logging betreiben oder im
Fehlerfall einen bestimmten Header setzen musst.

Er ist nicht dazu gedacht, den Fehler zu verändern, und ein Aufruf von
`reply.send` wirft eine Exception.

Dieser Hook wird vor dem
[per `setErrorHandler` gesetzten eigenen Error-Handler](./Server.md#seterrorhandler)
ausgeführt.

> ℹ️ Hinweis:
> Anders als bei den übrigen Hooks wird das Übergeben eines Fehlers an die
> `done`-Funktion nicht unterstützt.

### onSend
Wenn du den Hook `onSend` verwendest, kannst du den Payload ändern. Zum Beispiel:

```js
fastify.addHook('onSend', (request, reply, payload, done) => {
  const err = null;
  const newPayload = payload.replace('some-text', 'some-new-text')
  done(err, newPayload)
})
```
Oder mit `async/await`:
```js
fastify.addHook('onSend', async (request, reply, payload) => {
  const newPayload = payload.replace('some-text', 'some-new-text')
  return newPayload
})
```

Du kannst den Payload auch leeren, um eine Antwort mit leerem Body zu senden,
indem du den Payload durch `null` ersetzt:

```js
fastify.addHook('onSend', (request, reply, payload, done) => {
  reply.code(304)
  const newPayload = null
  done(null, newPayload)
})
```

> Du kannst einen leeren Body auch senden, indem du den Payload durch die leere
> Zeichenkette `''` ersetzt. Beachte aber, dass dadurch der `Content-Length`-Header
> auf `0` gesetzt wird, während der `Content-Length`-Header nicht gesetzt wird,
> wenn der Payload `null` ist.

> ℹ️ Hinweis:
> Wenn du den Payload änderst, darfst du ihn nur in einen `string`, einen
> `Buffer`, einen `stream`, einen `ReadableStream`, eine `Response` oder `null` ändern.


### onResponse
```js
fastify.addHook('onResponse', (request, reply, done) => {
  // Some code
  done()
})
```
Oder mit `async/await`:
```js
fastify.addHook('onResponse', async (request, reply) => {
  // Some code
  await asyncMethod()
})
```

Der Hook `onResponse` wird ausgeführt, wenn eine Antwort bereits gesendet wurde,
du kannst also keine weiteren Daten mehr an den Client senden. Er kann jedoch
nützlich sein, um Daten an externe Dienste zu schicken, etwa um Statistiken zu
sammeln.

> ℹ️ Hinweis:
> `disableRequestLogging` auf `true` zu setzen, deaktiviert jegliches Fehler-Log
> innerhalb des `onResponse`-Hooks. Verwende in diesem Fall `try - catch`, um
> Fehler zu protokollieren.

### onTimeout

```js
fastify.addHook('onTimeout', (request, reply, done) => {
  // Some code
  done()
})
```
Oder mit `async/await`:
```js
fastify.addHook('onTimeout', async (request, reply) => {
  // Some code
  await asyncMethod()
})
```
`onTimeout` ist nützlich, wenn du in deinem Dienst überwachen musst, ob ein
Request in ein Timeout gelaufen ist (sofern die Eigenschaft `connectionTimeout`
auf der Fastify-Instanz gesetzt ist). Der Hook `onTimeout` wird ausgeführt, wenn
ein Request in ein Timeout läuft und der HTTP-Socket getrennt wurde. Daher kannst
du keine Daten mehr an den Client senden.

> ℹ️ Hinweis:
> Der Hook `onTimeout` wird durch Timeouts auf Socket-Ebene ausgelöst, die über
> `connectionTimeout` gesetzt werden. Für Timeouts pro Route auf Anwendungsebene
> siehe die Option [`handlerTimeout`](./Server.md#factory-handler-timeout), die
> `request.signal` für kooperatives Abbrechen verwendet.

### onRequestAbort

```js
fastify.addHook('onRequestAbort', (request, done) => {
  // Some code
  done()
})
```
Oder mit `async/await`:
```js
fastify.addHook('onRequestAbort', async (request) => {
  // Some code
  await asyncMethod()
})
```
Der Hook `onRequestAbort` wird ausgeführt, wenn ein Client die Verbindung
schließt, bevor der gesamte Request verarbeitet wurde. Daher kannst du keine
Daten mehr an den Client senden.

> ℹ️ Hinweis:
> Die Erkennung eines Client-Abbruchs ist nicht vollständig zuverlässig.
> Siehe: [`Detecting-When-Clients-Abort.md`](../Guides/Detecting-When-Clients-Abort.md)

### Fehler aus einem Hook behandeln
Wenn während der Ausführung deines Hooks ein Fehler auftritt, übergib ihn einfach
an `done()`, und Fastify schließt den Request automatisch und sendet den
passenden Fehlercode an den Benutzer.

```js
fastify.addHook('onRequest', (request, reply, done) => {
  done(new Error('Some error'))
})
```

Wenn du dem Benutzer einen eigenen Fehlercode übergeben möchtest, verwende
einfach `reply.code()`:
```js
fastify.addHook('preHandler', (request, reply, done) => {
  reply.code(400)
  done(new Error('Some error'))
})
```
*Der Fehler wird von [`Reply`](./Reply.md#errors) behandelt.*

Oder wenn du `async/await` verwendest, kannst du einfach einen Fehler werfen:
```js
fastify.addHook('onRequest', async (request, reply) => {
  throw new Error('Some error')
})
```

### Aus einem Hook auf einen Request antworten

Bei Bedarf kannst du auf einen Request antworten, bevor du den Routen-Handler
erreichst, etwa bei der Implementierung eines Authentifizierungs-Hooks. Aus einem
Hook zu antworten bedeutet, dass die Hook-Kette __gestoppt__ wird und die
übrigen Hooks und Handler nicht ausgeführt werden. Wenn der Hook den
Callback-Ansatz verwendet, also keine `async`-Funktion ist und kein `Promise`
zurückgibt, genügt es, `reply.send()` aufzurufen und den Callback nicht
aufzurufen. Ist der Hook `async`, __muss__ `reply.send()` aufgerufen werden,
_bevor_ die Funktion zurückkehrt oder das Promise sich auflöst, andernfalls läuft
der Request weiter. Wird `reply.send()` außerhalb der Promise-Kette aufgerufen,
ist es wichtig, `return reply` zu schreiben, sonst wird der Request zweimal
ausgeführt.

Es ist wichtig, __Callbacks und `async`/`Promise` nicht zu mischen__, sonst wird
die Hook-Kette zweimal ausgeführt.

Wenn du `onRequest` oder `preHandler` verwendest, nutze `reply.send`.

```js
fastify.addHook('onRequest', (request, reply, done) => {
  reply.send('Early response')
})

// Works with async functions too
fastify.addHook('preHandler', async (request, reply) => {
  setTimeout(() => {
    reply.send({ hello: 'from prehandler' })
  })
  return reply // mandatory, so the request is not executed further
// Commenting the line above will allow the hooks to continue and fail with FST_ERR_REP_ALREADY_SENT
})
```

Wenn du mit einem Stream antworten möchtest, solltest du für den Hook keine
`async`-Funktion verwenden. Musst du eine `async`-Funktion verwenden, muss dein
Code dem Muster in
[test/hooks-async.js](https://github.com/fastify/fastify/blob/94ea67ef2d8dce8a955d510cd9081aabd036fa85/test/hooks-async.js#L269-L275)
folgen.

```js
fastify.addHook('onRequest', (request, reply, done) => {
  const stream = fs.createReadStream('some-file', 'utf8')
  reply.send(stream)
})
```

Wenn du eine Antwort sendest, ohne sie mit `await` abzuwarten, achte darauf,
immer `return reply` zu schreiben:

```js
fastify.addHook('preHandler', async (request, reply) => {
  setImmediate(() => { reply.send('hello') })

  // This is needed to signal the handler to wait for a response
  // to be sent outside of the promise chain
  return reply
})

fastify.addHook('preHandler', async (request, reply) => {
  // the @fastify/static plugin will send a file asynchronously,
  // so we should return reply
  reply.sendFile('myfile')
  return reply
})
```

## Anwendungs-Hooks

Du kannst dich auch in den Lebenszyklus der Anwendung einklinken.

- [onReady](#onready)
- [onListen](#onlisten)
- [onClose](#onclose)
- [preClose](#preclose)
- [onRoute](#onroute)
- [onRegister](#onregister)

### onReady
Wird ausgelöst, bevor der Server beginnt, auf Requests zu lauschen, und wenn
`.ready()` aufgerufen wird. Er kann die Routen nicht ändern und keine neuen Hooks
hinzufügen. Registrierte Hook-Funktionen werden nacheinander ausgeführt. Erst
wenn alle `onReady`-Hook-Funktionen abgeschlossen sind, beginnt der Server, auf
Requests zu lauschen. Hook-Funktionen akzeptieren ein Argument: einen Callback,
`done`, der aufgerufen wird, nachdem die Hook-Funktion abgeschlossen ist.
Hook-Funktionen werden mit `this` gebunden an die zugehörige Fastify-Instanz
aufgerufen.

```js
// callback style
fastify.addHook('onReady', function (done) {
  // Some code
  const err = null;
  done(err)
})

// or async/await style
fastify.addHook('onReady', async function () {
  // Some async code
  await loadCacheFromDatabase()
})
```

### onListen

Wird ausgelöst, wenn der Server beginnt, auf Requests zu lauschen. Die Hooks
laufen nacheinander. Verursacht eine Hook-Funktion einen Fehler, wird er
protokolliert und ignoriert, sodass die Warteschlange der Hooks fortgesetzt wird.
Hook-Funktionen akzeptieren ein Argument: einen Callback, `done`, der aufgerufen
wird, nachdem die Hook-Funktion abgeschlossen ist. Hook-Funktionen werden mit
`this` gebunden an die zugehörige Fastify-Instanz aufgerufen.

Dies ist eine Alternative zu `fastify.server.on('listening', () => {})`.

```js
// callback style
fastify.addHook('onListen', function (done) {
  // Some code
  const err = null;
  done(err)
})

// or async/await style
fastify.addHook('onListen', async function () {
  // Some async code
})
```

> ℹ️ Hinweis:
> Dieser Hook läuft nicht, wenn der Server über `fastify.inject()` oder
> `fastify.ready()` gestartet wird.

### onClose
<a id="on-close"></a>

Wird ausgelöst, wenn `fastify.close()` aufgerufen wird, um den Server zu stoppen.
Zu dem Zeitpunkt, an dem die `onClose`-Hooks ausgeführt werden, hat der
HTTP-Server bereits aufgehört zu lauschen, alle laufenden HTTP-Requests sind
abgeschlossen und die Verbindungen wurden geleert. Damit ist `onClose` der
sichere Ort für [Plugins](./Plugins.md), um Ressourcen wie
Datenbank-Verbindungspools freizugeben, denn es treffen keine neuen Requests mehr
ein.

Die Hook-Funktion erhält die Fastify-Instanz als erstes Argument und für
synchrone Hook-Funktionen einen `done`-Callback.
```js
// callback style
fastify.addHook('onClose', (instance, done) => {
  // Some code
  done()
})

// or async/await style
fastify.addHook('onClose', async (instance) => {
  // Some async code
  await closeDatabaseConnections()
})
```

#### Ausführungsreihenfolge

Wenn mehrere `onClose`-Hooks über Plugins hinweg registriert sind, werden die
Hooks von Kind-Plugins vor denen der Eltern-Plugins ausgeführt. Das bedeutet, der
`onClose`-Hook eines Datenbank-Plugins läuft vor den `onClose`-Hooks auf
Root-Ebene:

```js
fastify.register(function dbPlugin (instance, opts, done) {
  instance.addHook('onClose', async (instance) => {
    // Runs first — close the database pool
    await instance.db.close()
  })
  done()
})

fastify.addHook('onClose', async (instance) => {
  // Runs second — after child plugins have cleaned up
})
```

Den vollständigen Shutdown-Lebenszyklus findest du unter [`close`](./Server.md#close).

### preClose
<a id="pre-close"></a>

Wird ausgelöst, wenn `fastify.close()` aufgerufen wird, um den Server zu stoppen.
Zu diesem Zeitpunkt weist der Server neue Requests bereits mit `503` ab (sofern
[`return503OnClosing`](./Server.md#factory-return-503-on-closing) `true` ist),
aber der HTTP-Server hat noch nicht aufgehört zu lauschen und laufende Requests
werden noch verarbeitet.

Er ist nützlich, wenn [Plugins](./Plugins.md) Zustand am HTTP-Server aufgebaut
haben, der das Schließen des Servers verhindern würde, etwa offene
WebSocket-Verbindungen oder Server-Sent-Events-Streams, die explizit beendet
werden müssen, damit `server.close()` abschließen kann.
_Du wirst diesen Hook vermutlich nicht brauchen_;
verwende für den häufigsten Fall [`onClose`](#onclose).

```js
// callback style
fastify.addHook('preClose', (done) => {
  // Some code
  done()
})

// or async/await style
fastify.addHook('preClose', async () => {
  // Some async code
  await removeSomeServerState()
})
```

Zum Beispiel das Schließen von WebSocket-Verbindungen während des Shutdowns:

```js
fastify.addHook('preClose', async () => {
  // Close all WebSocket connections so that server.close() can complete.
  // Without this, open connections would keep the server alive.
  for (const ws of activeWebSockets) {
    ws.close(1001, 'Server shutting down')
  }
})
```

### onRoute
<a id="on-route"></a>

Wird ausgelöst, wenn eine neue Route registriert wird. Den Listenern wird ein
[`routeOptions`](./Routes.md#routes-options)-Objekt als einziger Parameter
übergeben. Die Schnittstelle ist synchron, den Listenern wird daher kein Callback
übergeben. Dieser Hook ist gekapselt.

```js
fastify.addHook('onRoute', (routeOptions) => {
  //Some code
  routeOptions.method
  routeOptions.schema
  routeOptions.url // the complete URL of the route, it will include the prefix if any
  routeOptions.path // `url` alias
  routeOptions.routePath // the URL of the route without the prefix
  routeOptions.bodyLimit
  routeOptions.logLevel
  routeOptions.logSerializers
  routeOptions.prefix
})
```

Wenn du ein Plugin schreibst und Anwendungsrouten anpassen musst, etwa die
Optionen ändern oder neue Routen-Hooks hinzufügen, ist das der richtige Ort.

```js
fastify.addHook('onRoute', (routeOptions) => {
  function onPreSerialization(request, reply, payload, done) {
    // Your code
    done(null, payload)
  }
  // preSerialization can be an array or undefined
  routeOptions.preSerialization = [...(routeOptions.preSerialization || []), onPreSerialization]
})
```

Um innerhalb eines onRoute-Hooks weitere Routen hinzuzufügen, müssen die Routen
korrekt markiert werden. Ohne Markierung läuft der Hook in eine Endlosschleife.
Der empfohlene Ansatz ist unten gezeigt.

```js
const kRouteAlreadyProcessed = Symbol('route-already-processed')

fastify.addHook('onRoute', function (routeOptions) {
  const { url, method } = routeOptions

  const isAlreadyProcessed = (routeOptions.custom && routeOptions.custom[kRouteAlreadyProcessed]) || false

  if (!isAlreadyProcessed) {
    this.route({
      url,
      method,
      custom: {
        [kRouteAlreadyProcessed]: true
      },
      handler: () => {}
    })
  }
})
```

Weitere Details findest du in diesem [Issue](https://github.com/fastify/fastify/issues/4319).

### onRegister
<a id="on-register"></a>

Wird ausgelöst, wenn ein neues Plugin registriert und ein neuer
Kapselungskontext erzeugt wird. Der Hook wird **vor** dem registrierten Code
ausgeführt.

Dieser Hook kann nützlich sein, wenn du ein Plugin entwickelst, das wissen muss,
wann ein Plugin-Kontext gebildet wird, und du in genau diesem Kontext arbeiten
möchtest — dieser Hook ist daher gekapselt.

> ℹ️ Hinweis:
> Dieser Hook wird nicht aufgerufen, wenn ein Plugin in
> [`fastify-plugin`](https://github.com/fastify/fastify-plugin) eingehüllt ist.
```js
fastify.decorate('data', [])

fastify.register(async (instance, opts) => {
  instance.data.push('hello')
  console.log(instance.data) // ['hello']

  instance.register(async (instance, opts) => {
    instance.data.push('world')
    console.log(instance.data) // ['hello', 'world']
  }, { prefix: '/hola' })
}, { prefix: '/ciao' })

fastify.register(async (instance, opts) => {
  console.log(instance.data) // []
}, { prefix: '/hello' })

fastify.addHook('onRegister', (instance, opts) => {
  // Create a new array from the old one
  // but without keeping the reference
  // allowing the user to have encapsulated
  // instances of the `data` property
  instance.data = instance.data.slice()

  // the options of the new registered instance
  console.log(opts.prefix)
})
```

## Geltungsbereich
<a id="scope"></a>

Mit Ausnahme von [onClose](#onclose) sind alle Hooks gekapselt. Das bedeutet, du
kannst mit `register` entscheiden, wo deine Hooks laufen sollen, wie im
[Plugin-Leitfaden](../Guides/Plugins-Guide.md) erklärt. Wenn du eine Funktion
übergibst, wird diese Funktion an den richtigen Fastify-Kontext gebunden, und von
dort hast du vollen Zugriff auf die Fastify-API.

```js
fastify.addHook('onRequest', function (request, reply, done) {
  const self = this // Fastify context
  done()
})
```

Beachte, dass der Fastify-Kontext in jedem Hook derselbe ist wie der des Plugins,
in dem die Route registriert wurde, zum Beispiel:

```js
fastify.addHook('onRequest', async function (req, reply) {
  if (req.raw.url === '/nested') {
    assert.strictEqual(this.foo, 'bar')
  } else {
    assert.strictEqual(this.foo, undefined)
  }
})

fastify.get('/', async function (req, reply) {
  assert.strictEqual(this.foo, undefined)
  return { hello: 'world' }
})

fastify.register(async function plugin (fastify, opts) {
  fastify.decorate('foo', 'bar')

  fastify.get('/nested', async function (req, reply) {
    assert.strictEqual(this.foo, 'bar')
    return { hello: 'world' }
  })
})
```

Achtung: Wenn du die Funktion als [Pfeilfunktion](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/Arrow_functions)
deklarierst, ist `this` nicht Fastify, sondern das `this` des aktuellen
Geltungsbereichs.


## Hooks auf Routen-Ebene
<a id="route-hooks"></a>

Du kannst einen oder mehrere eigene Lebenszyklus-Hooks ([onRequest](#onrequest),
[onResponse](#onresponse), [preParsing](#preparsing),
[preValidation](#prevalidation), [preHandler](#prehandler),
[preSerialization](#preserialization), [onSend](#onsend),
[onTimeout](#ontimeout) und [onError](#onerror)) deklarieren, die
**ausschließlich** für die Route gelten. Tust du das, werden diese Hooks immer
als letzte Hooks ihrer Kategorie ausgeführt.

Das kann nützlich sein, wenn du eine Authentifizierung implementieren musst, wo
die Hooks [preParsing](#preparsing) oder [preValidation](#prevalidation) genau
das sind, was du brauchst. Mehrere Hooks auf Routen-Ebene können auch als Array
angegeben werden.

```js
fastify.addHook('onRequest', (request, reply, done) => {
  // Your code
  done()
})

fastify.addHook('onResponse', (request, reply, done) => {
  // your code
  done()
})

fastify.addHook('preParsing', (request, reply, payload, done) => {
  // Your code
  done(null, payload)
})

fastify.addHook('preValidation', (request, reply, done) => {
  // Your code
  done()
})

fastify.addHook('preHandler', (request, reply, done) => {
  // Your code
  done()
})

fastify.addHook('preSerialization', (request, reply, payload, done) => {
  // Your code
  done(null, payload)
})

fastify.addHook('onSend', (request, reply, payload, done) => {
  // Your code
  done(null, payload)
})

fastify.addHook('onTimeout', (request, reply, done) => {
  // Your code
  done()
})

fastify.addHook('onError', (request, reply, error, done) => {
  // Your code
  done()
})

fastify.route({
  method: 'GET',
  url: '/',
  schema: { ... },
  onRequest: function (request, reply, done) {
    // This hook will always be executed after the shared `onRequest` hooks
    done()
  },
  // // Example with an async hook. All hooks support this syntax
  //
  // onRequest: async function (request, reply) {
  //  // This hook will always be executed after the shared `onRequest` hooks
  //  await ...
  // }
  onResponse: function (request, reply, done) {
    // this hook will always be executed after the shared `onResponse` hooks
    done()
  },
  preParsing: function (request, reply, payload, done) {
    // This hook will always be executed after the shared `preParsing` hooks
    done(null, payload)
  },
  preValidation: function (request, reply, done) {
    // This hook will always be executed after the shared `preValidation` hooks
    done()
  },
  preHandler: function (request, reply, done) {
    // This hook will always be executed after the shared `preHandler` hooks
    done()
  },
  // // Example with an array. All hooks support this syntax.
  //
  // preHandler: [function (request, reply, done) {
  //   // This hook will always be executed after the shared `preHandler` hooks
  //   done()
  // }],
  preSerialization: (request, reply, payload, done) => {
    // This hook will always be executed after the shared `preSerialization` hooks
    done(null, payload)
  },
  onSend: (request, reply, payload, done) => {
    // This hook will always be executed after the shared `onSend` hooks
    done(null, payload)
  },
  onTimeout: (request, reply, done) => {
    // This hook will always be executed after the shared `onTimeout` hooks
    done()
  },
  onError: (request, reply, error, done) => {
    // This hook will always be executed after the shared `onError` hooks
    done()
  },
  handler: function (request, reply) {
    reply.send({ hello: 'world' })
  }
})
```

> ℹ️ Hinweis:
> Beide Optionen akzeptieren außerdem ein Array von Funktionen.

## Hooks nutzen, um eigene Eigenschaften einzuschleusen
<a id="using-hooks-to-inject-custom-properties"></a>

Du kannst einen Hook verwenden, um eigene Eigenschaften in eingehende Requests
einzuschleusen. Das ist nützlich, um in Hooks verarbeitete Daten in Controllern
wiederzuverwenden.

Ein sehr häufiger Anwendungsfall ist zum Beispiel, die Authentifizierung eines
Benutzers anhand seines Tokens zu prüfen und die ermittelten Daten dann in der
[Request](./Request.md)-Instanz abzulegen. So können deine Controller sie leicht
über `request.authenticatedUser` oder wie auch immer du es nennen willst lesen.
So könnte das aussehen:

```js
fastify.addHook('preParsing', async (request) => {
  request.authenticatedUser = {
    id: 42,
    name: 'Jane Doe',
    role: 'admin'
  }
})

fastify.get('/me/is-admin', async function (req, reply) {
  return { isAdmin: req.authenticatedUser?.role === 'admin' || false }
})
```

Beachte, dass `.authenticatedUser` tatsächlich ein beliebiger, von dir gewählter
Eigenschaftsname sein könnte. Eine eigene Eigenschaft zu verwenden, verhindert,
dass du bestehende Eigenschaften mutierst, was eine gefährliche und destruktive
Operation wäre. Sei also vorsichtig und stelle sicher, dass deine Eigenschaft
vollkommen neu ist; verwende diesen Ansatz außerdem nur für sehr spezifische und
kleine Fälle wie in diesem Beispiel.

Was TypeScript in diesem Beispiel betrifft, müsstest du das Kern-Interface
`FastifyRequest` erweitern, um die Typisierung deiner neuen Eigenschaft
einzuschließen (mehr dazu auf der Seite [TypeScript](./TypeScript.md)), etwa so:

```ts
interface AuthenticatedUser { /* ... */ }

declare module 'fastify' {
  export interface FastifyRequest {
    authenticatedUser?: AuthenticatedUser;
  }
}
```

Auch wenn dies ein sehr pragmatischer Ansatz ist: Wenn du etwas Komplexeres
vorhast, das diese Kernobjekte verändert, erwäge stattdessen, ein eigenes
[Plugin](./Plugins.md) zu erstellen.

## Diagnostics-Channel-Hooks

Ein Publish-Event von [`diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html),
`'fastify.initialization'`, tritt zur Initialisierungszeit auf. Die
Fastify-Instanz wird dem Hook als Eigenschaft des übergebenen Objekts
mitgegeben. Zu diesem Zeitpunkt kann mit der Instanz interagiert werden, um
Hooks, Plugins, Routen oder beliebige andere Änderungen hinzuzufügen.

Ein Tracing-Paket könnte zum Beispiel etwas wie das Folgende tun (was natürlich
eine Vereinfachung ist). Das stünde in einer Datei, die bei der Initialisierung
des Tracking-Pakets geladen wird, ganz im üblichen Stil "Instrumentierungswerkzeuge
zuerst laden".

```js
const tracer = /* retrieved from elsewhere in the package */
const dc = require('node:diagnostics_channel')
const channel = dc.channel('fastify.initialization')
const spans = new WeakMap()

channel.subscribe(function ({ fastify }) {
  fastify.addHook('onRequest', (request, reply, done) => {
    const span = tracer.startSpan('fastify.request.handler')
    spans.set(request, span)
    done()
  })

  fastify.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request)
    span.finish()
    done()
  })
})
```

> ℹ️ Hinweis:
> Die API der Klasse TracingChannel ist derzeit experimentell und kann selbst in
> semver-Patch-Releases von Node.js Breaking Changes erfahren.

Fünf weitere Events werden pro Request veröffentlicht und folgen der Nomenklatur
des [Tracing Channel](https://nodejs.org/api/diagnostics_channel.html#class-tracingchannel).
Die Liste der Channel-Namen und der jeweils empfangenen Events lautet:

- `tracing:fastify.request.handler:start`: Wird immer ausgelöst
  - `{ request: Request, reply: Reply, route: { url, method } }`
- `tracing:fastify.request.handler:end`: Wird immer ausgelöst
  - `{ request: Request, reply: Reply, route: { url, method }, async: Bool }`
- `tracing:fastify.request.handler:asyncStart`: Wird bei Promise-/Async-Handlern ausgelöst
  - `{ request: Request, reply: Reply, route: { url, method } }`
- `tracing:fastify.request.handler:asyncEnd`: Wird bei Promise-/Async-Handlern ausgelöst
  - `{ request: Request, reply: Reply, route: { url, method } }`
- `tracing:fastify.request.handler:error`: Wird ausgelöst, wenn ein Fehler auftritt
  - `{ request: Request, reply: Reply, route: { url, method }, error: Error }`

Die Objektinstanz bleibt für alle Events eines gegebenen Requests dieselbe. Alle
Payloads enthalten eine `request`- und eine `reply`-Eigenschaft, die Instanzen
der Fastify-Objekte `Request` und `Reply` sind. Sie enthalten außerdem eine
`route`-Eigenschaft, ein Objekt mit dem getroffenen `url`-Muster (z. B.
`/collection/:id`) und der HTTP-Methode `method` (z. B. `GET`). Die Events
`:start` und `:end` werden für Requests immer ausgelöst. Ist ein Request-Handler
eine `async`-Funktion oder gibt er ein `Promise` zurück, werden zusätzlich die
Events `:asyncStart` und `:asyncEnd` ausgelöst. Schließlich enthält das Event
`:error` eine `error`-Eigenschaft, die dem Fehlschlag des Requests zugeordnet ist.

Diese Events lassen sich so empfangen:

```js
const dc = require('node:diagnostics_channel')
const channel = dc.channel('tracing:fastify.request.handler:start')
channel.subscribe((msg) => {
  console.log(msg.request, msg.reply)
})
```
