<h1 align="center">Fastify</h1>

## Routes

Die Route-Methoden konfigurieren die Endpunkte der Anwendung. Routen lassen sich
über die Kurzform oder die vollständige Deklaration deklarieren.

- [Vollständige Deklaration](#full-declaration)
- [Routen-Optionen](#routes-options)
- [Kurzform-Deklaration](#shorthand-declaration)
- [URL-Aufbau](#url-building)
- [Async Await](#async-await)
- [Promise-Auflösung](#promise-resolution)
- [Routen-Präfixe](#route-prefixing)
  - [Behandlung der Route / in präfixierten
    Plugins](#handling-of--route-inside-prefixed-plugins)
- [Eigener Log-Level](#custom-log-level)
- [Eigener Log-Serializer](#custom-log-serializer)
- [Config](#config)
- [Constraints](#constraints)
  - [Version-Constraints](#version-constraints)
  - [Host-Constraints](#host-constraints)

### Vollständige Deklaration
<a id="full-declaration"></a>

```js
fastify.route(options)
```

### Routen-Optionen
<a id="options"></a>

* `method`: unterstützt derzeit `GET`, `HEAD`, `TRACE`, `DELETE`,
  `OPTIONS`, `PATCH`, `PUT` und `POST`. Um weitere Methoden zu akzeptieren,
  muss [`addHttpMethod`](./Server.md#addHttpMethod) verwendet werden.
  Es kann auch ein Array von Methoden sein.
* `url`: der Pfad der URL, auf den diese Route passen soll (Alias: `path`).
* `schema`: ein Objekt mit den Schemata für Request und Response. Sie müssen im
  Format [JSON Schema](https://json-schema.org/) vorliegen; weitere Informationen
  finden Sie [hier](./Validation-and-Serialization.md).

  * `body`: validiert den Body des Requests, wenn es sich um eine Methode POST,
    PUT, PATCH, TRACE, SEARCH, PROPFIND, PROPPATCH oder LOCK handelt.
  * `querystring` oder `query`: validiert den Querystring. Das kann ein
    vollständiges JSON-Schema-Objekt sein, mit der Eigenschaft `type` gleich
    `object` und einem `properties`-Objekt mit Parametern, oder schlicht die
    Werte, die im `properties`-Objekt enthalten wären, wie unten gezeigt.
  * `params`: validiert die Params.
  * `response`: filtert die Response und erzeugt ein Schema dafür; ein gesetztes
    Schema bringt 10–20 % mehr Durchsatz.
* `exposeHeadRoute`: erzeugt zu jeder `GET`-Route eine benachbarte `HEAD`-Route.
  Standard ist der Wert der Instanz-Option
  [`exposeHeadRoutes`](./Server.md#exposeHeadRoutes). Wenn Sie einen eigenen
  `HEAD`-Handler wünschen, ohne diese Option zu deaktivieren, definieren Sie ihn
  unbedingt vor der `GET`-Route.
* `attachValidation`: hängt `validationError` an den Request an, falls ein
  Schema-Validierungsfehler auftritt, statt den Fehler an den Error-Handler zu
  senden. Das Standard-[Fehlerformat](https://ajv.js.org/api.html#error-objects)
  ist das von Ajv.
* `onRequest(request, reply, done)`: eine [Funktion](./Hooks.md#onrequest), die
  aufgerufen wird, sobald ein Request eintrifft; es kann auch ein Array von
  Funktionen sein.
* `preParsing(request, reply, payload, done)`: eine
  [Funktion](./Hooks.md#preparsing), die vor dem Parsen des Requests aufgerufen
  wird; es kann auch ein Array von Funktionen sein.
* `preValidation(request, reply, done)`: eine
  [Funktion](./Hooks.md#prevalidation), die nach den gemeinsamen
  `preValidation`-Hooks aufgerufen wird; nützlich, wenn Sie beispielsweise
  Authentifizierung auf Routen-Ebene durchführen müssen; es kann auch ein Array
  von Funktionen sein.
* `preHandler(request, reply, done)`: eine [Funktion](./Hooks.md#prehandler), die
  unmittelbar vor dem Request-Handler aufgerufen wird; es kann auch ein Array von
  Funktionen sein.
* `preSerialization(request, reply, payload, done)`: eine
  [Funktion](./Hooks.md#preserialization), die unmittelbar vor der Serialisierung
  aufgerufen wird; es kann auch ein Array von Funktionen sein.
* `onSend(request, reply, payload, done)`: eine
  [Funktion](./Hooks.md#route-hooks), die unmittelbar vor dem Senden einer
  Response aufgerufen wird; es kann auch ein Array von Funktionen sein.
* `onResponse(request, reply, done)`: eine [Funktion](./Hooks.md#onresponse), die
  aufgerufen wird, nachdem eine Response gesendet wurde; Sie können dem Client
  dann keine weiteren Daten mehr senden. Es kann auch ein Array von Funktionen
  sein.
* `onTimeout(request, reply, done)`: eine [Funktion](./Hooks.md#ontimeout), die
  aufgerufen wird, wenn ein Request in einen Timeout läuft und der HTTP-Socket
  getrennt wurde.
* `onError(request, reply, error, done)`: eine [Funktion](./Hooks.md#onerror),
  die aufgerufen wird, wenn der Route-Handler einen Error wirft oder an den
  Client sendet.
* `handler(request, reply)`: die Funktion, die diesen Request verarbeitet. Beim
  Aufruf des Handlers ist der [Fastify-Server](./Server.md) an `this` gebunden.
  Hinweis: Die Verwendung einer Arrow Function bricht die Bindung von `this`.
* `errorHandler(error, request, reply)`: ein eigener Error-Handler für den
  Geltungsbereich des Requests. Er überschreibt für Requests an diese Route den
  globalen Standard-Error-Handler sowie alles, was über
  [`setErrorHandler`](./Server.md#seterrorhandler) gesetzt wurde. Auf den
  Standard-Handler greifen Sie über `instance.errorHandler` zu. Beachten Sie,
  dass dieser nur dann auf Fastifys Standard-`errorHandler` zeigt, wenn ihn nicht
  bereits ein Plugin überschrieben hat.
* `childLoggerFactory(logger, binding, opts, rawReq)`: eine eigene
  Factory-Funktion, die aufgerufen wird, um für jeden Request eine
  Child-Logger-Instanz zu erzeugen.
  Weitere Informationen finden Sie unter
  [`childLoggerFactory`](./Server.md#childloggerfactory). Sie überschreibt für
  Requests an diese Route die Standard-Logger-Factory sowie alles, was über
  [`setChildLoggerFactory`](./Server.md#setchildloggerfactory) gesetzt wurde. Auf
  die Standard-Factory greifen Sie über `instance.childLoggerFactory` zu.
  Beachten Sie, dass diese nur dann auf Fastifys Standard-`childLoggerFactory`
  zeigt, wenn sie nicht bereits ein Plugin überschrieben hat.
* `validatorCompiler({ schema, method, url, httpPart })`: Funktion, die Schemata
  für Request-Validierungen baut. Siehe die Dokumentation zu [Validation and
  Serialization](./Validation-and-Serialization.md#schema-validator).
* `serializerCompiler({ schema, method, url, httpStatus, contentType })`:
  Funktion, die Schemata für die Response-Serialisierung baut. Siehe die
  Dokumentation zu [Validation and
  Serialization](./Validation-and-Serialization.md#schema-serializer).
* `schemaErrorFormatter(errors, dataVar)`: Funktion, die die Fehler des
  Validierungs-Compilers formatiert. Siehe die Dokumentation zu [Validation and
  Serialization](./Validation-and-Serialization.md#error-handling). Sie
  überschreibt für Requests an diese Route den globalen
  Schema-Error-Formatter-Handler sowie alles, was über `setSchemaErrorFormatter`
  gesetzt wurde.
* `bodyLimit`: verhindert, dass der Standard-JSON-Body-Parser Request-Bodies
  parst, die größer als diese Anzahl an Bytes sind. Muss eine Ganzzahl sein. Sie
  können diese Option auch global beim ersten Erzeugen der Fastify-Instanz mit
  `fastify(options)` setzen. Standard ist `1048576` (1 MiB).
* `handlerTimeout`: maximale Anzahl an Millisekunden für den vollständigen
  Lebenszyklus der Route. Überschreibt
  [`handlerTimeout`](./Server.md#factory-handler-timeout) auf Server-Ebene. Muss
  eine positive Ganzzahl sein. Wenn der Timeout auslöst, wird `request.signal`
  abgebrochen und ein 503-Fehler über den Error-Handler gesendet (der sich pro
  Route anpassen lässt).
* `logLevel`: setzt den Log-Level für diese Route. Siehe unten.
* `logSerializers`: setzt die Serializer, die für diese Route geloggt werden.
* `config`: Objekt zum Speichern eigener Konfiguration.
* `version`: ein [semver](https://semver.org/)-kompatibler String, der die
  Version des Endpunkts festlegt. [Beispiel](#version-constraints).
* `constraints`: definiert Routen-Einschränkungen basierend auf
  Request-Eigenschaften oder -Werten und ermöglicht damit angepasstes Matching
  über [find-my-way](https://github.com/delvedor/find-my-way)-Constraints.
  Enthält die eingebauten Constraints `version` und `host` sowie Unterstützung
  für eigene Constraint-Strategien.
* `prefixTrailingSlash`: String, der bestimmt, wie die Übergabe von `/` als Route
  mit einem Präfix behandelt wird.
  * `both` (Standard): Registriert sowohl `/prefix` als auch `/prefix/`.
  * `slash`: Registriert nur `/prefix/`.
  * `no-slash`: Registriert nur `/prefix`.

  Hinweis: Diese Option überschreibt nicht `ignoreTrailingSlash` in der
  [Server](./Server.md)-Konfiguration.

* `request` ist in [Request](./Request.md) definiert.

* `reply` ist in [Reply](./Reply.md) definiert.

> ℹ️ Hinweis:
> Die Dokumentation zu `onRequest`, `preParsing`, `preValidation`,
> `preHandler`, `preSerialization`, `onSend` und `onResponse` finden Sie
> ausführlich in [Hooks](./Hooks.md). Um eine Response zu senden, bevor der
> Request vom `handler` verarbeitet wird, siehe [Respond to a request from
> a hook](./Hooks.md#respond-to-a-request-from-a-hook).

Beispiel:
```js
fastify.route({
  method: 'GET',
  url: '/',
  schema: {
    querystring: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        excitement: { type: 'integer' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          hello: { type: 'string' }
        }
      }
    }
  },
  handler: function (request, reply) {
    reply.send({ hello: 'world' })
  }
})
```

### Kurzform-Deklaration
<a id="shorthand-declaration"></a>

Die obige Routen-Deklaration ist eher *Hapi*-artig; wenn Sie einen
*Express/Restify*-Ansatz bevorzugen, unterstützen wir auch diesen:

`fastify.get(path, [options], handler)`

`fastify.head(path, [options], handler)`

`fastify.post(path, [options], handler)`

`fastify.put(path, [options], handler)`

`fastify.delete(path, [options], handler)`

`fastify.options(path, [options], handler)`

`fastify.patch(path, [options], handler)`

Beispiel:
```js
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
fastify.get('/', opts, (request, reply) => {
  reply.send({ hello: 'world' })
})
```

`fastify.all(path, [options], handler)` fügt denselben Handler für alle
unterstützten Methoden hinzu.

Der Handler kann auch über das `options`-Objekt bereitgestellt werden:
```js
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
  },
  handler: function (request, reply) {
    reply.send({ hello: 'world' })
  }
}
fastify.get('/', opts)
```

> ℹ️ Hinweis:
> Den Handler sowohl in `options` als auch als dritten Parameter der
> Kurzform-Methode anzugeben wirft einen Fehler wegen doppeltem `handler`.

### URL-Aufbau
<a id="url-building"></a>

Fastify unterstützt sowohl statische als auch dynamische URLs.

Um einen **parametrischen** Pfad zu registrieren, verwenden Sie einen
*Doppelpunkt* vor dem Parameternamen. Für **Wildcards** verwenden Sie einen
*Stern*. Statische Routen werden stets vor parametrischen und Wildcard-Routen
geprüft.

```js
// parametric
fastify.get('/example/:userId', function (request, reply) {
  // curl ${app-url}/example/12345
  // userId === '12345'
  const { userId } = request.params;
  // your code here
})
fastify.get('/example/:userId/:secretToken', function (request, reply) {
  // curl ${app-url}/example/12345/abc.zHi
  // userId === '12345'
  // secretToken === 'abc.zHi'
  const { userId, secretToken } = request.params;
  // your code here
})

// wildcard
fastify.get('/example/*', function (request, reply) {})
```

Routen mit regulären Ausdrücken werden unterstützt, doch Slashes müssen escaped
werden. Beachten Sie außerdem, dass RegExp sehr teuer in Bezug auf die Performance ist!
```js
// parametric with regexp
fastify.get('/example/:file(^\\d+).png', function (request, reply) {
  // curl ${app-url}/example/12345.png
  // file === '12345'
  const { file } = request.params;
  // your code here
})
```

Es ist möglich, mehr als einen Parameter zwischen demselben Slash-Paar ("/") zu
definieren. Zum Beispiel:
```js
fastify.get('/example/near/:lat-:lng/radius/:r', function (request, reply) {
  // curl ${app-url}/example/near/15°N-30°E/radius/20
  // lat === "15°N"
  // lng === "30°E"
  // r ==="20"
  const { lat, lng, r } = request.params;
  // your code here
})
```
*Denken Sie in diesem Fall daran, den Bindestrich ("-") als Parametertrenner zu verwenden.*

Schließlich sind auch mehrere Parameter mit RegExp möglich:
```js
fastify.get('/example/at/:hour(^\\d{2})h:minute(^\\d{2})m', function (request, reply) {
  // curl ${app-url}/example/at/08h24m
  // hour === "08"
  // minute === "24"
  const { hour, minute } = request.params;
  // your code here
})
```
In diesem Fall lässt sich als Parametertrenner jedes Zeichen verwenden, das vom
regulären Ausdruck nicht erfasst wird.

Der letzte Parameter kann optional gemacht werden, indem ein Fragezeichen ("?")
an das Ende des Parameternamens angehängt wird.
```js
fastify.get('/example/posts/:id?', function (request, reply) {
  const { id } = request.params;
  // your code here
})
```
In diesem Fall sind sowohl `/example/posts` als auch `/example/posts/1` gültig.
Der optionale Parameter ist `undefined`, wenn er nicht angegeben wird.

Eine Route mit mehreren Parametern kann sich negativ auf die Performance
auswirken. Bevorzugen Sie einen Ansatz mit einem einzelnen Parameter, besonders
bei Routen auf dem heißen Pfad Ihrer Anwendung. Weitere Details finden Sie unter
[find-my-way](https://github.com/delvedor/find-my-way).

> ⚠️ Sicherheit:
> Fastify (über find-my-way) dekodiert Routen-Parameter und Wildcards per
> Prozent-Dekodierung, bevor sie Ihren Handler erreichen. Kodierte Trennzeichen
> in einem Segment werden im Parameterwert dekodiert: Bei einer Route
> `/download/:file` liefert ein Request auf `/download/..%2fsecret.txt`
> `request.params.file === '../secret.txt'`. Parameter sind nicht
> vertrauenswürdige Eingaben. Übergeben Sie sie nicht ohne Validierung oder
> Pfad-Eingrenzung an `path.join`, `fs`-APIs, Template-Engines oder Redirects.
> Um Dateien aus einem Verzeichnis-Root auszuliefern, verwenden Sie
> [`@fastify/static`](https://github.com/fastify/fastify-static), statt
> `request.params` selbst in einen Dateisystempfad zu verketten. Siehe auch
> [Request](./Request.md).

Um einen Doppelpunkt in einen Pfad aufzunehmen, ohne einen Parameter zu
deklarieren, verwenden Sie einen doppelten Doppelpunkt. Zum Beispiel:
```js
fastify.post('/name::verb') // will be interpreted as /name:verb
```

### Async Await
<a id="async-await"></a>

Sie nutzen `async/await`? Wir haben an Sie gedacht!
```js
fastify.get('/', options, async function (request, reply) {
  const data = await getData()
  const processed = await processData(data)
  return processed
})
```

Wie gezeigt, wird `reply.send` nicht aufgerufen, um Daten an den Nutzer
zurückzusenden. Geben Sie einfach den Body zurück, und Sie sind fertig!

Bei Bedarf können Sie Daten auch mit `reply.send` zurücksenden. Vergessen Sie in
diesem Fall nicht, in Ihrem `async`-Handler `return reply` oder `await reply` zu
verwenden, um Race Conditions zu vermeiden.

```js
fastify.get('/', options, async function (request, reply) {
  const data = await getData()
  const processed = await processData(data)
  return reply.send(processed)
})
```

Wenn die Route eine callback-basierte API umschließt, die `reply.send()`
außerhalb der Promise-Kette aufruft, ist es möglich, `await reply` zu verwenden:

```js
fastify.get('/', options, async function (request, reply) {
  setImmediate(() => {
    reply.send({ hello: 'world' })
  })
  await reply
})
```

Das Zurückgeben von reply funktioniert ebenfalls:

```js
fastify.get('/', options, async function (request, reply) {
  setImmediate(() => {
    reply.send({ hello: 'world' })
  })
  return reply
})
```

> ⚠ Warnung:
> * Wenn Sie sowohl `return value` als auch `reply.send(value)` verwenden, hat
>   Ersteres Vorrang, Letzteres wird verworfen und ein *warn*-Log ausgegeben.
> * `reply.send()` außerhalb des Promise aufzurufen ist möglich, erfordert aber
>   besondere Aufmerksamkeit. Siehe [promise-resolution](#promise-resolution).
> * `undefined` kann nicht zurückgegeben werden. Siehe [promise-resolution](#promise-resolution).

### Promise-Auflösung
<a id="promise-resolution"></a>

Wenn der Handler eine `async`-Funktion ist oder ein Promise zurückgibt, beachten
Sie das besondere Verhalten zur Unterstützung von Callback- und
Promise-Kontrollfluss. Wenn das Promise des Handlers aufgelöst wird, wird die
Reply automatisch mit dessen Wert gesendet, sofern Sie im Handler nicht explizit
`reply` awaiten oder zurückgeben.

1. Wenn Sie `async/await` oder Promises verwenden, aber mit `reply.send`
   antworten:
    - **Verwenden Sie** `return reply` / `await reply`.
    - **Vergessen Sie nicht**, `reply.send` aufzurufen.
2. Wenn Sie `async/await` oder Promises verwenden:
    - **Verwenden Sie nicht** `reply.send`.
    - **Geben Sie** den zu sendenden Wert zurück.

Dieser Ansatz unterstützt sowohl `callback-style` als auch `async-await` mit
minimalen Kompromissen. Es wird jedoch empfohlen, innerhalb Ihrer Anwendung nur
einen Stil zu verwenden, um eine konsistente Fehlerbehandlung zu erreichen.

> ℹ️ Hinweis:
> Jede async-Funktion gibt von sich aus ein Promise zurück.

### Routen-Präfixe
<a id="route-prefixing"></a>

Manchmal ist es nötig, mehrere Versionen derselben API zu pflegen. Ein
verbreiteter Ansatz besteht darin, Routen mit der API-Versionsnummer zu
präfixieren, z. B. `/v1/user`. Fastify bietet eine schnelle und clevere
Möglichkeit, verschiedene Versionen derselben API zu erstellen, ohne alle
Routennamen von Hand zu ändern – *Route Prefixing*. So funktioniert es:

```js
// server.js
const fastify = require('fastify')()

fastify.register(require('./routes/v1/users'), { prefix: '/v1' })
fastify.register(require('./routes/v2/users'), { prefix: '/v2' })

fastify.listen({ port: 3000 })
```

```js
// routes/v1/users.js
module.exports = function (fastify, opts, done) {
  fastify.get('/user', handler_v1)
  done()
}
```

```js
// routes/v2/users.js
module.exports = function (fastify, opts, done) {
  fastify.get('/user', handler_v2)
  done()
}
```
Fastify beanstandet nicht, dass derselbe Name für zwei verschiedene Routen
verwendet wird, weil es das Präfix zur Kompilierzeit automatisch behandelt. So
bleibt die Performance unbeeinträchtigt.

Nun haben Clients Zugriff auf die folgenden Routen:
- `/v1/user`
- `/v2/user`

Das lässt sich mehrfach tun und funktioniert auch bei verschachteltem
`register`. Routen-Parameter werden ebenfalls unterstützt.

Um ein Präfix für alle Routen zu verwenden, platzieren Sie sie in einem Plugin:

```js
const fastify = require('fastify')()

const route = {
    method: 'POST',
    url: '/login',
    handler: () => {},
    schema: {},
}

fastify.register(function (app, _, done) {
  app.get('/users', () => {})
  app.route(route)

  done()
}, { prefix: '/v1' }) // global route prefix

await fastify.listen({ port: 3000 })
```

### Routen-Präfixe und fastify-plugin
<a id="fastify-plugin"></a>

Wenn Sie [`fastify-plugin`](https://github.com/fastify/fastify-plugin) verwenden,
um Routen zu umschließen, funktioniert diese Option nicht. Damit sie
funktioniert, umschließen Sie ein Plugin mit einem Plugin:
```js
const fp = require('fastify-plugin')
const routes = require('./lib/routes')

module.exports = fp(async function (app, opts) {
  app.register(routes, {
    prefix: '/v1',
  })
}, {
  name: 'my-routes'
})
```

#### Behandlung der Route / in präfixierten Plugins

Die Route `/` verhält sich unterschiedlich, je nachdem, ob das Präfix auf `/`
endet. Bei einem Präfix `/something/` passt eine hinzugefügte `/`-Route
beispielsweise nur auf `/something/`. Bei einem Präfix `/something` passt eine
hinzugefügte `/`-Route sowohl auf `/something` als auch auf `/something/`.

Um dieses Verhalten zu ändern, siehe die oben beschriebene Routen-Option
`prefixTrailingSlash`.

### Eigener Log-Level
<a id="custom-log-level"></a>

In Fastify lassen sich für Routen unterschiedliche Log-Level setzen, indem die
Option `logLevel` mit dem gewünschten
[Wert](https://github.com/pinojs/pino/blob/main/docs/api.md#level-string) an das
Plugin oder die Route übergeben wird.
Ist ein `logLevel` einer Route ungültig, wirft Fastify während der
Routen-Registrierung
[`FST_ERR_ROUTE_LOG_LEVEL_INVALID`](./Errors.md#fst_err_route_log_level_invalid).

Beachten Sie, dass das Setzen von `logLevel` auf Plugin-Ebene auch
[`setNotFoundHandler`](./Server.md#setnotfoundhandler) und
[`setErrorHandler`](./Server.md#seterrorhandler) betrifft.

```js
// server.js
const fastify = require('fastify')({ logger: true })

fastify.register(require('./routes/user'), { logLevel: 'warn' })
fastify.register(require('./routes/events'), { logLevel: 'debug' })

fastify.listen({ port: 3000 })
```

Oder übergeben Sie ihn direkt an eine Route:
```js
fastify.get('/', { logLevel: 'warn' }, (request, reply) => {
  reply.send({ hello: 'world' })
})
```
*Denken Sie daran, dass der eigene Log-Level nur für Routen gilt, nicht für den
globalen Fastify-Logger, der über `fastify.log` erreichbar ist.*

### Eigener Log-Serializer
<a id="custom-log-serializer"></a>

In manchen Kontexten kann das Loggen eines großen Objekts Ressourcen
verschwenden. Definieren Sie eigene
[`serializers`](https://github.com/pinojs/pino/blob/main/docs/api.md#serializers-object)
und hängen Sie sie im passenden Kontext an.

```js
const fastify = require('fastify')({ logger: true })

fastify.register(require('./routes/user'), {
  logSerializers: {
    user: (value) => `My serializer one - ${value.name}`
  }
})
fastify.register(require('./routes/events'), {
  logSerializers: {
    user: (value) => `My serializer two - ${value.name} ${value.surname}`
  }
})

fastify.listen({ port: 3000 })
```

Serializer können über den Kontext vererbt werden:

```js
const fastify = Fastify({
  logger: {
    level: 'info',
    serializers: {
      user (req) {
        return {
          method: req.method,
          url: req.url,
          headers: req.headers,
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket.remotePort
        }
      }
    }
  }
})

fastify.register(context1, {
  logSerializers: {
    user: value => `My serializer father - ${value}`
  }
})

async function context1 (fastify, opts) {
  fastify.get('/', (req, reply) => {
    req.log.info({ user: 'call father serializer', key: 'another key' })
    // shows: { user: 'My serializer father - call father  serializer', key: 'another key' }
    reply.send({})
  })
}

fastify.listen({ port: 3000 })
```

### Config
<a id="routes-config"></a>

Beim Registrieren eines neuen Handlers können Sie ihm ein Konfigurationsobjekt
übergeben und es im Handler wieder abrufen.

```js
// server.js
const fastify = require('fastify')()

function handler (req, reply) {
  reply.send(reply.routeOptions.config.output)
}

fastify.get('/en', { config: { output: 'hello world!' } }, handler)
fastify.get('/it', { config: { output: 'ciao mondo!' } }, handler)

fastify.listen({ port: 3000 })
```

### Constraints
<a id="constraints"></a>

Fastify unterstützt es, Routen so einzuschränken, dass sie nur auf bestimmte
Requests passen – anhand von Eigenschaften wie dem `Host`-Header oder jedem
anderen Wert – über
[`find-my-way`](https://github.com/delvedor/find-my-way)-Constraints.
Constraints werden in der Eigenschaft `constraints` der Routen-Optionen
angegeben. Fastify bringt zwei eingebaute Constraints mit: `version` und `host`.
Eigene Constraint-Strategien lassen sich hinzufügen, um andere Teile eines
Requests zu untersuchen und zu entscheiden, ob eine Route ausgeführt werden soll.

#### Version-Constraints

Sie können einer Route in der Option `constraints` einen Schlüssel `version`
mitgeben. Versionierte Routen erlauben es, mehrere Handler für denselben
HTTP-Routenpfad zu deklarieren, die anhand des `Accept-Version`-Headers des
Requests ausgewählt werden. Der Wert des `Accept-Version`-Headers sollte der
[semver](https://semver.org/)-Spezifikation folgen, und Routen sollten für das
Matching mit exakten semver-Versionen deklariert werden.

Fastify verlangt einen gesetzten `Accept-Version`-Header im Request, wenn die
Route eine Version gesetzt hat, und bevorzugt für denselben Pfad eine
versionierte Route gegenüber einer nicht versionierten. Fortgeschrittene
Versionsbereiche und Pre-Releases werden derzeit nicht unterstützt.

> ℹ️ Hinweis:
> Die Verwendung dieser Funktion kann die Performance des Routers beeinträchtigen.

```js
fastify.route({
  method: 'GET',
  url: '/',
  constraints: { version: '1.2.0' },
  handler: function (request, reply) {
    reply.send({ hello: 'world' })
  }
})

fastify.inject({
  method: 'GET',
  url: '/',
  headers: {
    'Accept-Version': '1.x' // it could also be '1.2.0' or '1.2.x'
  }
}, (err, res) => {
  // { hello: 'world' }
})
```

> ⚠ Warnung:
> Setzen Sie in Responses einen
> [`Vary`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Vary)-Header
> mit dem für die Versionierung verwendeten Wert
> (z. B. `'Accept-Version'`), um Cache-Poisoning-Angriffe zu verhindern.
> Das lässt sich auch in einem Proxy/CDN konfigurieren.
>
> ```js
> const append = require('vary').append
> fastify.addHook('onSend', (req, reply, payload, done) => {
>   if (req.headers['accept-version']) { // or the custom header being used
>     let value = reply.getHeader('Vary') || ''
>     const header = Array.isArray(value) ? value.join(', ') : String(value)
>     if ((value = append(header, 'Accept-Version'))) { // or the custom header being used
>       reply.header('Vary', value)
>     }
>   }
>  done()
> })
> ```

Werden mehrere Versionen mit demselben Major oder Minor deklariert, wählt Fastify
stets die höchste, die mit dem Wert des `Accept-Version`-Headers kompatibel ist.

Fehlt dem Request der `Accept-Version`-Header, wird ein 404-Fehler zurückgegeben.

Eine eigene Logik für das Versions-Matching lässt sich über die Konfiguration
[`constraints`](./Server.md#constraints) beim Erzeugen einer
Fastify-Server-Instanz definieren.

#### Host-Constraints

Geben Sie in der Routen-Option `constraints` einen Schlüssel `host` an, um die
Route auf bestimmte Werte des `Host`-Headers des Requests zu beschränken. Werte
des `host`-Constraints lassen sich als Strings für exakte Übereinstimmungen oder
als RegExps für beliebiges Host-Matching angeben.

```js
fastify.route({
  method: 'GET',
  url: '/',
  constraints: { host: 'auth.fastify.example' },
  handler: function (request, reply) {
    reply.send('hello world from auth.fastify.example')
  }
})

fastify.inject({
  method: 'GET',
  url: '/',
  headers: {
    'Host': 'fastify.example'
  }
}, (err, res) => {
  // 404 because the host doesn't match the constraint
})

fastify.inject({
  method: 'GET',
  url: '/',
  headers: {
    'Host': 'auth.fastify.dev'
  }
}, (err, res) => {
  // => 'hello world from auth.fastify.dev'
})
```

`host`-Constraints lassen sich auch als RegExp angeben, wodurch sich die
Einschränkung auf Hosts mit Wildcard-Subdomains (oder jedem anderen Muster)
umsetzen lässt:

```js
fastify.route({
  method: 'GET',
  url: '/',
  constraints: { host: /.*\.fastify\.example/ }, // will match any subdomain of fastify.dev
  handler: function (request, reply) {
    reply.send('hello world from ' + request.headers.host)
  }
})
```

#### Asynchrone eigene Constraints

Es lassen sich eigene Constraints bereitstellen, und die `constraint`-Kriterien
können aus einer anderen Quelle wie einer Datenbank geholt werden. Verwenden Sie
asynchrone eigene Constraints nur als letztes Mittel, da sie die Performance des
Routers beeinträchtigen.

```js
function databaseOperation(field, done) {
  done(null, field)
}

const secret = {
  // strategy name for referencing in the route handler `constraints` options
  name: 'secret',
  // storage factory for storing routes in the find-my-way route tree
  storage: function () {
    let handlers = {}
    return {
      get: (type) => { return handlers[type] || null },
      set: (type, store) => { handlers[type] = store }
    }
  },
  // function to get the value of the constraint from each incoming request
  deriveConstraint: (req, ctx, done) => {
    databaseOperation(req.headers['secret'], done)
  },
  // optional flag marking if handlers without constraints can match requests that have a value for this constraint
  mustMatchWhenDerived: true
}
```

> ⚠ Warnung:
> Vermeiden Sie es bei asynchronen Constraints, innerhalb des Callbacks Fehler
> zurückzugeben. Sind Fehler unvermeidbar, stellen Sie einen eigenen
> `frameworkErrors`-Handler bereit, um sie zu behandeln. Andernfalls kann die
> Routenauswahl kaputtgehen oder sensible Informationen offenlegen.
>
> ```js
> const Fastify = require('fastify')
>
> const fastify = Fastify({
>   frameworkErrors: function (err, req, res) {
>     if (err instanceof Fastify.errorCodes.FST_ERR_ASYNC_CONSTRAINT) {
>       res.code(400)
>       return res.send("Invalid header provided")
>     } else {
>       res.send(err)
>     }
>   }
> })
> ```
