<h1 align="center">Fastify</h1>

## Factory
<a id="factory"></a>

Das Fastify-Modul exportiert eine Factory-Funktion, mit der neue
<code><b>Fastify-Server</b></code>-Instanzen erzeugt werden. Diese Factory-Funktion
nimmt ein Options-Objekt entgegen, mit dem die resultierende Instanz angepasst
wird. Dieses Dokument beschreibt die in diesem Options-Objekt verfügbaren
Eigenschaften.

- [Factory](#factory)
  - [`http`](#http)
  - [`http2`](#http2)
  - [`https`](#https)
  - [`connectionTimeout`](#connectiontimeout)
  - [`keepAliveTimeout`](#keepalivetimeout)
  - [`forceCloseConnections`](#forcecloseconnections)
  - [`maxRequestsPerSocket`](#maxrequestspersocket)
  - [`requestTimeout`](#requesttimeout)
  - [`bodyLimit`](#bodylimit)
  - [`onProtoPoisoning`](#onprotopoisoning)
  - [`onConstructorPoisoning`](#onconstructorpoisoning)
  - [`logger`](#logger)
  - [`loggerInstance`](#loggerinstance)
  - [`disableRequestLogging`](#disablerequestlogging)
  - [`logController`](#logcontroller)
  - [`serverFactory`](#serverfactory)
  - [`requestIdHeader`](#requestidheader)
  - [`requestIdLogLabel`](#requestidloglabel)
  - [`genReqId`](#genreqid)
  - [`trustProxy`](#trustproxy)
  - [`pluginTimeout`](#plugintimeout)
  - [`exposeHeadRoutes`](#exposeheadroutes)
  - [`return503OnClosing`](#return503onclosing)
  - [`ajv`](#ajv)
  - [`serializerOpts`](#serializeropts)
  - [`http2SessionTimeout`](#http2sessiontimeout)
  - [`frameworkErrors`](#frameworkerrors)
  - [`clientErrorHandler`](#clienterrorhandler)
  - [`rewriteUrl`](#rewriteurl)
  - [`allowErrorHandlerOverride`](#allowerrorhandleroverride)
  - [RouterOptions](#routeroptions)
    - [`allowUnsafeRegex`](#allowunsaferegex)
    - [`buildPrettyMeta`](#buildprettymeta)
    - [`caseSensitive`](#casesensitive)
    - [`constraints`](#constraints)
    - [`defaultRoute`](#defaultroute)
    - [`ignoreDuplicateSlashes`](#ignoreduplicateslashes)
    - [`ignoreTrailingSlash`](#ignoretrailingslash)
    - [`maxParamLength`](#maxparamlength)
    - [`onBadUrl`](#onbadurl)
    - [`onMaxParamLength`](#onmaxparamlength)
    - [`querystringParser`](#querystringparser)
    - [`useSemicolonDelimiter`](#usesemicolondelimiter)
- [Instance](#instance)
  - [Server-Methoden](#server-methods)
    - [server](#server)
    - [after](#after)
    - [ready](#ready)
    - [listen](#listen)
    - [addresses](#addresses)
    - [routing](#routing)
    - [route](#route)
    - [hasRoute](#hasroute)
    - [findRoute](#findroute)
    - [close](#close)
    - [decorate\*](#decorate)
    - [register](#register)
    - [addHook](#addhook)
    - [prefix](#prefix)
    - [pluginName](#pluginname)
    - [hasPlugin](#hasplugin)
    - [listeningOrigin](#listeningorigin)
    - [log](#log)
    - [version](#version)
    - [inject](#inject)
    - [addHttpMethod](#addHttpMethod)
    - [addSchema](#addschema)
    - [getSchemas](#getschemas)
    - [getSchema](#getschema)
    - [setReplySerializer](#setreplyserializer)
    - [setValidatorCompiler](#setvalidatorcompiler)
    - [setSchemaErrorFormatter](#setschemaerrorformatter)
    - [setSerializerCompiler](#setserializercompiler)
    - [validatorCompiler](#validatorcompiler)
    - [serializerCompiler](#serializercompiler)
    - [schemaErrorFormatter](#schemaerrorformatter)
    - [schemaController](#schemacontroller)
    - [setNotFoundHandler](#setnotfoundhandler)
    - [setErrorHandler](#seterrorhandler)
    - [setChildLoggerFactory](#setchildloggerfactory)
    - [setGenReqId](#setgenreqid)
    - [addConstraintStrategy](#addconstraintstrategy)
    - [hasConstraintStrategy](#hasconstraintstrategy)
    - [printRoutes](#printroutes)
    - [printPlugins](#printplugins)
    - [addContentTypeParser](#addcontenttypeparser)
    - [hasContentTypeParser](#hascontenttypeparser)
    - [removeContentTypeParser](#removecontenttypeparser)
    - [removeAllContentTypeParsers](#removeallcontenttypeparsers)
    - [getDefaultJsonParser](#getdefaultjsonparser)
    - [defaultTextParser](#defaulttextparser)
    - [errorHandler](#errorhandler)
    - [childLoggerFactory](#childloggerfactory)
    - [Symbol.asyncDispose](#symbolasyncdispose)
    - [initialConfig](#initialconfig)

### `http`
<a id="factory-http"></a>

+ Standard: `null`

Ein Objekt, mit dem der Listening-Socket des Servers konfiguriert wird. Die Optionen
sind dieselben wie bei der Node.js-Kernmethode [`createServer`](https://nodejs.org/docs/latest-v20.x/api/http.html#httpcreateserveroptions-requestlistener).

Diese Option wird ignoriert, wenn die Optionen [`http2`](#factory-http2) oder
[`https`](#factory-https) gesetzt sind.

### `http2`
<a id="factory-http2"></a>

+ Standard: `false`

Ist der Wert `true`, wird das
[HTTP/2](https://nodejs.org/dist/latest-v20.x/docs/api/http2.html)-Modul des
Node.js-Kerns zum Binden des Sockets verwendet.

### `https`
<a id="factory-https"></a>

+ Standard: `null`

Ein Objekt, mit dem der Listening-Socket des Servers für TLS konfiguriert wird. Die
Optionen sind dieselben wie bei der Node.js-Kernmethode
[`createServer`](https://nodejs.org/dist/latest-v20.x/docs/api/https.html#https_https_createserver_options_requestlistener).
Ist diese Eigenschaft `null`, wird der Socket nicht für TLS konfiguriert.

Diese Option gilt auch, wenn die Option [`http2`](#factory-http2) gesetzt ist.

### `connectionTimeout`
<a id="factory-connection-timeout"></a>

+ Standard: `0` (kein Timeout)

Definiert das Server-Timeout in Millisekunden. Die Dokumentation zur Eigenschaft
[`server.timeout`](https://nodejs.org/api/http.html#servertimeout) erklärt die
Wirkung dieser Option.

Ist die Option `serverFactory` angegeben, wird diese Option ignoriert.

### `keepAliveTimeout`
<a id="factory-keep-alive-timeout"></a>

+ Standard: `72000` (72 Sekunden)

Definiert das Keep-Alive-Timeout des Servers in Millisekunden. Die Dokumentation zur
Eigenschaft
[`server.keepAliveTimeout`](https://nodejs.org/api/http.html#serverkeepalivetimeout)
erklärt die Wirkung dieser Option. Diese Option gilt nur, wenn HTTP/1 verwendet wird.

Ist die Option `serverFactory` angegeben, wird diese Option ignoriert.

### `forceCloseConnections`
<a id="forcecloseconnections"></a>

+ Standard: `"idle"`, sofern der HTTP-Server es erlaubt, ansonsten `false`

Ist der Wert `true`, durchläuft der Server bei [`close`](#close) die aktuellen
persistenten Verbindungen und [zerstört deren
Sockets](https://nodejs.org/dist/latest-v16.x/docs/api/net.html#socketdestroyerror).

Bei Verwendung mit einem HTTP/2-Server werden zusätzlich alle aktiven
HTTP/2-Sessions geschlossen.

> ℹ️ Hinweis:
> Seit Node.js v24 werden aktive Sessions standardmäßig geschlossen


> ⚠ Warnung:
> Verbindungen werden nicht daraufhin geprüft, ob Requests
> abgeschlossen wurden.

Fastify bevorzugt die Methode
[`closeAllConnections`](https://nodejs.org/dist/latest-v18.x/docs/api/http.html#servercloseallconnections)
des HTTP-Servers, sofern sie unterstützt wird; andernfalls verwendet es die interne
Verbindungsverfolgung.

Ist der Wert `"idle"`, durchläuft der Server bei [`close`](#close) die aktuellen
persistenten Verbindungen, die weder einen Request senden noch auf eine Response
warten, und zerstört deren Sockets. Der Wert wird nur unterstützt, wenn der
HTTP-Server die Methode
[`closeIdleConnections`](https://nodejs.org/dist/latest-v18.x/docs/api/http.html#servercloseidleconnections)
unterstützt; andernfalls führt der Versuch, ihn zu setzen, zu einer Exception.

### `maxRequestsPerSocket`
<a id="factory-max-requests-per-socket"></a>

+ Standard: `0` (kein Limit)

Definiert die maximale Anzahl von Requests, die ein Socket verarbeiten kann, bevor
die Keep-Alive-Verbindung geschlossen wird. Die Eigenschaft
[`server.maxRequestsPerSocket`](https://nodejs.org/dist/latest/docs/api/http.html#servermaxrequestspersocket)
erklärt die Wirkung dieser Option. Diese Option gilt nur, wenn HTTP/1.1 verwendet
wird. Ist außerdem die Option `serverFactory` angegeben, wird diese Option
ignoriert.

> ℹ️ Hinweis:
>  Zum Zeitpunkt der Erstellung dieses Textes unterstützt nur node >= v16.10.0 diese Option.

### `requestTimeout`
<a id="factory-request-timeout"></a>

+ Standard: `0` (kein Limit)

Definiert die maximale Anzahl von Millisekunden für den Empfang des gesamten
Requests vom Client. Die Eigenschaft
[`server.requestTimeout`](https://nodejs.org/dist/latest/docs/api/http.html#servertimeout)
erklärt die Wirkung dieser Option.

Ist die Option `serverFactory` angegeben, wird diese Option ignoriert.
Sie muss auf einen Wert ungleich null gesetzt werden (z. B. 120 Sekunden), um vor
möglichen Denial-of-Service-Angriffen zu schützen, falls der Server ohne
vorgeschalteten Reverse Proxy betrieben wird.

> ℹ️ Hinweis:
>  Zum Zeitpunkt der Erstellung dieses Textes unterstützt nur node >= v14.11.0 diese Option

### `handlerTimeout`
<a id="factory-handler-timeout"></a>

+ Standard: `0` (kein Timeout)

Definiert die maximale Anzahl von Millisekunden, die für die Verarbeitung eines
Requests über den gesamten Route-Lebenszyklus hinweg erlaubt ist (vom Routing über
onRequest, Parsing, Validierung, Ausführung des Handlers bis zur Serialisierung).
Wird die Response nicht innerhalb dieser Zeit gesendet, wird ein Fehler
`503 Service Unavailable` zurückgegeben und `request.signal` abgebrochen.

Anders als `connectionTimeout` und `requestTimeout` (die auf Socket-Ebene wirken)
ist `handlerTimeout` ein Timeout auf Anwendungsebene, das mit
HTTP-Keep-Alive-Verbindungen korrekt zusammenarbeitet. Es kann pro Route über
[Route-Optionen](./Routes.md#routes-options) überschrieben werden. Ist es auf beiden
Ebenen gesetzt, hat der Wert auf Route-Ebene Vorrang. Routes ohne explizites
`handlerTimeout` erben den Serverstandard. Ist einmal ein Timeout auf Serverebene
gesetzt, können sich einzelne Routes nicht davon abmelden – sie können es nur mit
einer anderen positiven ganzen Zahl überschreiben.

Das Timeout ist **kooperativ**: Wenn es auslöst, sendet Fastify die 503-Fehlerantwort,
aber die asynchrone Arbeit des Handlers läuft weiter. Verwenden Sie
[`request.signal`](./Request.md), um den Abbruch zu erkennen und laufende Arbeit zu
stoppen (Datenbankabfragen, HTTP-Requests usw.). APIs, die eine `signal`-Option
akzeptieren (`fetch()`, Datenbanktreiber, `stream.pipeline()`), brechen automatisch ab.

Der Timeout-Fehler (`FST_ERR_HANDLER_TIMEOUT`) wird über den
[Error-Handler](./Routes.md#routes-options) der Route gesendet, der pro Route
angepasst werden kann, um Statuscode oder Response-Body zu ändern.

Wird `reply.hijack()` aufgerufen, wird der Timeout-Timer gelöscht – der Handler
übernimmt die volle Verantwortung für den Lebenszyklus der Response.

> ℹ️ Hinweis:
> `handlerTimeout` gilt nicht für 404-Handler oder eigene Not-Found-Handler,
> die über `setNotFoundHandler()` gesetzt wurden, da sie den Lebenszyklus des
> Route-Handlers umgehen.

```js
const fastify = require('fastify')({
  handlerTimeout: 10000 // 10s default for all routes
})

// Override per-route
fastify.get('/slow-report', { handlerTimeout: 120000 }, async (request) => {
  // Use request.signal for cooperative cancellation
  const data = await db.query(longQuery, { signal: request.signal })
  return data
})

// Customize the timeout response
fastify.get('/custom-timeout', {
  handlerTimeout: 5000,
  errorHandler: (error, request, reply) => {
    if (error.code === 'FST_ERR_HANDLER_TIMEOUT') {
      reply.code(504).send({ error: 'Gateway Timeout' })
    } else {
      reply.send(error)
    }
  }
}, async (request) => {
  const result = await externalService.call({ signal: request.signal })
  return result
})
```

### `bodyLimit`
<a id="factory-body-limit"></a>

+ Standard: `1048576` (1 MiB)

Definiert den maximalen Payload in Bytes, den der Server annehmen darf.
Der Standard-Body-Reader sendet eine
[`FST_ERR_CTP_BODY_TOO_LARGE`](./Errors.md#fst_err_ctp_body_too_large)-Antwort,
wenn die Größe des Bodys dieses Limit überschreitet.
Ist ein [`preParsing`-Hook](./Hooks.md#preparsing) vorhanden, gilt dieses Limit für
die Größe des vom Hook zurückgegebenen Streams (also die Größe des "dekodierten"
Bodys).

### `onProtoPoisoning`
<a id="factory-on-proto-poisoning"></a>

+ Standard: `'error'`

Definiert, welche Maßnahme das Framework ergreifen muss, wenn ein JSON-Objekt mit
`__proto__` geparst wird. Diese Funktionalität wird von
[secure-json-parse](https://github.com/fastify/secure-json-parse) bereitgestellt.
Weitere Einzelheiten zu Prototype-Poisoning-Angriffen finden Sie unter
[Prototype Poisoning](../Guides/Prototype-Poisoning.md).

Mögliche Werte sind `'error'`, `'remove'` oder `'ignore'`.

### `onConstructorPoisoning`
<a id="factory-on-constructor-poisoning"></a>

+ Standard: `'error'`

Definiert, welche Maßnahme das Framework ergreifen muss, wenn ein JSON-Objekt mit
`constructor` geparst wird. Diese Funktionalität wird von
[secure-json-parse](https://github.com/fastify/secure-json-parse) bereitgestellt.
Weitere Einzelheiten zu Prototype-Poisoning-Angriffen finden Sie unter
[Prototype Poisoning](../Guides/Prototype-Poisoning.md).

Mögliche Werte sind `'error'`, `'remove'` oder `'ignore'`.

### `logger`
<a id="factory-logger"></a>

Fastify bringt über den Logger [Pino](https://getpino.io/) eingebautes Logging mit.
Diese Eigenschaft wird verwendet, um die interne Logger-Instanz zu konfigurieren.

Diese Eigenschaft kann folgende Werte annehmen:

+ Standard: `false`. Der Logger ist deaktiviert. Alle Logging-Methoden verweisen auf
eine Null-Logger-Instanz von
[abstract-logging](https://www.npmjs.com/package/abstract-logging).

+ `object`: ein übliches
  [Options-Objekt](https://github.com/pinojs/pino/blob/c77d8ec5ce/docs/API.md#constructor)
  von Pino. Es wird direkt an den Pino-Konstruktor übergeben. Wenn die folgenden
  Eigenschaften im Objekt nicht vorhanden sind, werden sie entsprechend ergänzt:
    * `level`: die minimale Logging-Stufe. Ist sie nicht gesetzt, wird sie auf
      `'info'` gesetzt.
    * `serializers`: ein Hash von Serialisierungsfunktionen. Standardmäßig werden
      Serializer für `req` (eingehende Request-Objekte), `res` (ausgehende
      Response-Objekte) und `err` (übliche `Error`-Objekte) ergänzt. Erhält eine
      Log-Methode ein Objekt mit einer dieser Eigenschaften, wird der jeweilige
      Serializer für diese Eigenschaft verwendet. Zum Beispiel:
        ```js
        fastify.get('/foo', function (req, res) {
          req.log.info({req}) // log the serialized request object
          res.send('foo')
        })
        ```
      Jeder vom Anwender bereitgestellte Serializer überschreibt den
      Standard-Serializer der entsprechenden Eigenschaft.

### `loggerInstance`
<a id="factory-logger-instance"></a>

+ Standard: `null`

Eine eigene Logger-Instanz. Der Logger muss eine Pino-Instanz sein oder der
Pino-Schnittstelle entsprechen, indem er die folgenden Methoden besitzt: `info`,
`error`, `debug`, `fatal`, `warn`, `trace`, `child`. Zum Beispiel:
  ```js
  const pino = require('pino')();

  const customLogger = {
    info: function (o, ...n) {},
    warn: function (o, ...n) {},
    error: function (o, ...n) {},
    fatal: function (o, ...n) {},
    trace: function (o, ...n) {},
    debug: function (o, ...n) {},
    child: function() {
      const child = Object.create(this);
      child.pino = pino.child(...arguments);
      return child;
    },
  };

  const fastify = require('fastify')({ loggerInstance: customLogger });
  ```

### `disableRequestLogging`
<a id="factory-disable-request-logging"></a>

> **Veraltet:** Verwenden Sie stattdessen die Option
> [`logController`](#factory-log-controller) mit `disableRequestLogging` oder dem
> Override `isLogDisabled`.
> Diese Top-Level-Option wird in `fastify@6` entfernt.

+ Standard: `false`

Ist das Logging aktiviert, gibt Fastify eine Log-Meldung der Stufe `info` aus, wenn
ein Request empfangen wurde und wenn die Response für diesen Request gesendet wurde.
Setzt man diese Option auf `true`, werden diese Log-Meldungen deaktiviert. Das
erlaubt ein flexibleres Logging von Request-Beginn und -Ende, indem eigene
`onRequest`- und `onResponse`-Hooks angehängt werden.

Diese Option kann auch eine Funktion sein, die das Fastify-Request-Objekt entgegennimmt
und einen Booleschen Wert zurückgibt. Das erlaubt bedingtes Request-Logging auf Basis
der Request-Eigenschaften (z. B. URL, Header, Decorations).

```js
const { LogController } = require('fastify')

// Deprecated
const fastify = require('fastify')({
  logger: true,
  disableRequestLogging: (request) => {
    return request.url === '/health' || request.url === '/ready'
  }
})

// Recommended: use logController instead
const fastify = require('fastify')({
  logger: true,
  logController: new LogController({
    disableRequestLogging: (request) => {
      return request.url === '/health' || request.url === '/ready'
    }
  })
})
```

Die weiteren Log-Einträge, die deaktiviert werden, sind:
- ein Fehler-Log, das vom Standard-`onResponse`-Hook bei Fehlern im Reply-Callback
  geschrieben wird
- die Fehler- und Info-Logs, die der `defaultErrorHandler`
bei der Fehlerbehandlung schreibt
- das Info-Log, das der `fourOhFour`-Handler schreibt, wenn eine
nicht existierende Route angefragt wird

Andere von Fastify ausgegebene Log-Meldungen bleiben aktiviert,
etwa Deprecation-Warnungen und Meldungen,
die ausgegeben werden, wenn Requests eintreffen, während der Server heruntergefahren
wird.

```js
// Examples of hooks to replicate the disabled functionality.
fastify.addHook('onRequest', (req, reply, done) => {
  req.log.info({ url: req.raw.url, id: req.id }, 'received request')
  done()
})

fastify.addHook('onResponse', (req, reply, done) => {
  req.log.info({ url: req.raw.originalUrl, statusCode: reply.raw.statusCode }, 'request completed')
  done()
})
```

### `logController`
<a id="factory-log-controller"></a>

+ Standard: `undefined`

Nimmt eine Instanz von `LogController` (oder einer Unterklasse) entgegen, um Fastifys
interne Log-Zeilen anzupassen. Leiten Sie von der Klasse `LogController` ab und
überschreiben Sie nur die Methoden, die Sie anpassen möchten; alle anderen behalten
ihr Standardverhalten.

Die Klasse `LogController` wird aus `fastify` exportiert:

```js
const { LogController } = require('fastify')
```

Der Konstruktor nimmt ein optionales Options-Objekt entgegen:

| Eigenschaft | Typ | Standard | Beschreibung |
|----------|------|---------|-------------|
| `disableRequestLogging` | `boolean \| (req) => boolean` | `false` | Ist der Wert `true` (oder gibt eine Funktion `true` zurück), werden Log-Zeilen pro Request unterdrückt. |
| `requestIdLogLabel` | `string` | `'reqId'` | Die Bezeichnung, die beim Logging für den Request-Bezeichner verwendet wird. |

```js
const { LogController } = require('fastify')

class MyLogController extends LogController {
  constructor () {
    super({
      requestIdLogLabel: 'traceId',
      disableRequestLogging: (request) => {
        return request.url === '/health'
      }
    })
  }

  incomingRequest (request, reply, metadata) {
    // Use debug level instead of info for incoming requests
    request.log.debug({ req: request }, 'incoming request')
  }

  requestCompleted (error, request, reply, metadata) {
    // Add custom fields to the request completed log
    if (error) {
      reply.log.error({ res: reply, err: error, responseTime: reply.elapsedTime, customField: 'value' }, 'request errored')
    } else {
      reply.log.info({ res: reply, responseTime: reply.elapsedTime, customField: 'value' }, 'request completed')
    }
  }
}

const fastify = require('fastify')({
  logger: true,
  logController: new MyLogController()
})
```

Die fehlerbezogenen Methoden haben eine einheitliche Signatur:
`(error, request, reply, metadata)`, wobei `metadata` alle zusätzlichen Daten pro
Methode trägt (zum Beispiel den an `serializerError` übergebenen `statusCode`).
`incomingRequest` und `routeNotFound` lassen das Argument `error` weg, da sie an
Punkten des Lebenszyklus auslösen, an denen kein Fehler existiert.
`serviceUnavailable` ist eine weitere Ausnahme, da keine Route – und damit kein
`request`/`reply` – gebildet wird.

| Methode | Signatur | Beschreibung |
|--------|-----------|-------------|
| `isLogDisabled` | `(request)` | Prüft, ob das Request-Logging für den gegebenen Request deaktiviert ist. Es wirkt sich auf alle anderen Log-Methoden aus. |
| `incomingRequest` | `(request, reply, metadata)` | Loggt einen eingehenden Request auf Stufe `info`. |
| `requestCompleted` | `(error, request, reply, metadata)` | Loggt das Ergebnis eines abgeschlossenen Requests. Verwendet die Stufe `error`, wenn ein Fehler vorliegt, ansonsten `info`. |
| `defaultErrorLog` | `(error, request, reply, metadata)` | Loggt einen vom Standard-Error-Handler behandelten Fehler. Verwendet `error` bei 5xx, `info` bei 4xx. |
| `streamError` | `(error, request, reply, metadata)` | Loggt Fehler auf Stream-Ebene, nachdem die Header gesendet wurden. |
| `routeNotFound` | `(request, reply, metadata)` | Loggt eine "route not found"-Meldung auf Stufe `info`. |
| `writeHeadError` | `(error, request, reply, metadata)` | Loggt eine Warnung, wenn `writeHead` während der Fehlerbehandlung fehlschlägt. |
| `serializerError` | `(error, request, reply, metadata)` | Loggt einen Fehler, wenn der Serializer für einen bestimmten Statuscode fehlschlägt. Der auslösende Statuscode ist als `metadata.statusCode` verfügbar. |
| `serviceUnavailable` | `(logger, server)` | Loggt einen 503, wenn der Server heruntergefahren wird. Wird immer ausgegeben und nicht durch `disableRequestLogging` gesteuert. |

**Hinweis:** Wenn Sie eine Methode überschreiben, übernehmen Sie die volle Kontrolle
darüber – die standardmäßige `disableRequestLogging`-Prüfung wird **nicht**
automatisch angewendet.
Wenn Sie bedingtes Logging brauchen, rufen Sie `this.isLogDisabled(request)` selbst
auf oder überschreiben Sie zusätzlich `isLogDisabled`.

### `serverFactory`
<a id="custom-http-server"></a>

Sie können Fastify über die Option `serverFactory` einen eigenen HTTP-Server
übergeben.

`serverFactory` ist eine Funktion, die einen Parameter `handler` entgegennimmt,
welcher die Objekte `request` und `response` als Parameter erhält, sowie ein
Options-Objekt, das demjenigen entspricht, das Sie an Fastify übergeben haben.

```js
const serverFactory = (handler, opts) => {
  const server = http.createServer((req, res) => {
    handler(req, res)
  })

  return server
}

const fastify = Fastify({ serverFactory })

fastify.get('/', (req, reply) => {
  reply.send({ hello: 'world' })
})

fastify.listen({ port: 3000 })
```

Intern verwendet Fastify die API des HTTP-Servers aus dem Node-Kern; wenn Sie also
einen eigenen Server verwenden, müssen Sie sicherstellen, dass er dieselbe API
bereitstellt. Falls nicht, können Sie die Serverinstanz innerhalb der Funktion
`serverFactory` vor der `return`-Anweisung erweitern.


### `requestIdHeader`
<a id="factory-request-id-header"></a>

+ Standard: `false`

Der Name des Headers, der zum Setzen der Request-ID verwendet wird. Siehe den
Abschnitt [request-id](./Logging.md#logging-request-id).
Wird `requestIdHeader` auf `true` gesetzt, wird `requestIdHeader` auf
`"request-id"` gesetzt.
Wird `requestIdHeader` auf eine nicht leere Zeichenkette gesetzt, wird diese
Zeichenkette als `requestIdHeader` verwendet.
Standardmäßig ist `requestIdHeader` auf `false` gesetzt und verwendet unmittelbar
[genReqId](#genreqid).
Wird `requestIdHeader` auf eine leere Zeichenkette (`""`) gesetzt, wird
requestIdHeader auf `false` gesetzt.

```js
const fastify = require('fastify')({
  requestIdHeader: 'x-custom-id', // -> use 'X-Custom-Id' header if available
  //requestIdHeader: false, // -> always use genReqId
})
```

> ⚠ Warnung:
> Das Aktivieren erlaubt es beliebigen Aufrufern, `reqId` auf einen
> Wert ihrer Wahl zu setzen.
> Für `requestIdHeader` findet keine Validierung statt.

### `requestIdLogLabel`
<a id="factory-request-id-log-label"></a>

> **Veraltet:** Verwenden Sie stattdessen die Option
> [`logController`](#factory-log-controller) mit `requestIdLogLabel`. Diese
> Top-Level-Option wird in `fastify@6` entfernt.

+ Standard: `'reqId'`

Definiert die Bezeichnung, die beim Logging des Requests für den Request-Bezeichner
verwendet wird.

### `genReqId`
<a id="factory-gen-request-id"></a>

+ Standard: `Wert des Headers 'request-id', sofern angegeben, andernfalls monoton
  steigende ganze Zahlen`

Funktion zum Erzeugen der Request-ID. Sie erhält den _rohen_ eingehenden Request als
Parameter. Von dieser Funktion wird erwartet, dass sie fehlerfrei ist.

Besonders in verteilten Systemen möchten Sie das Standardverhalten der ID-Erzeugung
vielleicht wie unten gezeigt überschreiben. Zum Erzeugen von `UUID`s werfen Sie
vielleicht einen Blick auf [hyperid](https://github.com/mcollina/hyperid).

> ℹ️ Hinweis:
> `genReqId` wird nicht aufgerufen, wenn der in
> <code>[requestIdHeader](#requestidheader)</code> gesetzte Header verfügbar ist
> (Standard ist `false`).

```js
let i = 0
const fastify = require('fastify')({
  genReqId: function (req) { return i++ }
})
```

### `trustProxy`
<a id="factory-trust-proxy"></a>

+ Standard: `false`
+ `true/false`: Allen Proxys vertrauen (`true`) oder keinem Proxy vertrauen
  (`false`).
+ `string`: Nur der angegebenen IP/CIDR vertrauen (z. B. `'127.0.0.1'`). Kann eine
  Liste kommagetrennter Werte sein (z. B. `'127.0.0.1,192.168.1.1/24'`).
+ `Array<string>`: Nur der angegebenen IP-/CIDR-Liste vertrauen (z. B. `['127.0.0.1']`).
+ `number`: Dem n-ten Hop vom vorgelagerten Proxy-Server als Client vertrauen.
+ `Function`: Eigene Vertrauensfunktion, die `address` als erstes Argument entgegennimmt
    ```js
    function myTrustFn(address, hop) {
      return address === '1.2.3.4' || hop === 1
    }
    ```

Durch Aktivieren der Option `trustProxy` weiß Fastify, dass es hinter einem Proxy
sitzt und dass den `X-Forwarded-*`-Headerfeldern vertraut werden darf, die sich
andernfalls leicht fälschen ließen.

```js
const fastify = Fastify({ trustProxy: true })
```

Weitere Beispiele finden Sie im Paket
[`@fastify/proxy-addr`](https://www.npmjs.com/package/@fastify/proxy-addr).

Sie können auf die Werte `ip`, `ips`, `host` und `protocol` am
[`request`](./Request.md)-Objekt zugreifen.

> ⚠️ Sicherheit:
> Diese Werte stammen aus Socket-/Forwarding-Metadaten und müssen als nicht
> vertrauenswürdige Eingabe behandelt werden, sofern Ihre Proxy-Kette nicht
> ausdrücklich vertrauenswürdig und validiert ist. Verwenden Sie sie ohne explizite
> Validierung nicht direkt für Autorisierungs- oder andere
> sicherheitsrelevante Entscheidungen.

```js
fastify.get('/', (request, reply) => {
  console.log(request.ip)
  console.log(request.ips)
  console.log(request.host)
  console.log(request.protocol)
})
```

> ℹ️ Hinweis:
> Enthält ein Request mehrere `x-forwarded-host`- oder `x-forwarded-proto`-Header,
> wird nur der letzte verwendet, um `request.hostname`
> und `request.protocol` abzuleiten.

### `pluginTimeout`
<a id="plugin-timeout"></a>

+ Standard: `10000`

Die maximale Zeit in *Millisekunden*, in der ein Plugin geladen werden kann.
Andernfalls wird [`ready`](#ready) mit einem `Error` mit dem Code
`'ERR_AVVIO_PLUGIN_TIMEOUT'` abgeschlossen. Ist der Wert `0`, wird diese Prüfung
deaktiviert. Das steuert den Parameter `timeout` von
[avvio](https://www.npmjs.com/package/avvio).

### `querystringParser`
<a id="factory-querystring-parser"></a>

Der Standard-Querystring-Parser, den Fastify verwendet, ist ein performanterer Fork
des `querystring`-Moduls aus dem Node.js-Kern namens
[`fast-querystring`](https://github.com/anonrig/fast-querystring).

Sie können diese Option nutzen, um einen eigenen Parser einzusetzen, etwa
[`qs`](https://www.npmjs.com/package/qs).

Wenn Sie nur möchten, dass die Schlüssel (und nicht die Werte) case-insensitiv sind,
empfehlen wir einen eigenen Parser, der nur die Schlüssel in Kleinbuchstaben
umwandelt.

```js
const qs = require('qs')
const fastify = require('fastify')({
  routerOptions: {
    querystringParser: str => qs.parse(str)
  }
})
```

Sie können auch Fastifys Standardparser verwenden und einzelne Verhaltensweisen
ändern, wie im folgenden Beispiel für case-insensitive Schlüssel und Werte:

```js
const querystring = require('fast-querystring')
const fastify = require('fastify')({
  routerOptions: {
    querystringParser: str => querystring.parse(str.toLowerCase())
  }
})
```

### `exposeHeadRoutes`
<a id="exposeHeadRoutes"></a>

+ Standard: `true`

Erzeugt für jede definierte `GET`-Route automatisch eine gleichrangige
`HEAD`-Route. Wenn Sie einen eigenen `HEAD`-Handler wollen, ohne diese Option zu
deaktivieren, achten Sie darauf, ihn vor der `GET`-Route zu definieren.

### `return503OnClosing`
<a id="factory-return-503-on-closing"></a>

+ Standard: `true`

Ist der Wert `true`, erhält jeder Request, der nach dem Aufruf von
[`close`](#close) eintrifft, eine `503 Service Unavailable`-Antwort mit dem Header
`Connection: close` (HTTP/1.1). Damit können Load Balancer erkennen, dass der Server
heruntergefahren wird, und den Verkehr nicht mehr dorthin leiten.

Ist der Wert `false`, werden Requests, die während der Schließphase eintreffen,
normal geroutet und verarbeitet. Sie erhalten dennoch einen
`Connection: close`-Header, damit Clients nicht versuchen, die Verbindung
wiederzuverwenden.

### `ajv`
<a id="factory-ajv"></a>

Konfigurieren Sie die von Fastify verwendete Ajv-v8-Instanz, ohne eine eigene
bereitzustellen. Die Standardkonfiguration wird im Abschnitt
[#schema-validator](./Validation-and-Serialization.md#schema-validator) erläutert.

```js
const fastify = require('fastify')({
  ajv: {
    customOptions: {
      removeAdditional: 'all' // Refer to [ajv options](https://ajv.js.org/options.html#removeadditional)
    },
    plugins: [
      require('ajv-merge-patch'),
      [require('ajv-keywords'), 'instanceof']
      // Usage: [plugin, pluginOptions] - Plugin with options
      // Usage: plugin - Plugin without options
    ],
    onCreate: (ajv) => {
      // Modify the ajv instance as you need.
      ajv.addFormat('myFormat', (data) => typeof data === 'string')
    }
  }
})
```

### `serializerOpts`
<a id="serializer-opts"></a>

Passen Sie die Optionen der standardmäßigen
[`fast-json-stringify`](https://github.com/fastify/fast-json-stringify#options)-Instanz
an, die den Payload der Response serialisiert:

```js
const fastify = require('fastify')({
  serializerOpts: {
    rounding: 'ceil'
  }
})
```

### `http2SessionTimeout`
<a id="http2-session-timeout"></a>

+ Standard: `72000`

Setzt für jede eingehende HTTP/2-Session ein Standard-[Timeout](https://nodejs.org/api/http2.html#http2sessionsettimeoutmsecs-callback)
in Millisekunden. Die Session wird beim Timeout geschlossen.

Diese Option ist nötig, um bei HTTP/2 ein sauberes "close"-Verhalten zu bieten. Der
niedrige Standardwert wurde gewählt, um Denial-of-Service-Angriffe abzumildern.
Sitzt der Server hinter einem Load Balancer oder kann er automatisch skalieren, kann
dieser Wert passend zum Anwendungsfall erhöht werden. Der Node-Kern setzt hier
standardmäßig `0`.

### `frameworkErrors`
<a id="framework-errors"></a>

+ Standard: `null`

Fastify stellt Standard-Error-Handler für die häufigsten Anwendungsfälle bereit. Mit
dieser Option ist es möglich, einen oder mehrere dieser Handler durch eigenen Code
zu überschreiben.

> ℹ️ Hinweis:
> Derzeit sind nur `FST_ERR_BAD_URL` und `FST_ERR_ASYNC_CONSTRAINT` implementiert.

```js
const fastify = require('fastify')({
  frameworkErrors: function (error, req, res) {
    if (error instanceof FST_ERR_BAD_URL) {
      res.code(400)
      return res.send("Provided url is not valid")
    } else if(error instanceof FST_ERR_ASYNC_CONSTRAINT) {
      res.code(400)
      return res.send("Provided header is not valid")
    } else {
      res.send(error)
    }
  }
})
```

### `clientErrorHandler`
<a id="client-error-handler"></a>

Setzt einen
[clientErrorHandler](https://nodejs.org/api/http.html#event-clienterror),
der auf `error`-Events von Client-Verbindungen hört und mit einem
`400` antwortet.

Mit dieser Option ist es möglich, den Standard-`clientErrorHandler` zu überschreiben.

+ Standard:
```js
function defaultClientErrorHandler (err, socket) {
  if (err.code === 'ECONNRESET') {
    return
  }

  const body = JSON.stringify({
    error: http.STATUS_CODES['400'],
    message: 'Client Error',
    statusCode: 400
  })
  this.log.trace({ err }, 'client error')

  if (socket.writable) {
    socket.end([
      'HTTP/1.1 400 Bad Request',
      `Content-Length: ${body.length}`,
      `Content-Type: application/json\r\n\r\n${body}`
    ].join('\r\n'))
  }
}
```

> ℹ️ Hinweis:
> `clientErrorHandler` arbeitet mit rohen Sockets. Von dem Handler wird erwartet,
> dass er eine korrekt geformte HTTP-Response zurückgibt, die eine Statuszeile,
> HTTP-Header und einen Message-Body enthält. Bevor er versucht, auf den Socket zu
> schreiben, sollte der Handler prüfen, ob der Socket noch beschreibbar ist, da er
> möglicherweise bereits zerstört wurde.

```js
const fastify = require('fastify')({
  clientErrorHandler: function (err, socket) {
    const body = JSON.stringify({
      error: {
        message: 'Client error',
        code: '400'
      }
    })

    // `this` is bound to fastify instance
    this.log.trace({ err }, 'client error')

    // the handler is responsible for generating a valid HTTP response
    socket.end([
      'HTTP/1.1 400 Bad Request',
      `Content-Length: ${body.length}`,
      `Content-Type: application/json\r\n\r\n${body}`
    ].join('\r\n'))
  }
})
```

### `rewriteUrl`
<a id="rewrite-url"></a>

Setzt eine synchrone Callback-Funktion, die eine Zeichenkette zurückgeben muss und
das Umschreiben von URLs erlaubt. Das ist nützlich, wenn Sie hinter einem Proxy
sitzen, der die URL ändert. Das Umschreiben einer URL verändert die Eigenschaft
`url` des `req`-Objekts.

Beachten Sie, dass `rewriteUrl` _vor_ dem Routing aufgerufen wird, nicht gekapselt
ist und eine instanzweite Konfiguration darstellt.

```js
// @param {object} req The raw Node.js HTTP request, not the `FastifyRequest` object.
// @this Fastify The root Fastify instance (not an encapsulated instance).
// @returns {string} The path that the request should be mapped to.
function rewriteUrl (req) {
  if (req.url === '/hi') {
    this.log.debug({ originalUrl: req.url, url: '/hello' }, 'rewrite url');
    return '/hello'
  } else {
    return req.url;
  }
}
```

## RouterOptions
<a id="routeroptions"></a>

Fastify verwendet [`find-my-way`](https://github.com/delvedor/find-my-way) als
HTTP-Router. Der Parameter `routerOptions` erlaubt es, [`find-my-way`-Optionen](https://github.com/delvedor/find-my-way?tab=readme-ov-file#findmywayoptions)
zu übergeben, um den HTTP-Router innerhalb von Fastify anzupassen.

### `allowUnsafeRegex`
<a id="allow-unsafe-regex"></a>

+ Standard `false`

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way), was
standardmäßig deaktiviert ist, sodass Routes nur sichere reguläre Ausdrücke
zulassen. Um unsichere Ausdrücke zu verwenden, setzen Sie `allowUnsafeRegex` auf
`true`.

```js
fastify.get('/user/:id(^([0-9]+){4}$)', (request, reply) => {
  // Throws an error without allowUnsafeRegex = true
})
```


### `buildPrettyMeta`
<a id="build-pretty-meta"></a>

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way), das
`buildPrettyMeta` unterstützt: Sie können eine `buildPrettyMeta`-Funktion zuweisen,
um das Store-Objekt einer Route für die Verwendung mit den
`prettyPrint`-Funktionen aufzubereiten. Diese Funktion sollte ein einzelnes Objekt
entgegennehmen und ein Objekt zurückgeben.

```js
const fastify = require('fastify')({
  routerOptions: {
    buildPrettyMeta: route => {
      const cleanMeta = Object.assign({}, route.store)

      // remove private properties
      Object.keys(cleanMeta).forEach(k => {
        if (typeof k === 'symbol') delete cleanMeta[k]
      })

      return cleanMeta // this will show up in the pretty print output!
    }
  }
})
```

### `caseSensitive`
<a id="case-sensitive"></a>

+ Standard: `true`

Ist der Wert `true`, werden Routes case-sensitiv registriert. Das heißt, `/foo`
ist nicht gleich `/Foo`.
Ist der Wert `false`, sind Routes case-insensitiv.

Beachten Sie bitte, dass das Setzen dieser Option auf `false` gegen
[RFC3986](https://datatracker.ietf.org/doc/html/rfc3986#section-6.2.2.1) verstößt.

Setzt man `caseSensitive` auf `false`, werden alle Pfade in Kleinschreibung
abgeglichen, aber die Route-Parameter oder Wildcards behalten ihre ursprüngliche
Groß- und Kleinschreibung.
Diese Option betrifft keine Query-Strings; zum Ändern von deren Behandlung siehe
[`querystringParser`](#querystringparser).

```js
fastify.get('/user/:username', (request, reply) => {
  // Given the URL: /USER/NodeJS
  console.log(request.params.username) // -> 'NodeJS'
})
```

### `constraints`
<a id="constraints"></a>

Fastifys eingebaute Route-Constraints werden von `find-my-way` bereitgestellt,
womit sich Routes über `version` oder `host` einschränken lassen. Sie können neue
Constraint-Strategien hinzufügen oder die eingebauten Strategien überschreiben,
indem Sie ein `constraints`-Objekt mit Strategien für `find-my-way` bereitstellen.
Weitere Informationen zu Constraint-Strategien finden Sie in der Dokumentation von
[find-my-way](https://github.com/delvedor/find-my-way).

```js
const customVersionStrategy = {
  storage: function () {
    const versions = {}
    return {
      get: (version) => { return versions[version] || null },
      set: (version, store) => { versions[version] = store }
    }
  },
  deriveVersion: (req, ctx) => {
    return req.headers['accept']
  }
}

const fastify = require('fastify')({
  routerOptions: {
    constraints: {
      version: customVersionStrategy
    }
  }
})
```

### `defaultRoute`
<a id="default-route"></a>

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way), womit sich
über die Option defaultRoute eine Standard-Route übergeben lässt.

```js
const fastify = require('fastify')({
  routerOptions: {
    defaultRoute: (req, res) => {
      res.statusCode = 404
      res.end()
    }
  }
})
```

> ℹ️ Hinweis:
> Die an `defaultRoute` übergebenen Objekte `req` und `res` sind die rohen
> Node.js-Instanzen `IncomingMessage` und `ServerResponse`. Sie stellen **nicht**
> die Fastify-spezifischen Methoden bereit, die auf
> `FastifyRequest`/`FastifyReply` verfügbar sind (zum Beispiel `res.send`).

### `ignoreDuplicateSlashes`
<a id="factory-ignore-duplicate-slashes"></a>

+ Standard: `false`

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way) für das
Routing. Sie können die Option `ignoreDuplicateSlashes` verwenden, um doppelte
Schrägstriche aus dem Pfad zu entfernen. Sie entfernt doppelte Schrägstriche im
Route-Pfad und in der Request-URL. Diese Option gilt für *alle*
Route-Registrierungen der resultierenden Serverinstanz.

Sind `ignoreTrailingSlash` und `ignoreDuplicateSlashes` beide auf `true` gesetzt,
entfernt Fastify zuerst doppelte Schrägstriche und dann abschließende
Schrägstriche, sodass `//a//b//c//` zu `/a/b/c` wird.

```js
const fastify = require('fastify')({
  routerOptions: {
    ignoreDuplicateSlashes: true
  }
})

// registers "/foo/bar/"
fastify.get('///foo//bar//', function (req, reply) {
  reply.send('foo')
})
```

### `ignoreTrailingSlash`
<a id="ignore-slash"></a>

+ Standard: `false`

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way) für das
Routing. Standardmäßig berücksichtigt Fastify abschließende Schrägstriche.
Pfade wie `/foo` und `/foo/` werden als unterschiedliche Pfade behandelt. Wenn Sie
das ändern möchten, setzen Sie dieses Flag auf `true`. Auf diese Weise verweisen
sowohl `/foo` als auch `/foo/` auf dieselbe Route. Diese Option gilt für *alle*
Route-Registrierungen der resultierenden Serverinstanz.

```js
const fastify = require('fastify')({
  routerOptions: {
    ignoreTrailingSlash: true
  }
})

// registers both "/foo" and "/foo/"
fastify.get('/foo/', function (req, reply) {
  reply.send('foo')
})

// registers both "/bar" and "/bar/"
fastify.get('/bar', function (req, reply) {
  reply.send('bar')
})
```

### `maxParamLength`
<a id="max-param-length"></a>

+ Standard: `100`

Sie können mit der Option `maxParamLength` eine eigene Länge für Parameter in
parametrischen Routes (Standard, Regex und Multi) festlegen; der Standardwert
beträgt 100 Zeichen. Wird die maximale Längenbegrenzung erreicht, wird die
Not-Found-Route aufgerufen.

Das kann besonders nützlich sein, wenn Sie eine Regex-basierte Route haben, und
schützt Sie vor
[ReDoS-Angriffen](https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS).


### `onBadUrl`
<a id="on-bad-url"></a>

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way), das den
Fall einer fehlerhaft formatierten URL unterstützt (z. B. /hello/%world);
standardmäßig ruft find-my-way die defaultRoute auf, sofern Sie nicht die Option
onBadUrl angeben.

```js
const fastify = require('fastify')({
  routerOptions: {
    onBadUrl: (path, req, res) => {
      res.statusCode = 400
      res.end(`Bad path: ${path}`)
    }
  }
})
```

Wie bei `defaultRoute` sind `req` und `res` die rohen
Node.js-Request-/Response-Objekte und stellen Fastifys dekorierte Hilfsfunktionen
nicht bereit.

### `onMaxParamLength`
<a id="on-max-param-length"></a>

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way), das den
Fall unterstützt, einen eigenen Handler bereitzustellen, wenn `maxParamLength `
überschritten wird.

```js
const fastify = require('fastify')({
  routerOptions: {
    maxParamLength: 10,
    onMaxParamLength: (path, req, res) => {
      res.statusCode = 414
      res.end(`Bad path: ${path}`)
    }
  }
})
```

Wie bei `defaultRoute` sind `req` und `res` die rohen
Node.js-Request-/Response-Objekte und stellen Fastifys dekorierte Hilfsfunktionen
nicht bereit.

### `querystringParser`
<a id="querystringparser"></a>

Der Standard-Querystring-Parser, den Fastify verwendet, ist ein performanterer Fork
des `querystring`-Moduls aus dem Node.js-Kern namens
[`fast-querystring`](https://github.com/anonrig/fast-querystring).

Sie können diese Option nutzen, um einen eigenen Parser einzusetzen, etwa
[`qs`](https://www.npmjs.com/package/qs).

Wenn Sie nur möchten, dass die Schlüssel (und nicht die Werte) case-insensitiv sind,
empfehlen wir einen eigenen Parser, der nur die Schlüssel in Kleinbuchstaben
umwandelt.

```js
const qs = require('qs')
const fastify = require('fastify')({
  routerOptions: {
    querystringParser: str => qs.parse(str)
  }
})
```

Sie können auch Fastifys Standardparser verwenden und einzelne Verhaltensweisen
ändern, wie im folgenden Beispiel für case-insensitive Schlüssel und Werte:

```js
const querystring = require('fast-querystring')
const fastify = require('fastify')({
  routerOptions: {
    querystringParser: str => querystring.parse(str.toLowerCase())
  }
})
```

### `useSemicolonDelimiter`
<a id="use-semicolon-delimiter"></a>

+ Standard `false`

Fastify verwendet [find-my-way](https://github.com/delvedor/find-my-way), das das
Trennen von Pfad und Query-String durch das Zeichen `;` (Code 59) unterstützt, z. B.
`/dev;foo=bar`.
Diese Entscheidung geht auf [delvedor/find-my-way#76]
(https://github.com/delvedor/find-my-way/issues/76) zurück. Diese Option
unterstützt somit die Abwärtskompatibilität für den Bedarf, an `;` zu trennen. Um
die Unterstützung für das Trennen an `;` zu aktivieren, setzen Sie
`useSemicolonDelimiter` auf `true`.

```js
const fastify = require('fastify')({
  routerOptions: {
    useSemicolonDelimiter: true
  }
})

fastify.get('/dev', async (request, reply) => {
  // An example request such as `/dev;foo=bar`
  // Will produce the following query params result `{ foo = 'bar' }`
  return request.query
})
```

### `allowErrorHandlerOverride`
<a id="allow-error-handler-override"></a>

* **Standard:** `true`

> ⚠ Warnung:
> Diese Option wird im nächsten Major-Release
> standardmäßig auf `false` gesetzt.

Ist der Wert `false`, verhindert er, dass `setErrorHandler` innerhalb desselben
Scopes mehrfach aufgerufen wird, und stellt so sicher, dass der vorherige
Error-Handler nicht unbeabsichtigt überschrieben wird.

#### Beispiel für falsche Verwendung:

```js
app.setErrorHandler(function freeSomeResources () {
  // Never executed, memory leaks
})

app.setErrorHandler(function anotherErrorHandler () {
  // Overrides the previous handler
})
```

## Instance

### Server-Methoden

#### server
<a id="server"></a>

`fastify.server`: Das
[Server](https://nodejs.org/api/http.html#class-httpserver)-Objekt aus dem
Node-Kern, wie es von der [**`Fastify-Factory-Funktion`**](#factory) zurückgegeben
wird.

> ⚠ Warnung:
> Bei unsachgemäßer Nutzung können bestimmte Fastify-Funktionen gestört werden.
> Es wird empfohlen, es nur zum Anhängen von Listenern zu verwenden.

#### after
<a id="after"></a>

Wird aufgerufen, wenn das aktuelle Plugin und alle darin registrierten Plugins
fertig geladen sind. Es wird immer vor der Methode `fastify.ready` ausgeführt.

```js
fastify
  .register((instance, opts, done) => {
    console.log('Current plugin')
    done()
  })
  .after(err => {
    console.log('After current plugin')
  })
  .register((instance, opts, done) => {
    console.log('Next plugin')
    done()
  })
  .ready(err => {
    console.log('Everything has been loaded')
  })
```

Wird `after()` ohne Funktion aufgerufen, gibt es ein `Promise` zurück:

```js
fastify.register(async (instance, opts) => {
  console.log('Current plugin')
})

await fastify.after()
console.log('After current plugin')

fastify.register(async (instance, opts) => {
  console.log('Next plugin')
})

await fastify.ready()

console.log('Everything has been loaded')
```

#### ready
<a id="ready"></a>

Funktion, die aufgerufen wird, wenn alle Plugins geladen wurden. Sie nimmt einen
Fehlerparameter entgegen, falls etwas schiefgegangen ist.
```js
fastify.ready(err => {
  if (err) throw err
})
```
Wird sie ohne Argumente aufgerufen, gibt sie ein `Promise` zurück:

```js
fastify.ready().then(() => {
  console.log('successfully booted!')
}, (err) => {
  console.log('an error happened', err)
})
```

#### listen
<a id="listen"></a>

Startet den Server und wartet intern auf das `.ready()`-Event. Die Signatur lautet
`.listen([options][, callback])`. Sowohl das `options`-Objekt als auch der Parameter
`callback` erweitern das Options-Objekt aus dem
[Node.js-Kern](https://nodejs.org/api/net.html#serverlistenoptions-callback). Damit
sind alle Kern-Optionen verfügbar, zusätzlich zu den folgenden
Fastify-spezifischen Optionen:

* listenTextResolver: Setzt einen optionalen Resolver für den Text, der geloggt
wird, nachdem der Server erfolgreich gestartet wurde. Mit dieser Option lässt sich
der Standard-Log-Eintrag `Server listening at [address]` überschreiben.

    ```js
    server.listen({
      port: 9080,
      listenTextResolver: (address) => { return `Prometheus metrics server is listening at ${address}` }
    })
    ```

Standardmäßig lauscht der Server auf der bzw. den Adressen, die `localhost`
auflöst, wenn kein bestimmter Host angegeben ist. Soll auf jeder verfügbaren
Schnittstelle gelauscht werden, führt die Angabe von `0.0.0.0` als Adresse dazu,
dass auf allen IPv4-Adressen gelauscht wird. Das oben angegebene Adress-Argument
gibt dann die erste solche IPv4-Adresse zurück. Die folgende Tabelle beschreibt die
möglichen Werte für `host`, wenn `localhost` angezielt wird, und was diese Werte für
`host` bewirken.

 Host          | IPv4 | IPv6
 --------------|------|-------
 `::`            | ✅<sup>*</sup> | ✅
 `::` + [`ipv6Only`](https://nodejs.org/api/net.html#serverlistenoptions-callback) | 🚫 | ✅
 `0.0.0.0`       | ✅ | 🚫
 `localhost`     | ✅ | ✅
 `127.0.0.1`     | ✅ | 🚫
 `::1`           | 🚫 | ✅

<sup>*</sup> Die Verwendung von `::` als Adresse lauscht auf allen IPv6-Adressen und
kann je nach Betriebssystem auch auf [allen
IPv4-Adressen](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)
lauschen.

Seien Sie vorsichtig bei der Entscheidung, auf allen Schnittstellen zu lauschen; sie
bringt inhärente
[Sicherheitsrisiken](https://web.archive.org/web/20170711105010/https://snyk.io/blog/mongodb-hack-and-secure-defaults/)
mit sich.

Standardmäßig wird auf `port: 0` (was den ersten verfügbaren freien Port wählt) und
`host: 'localhost'` gelauscht:

```js
fastify.listen((err, address) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```

Die Angabe einer Adresse wird ebenfalls unterstützt:

```js
fastify.listen({ port: 3000, host: '127.0.0.1' }, (err, address) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```

Wird kein Callback angegeben, wird ein Promise zurückgegeben:

```js
fastify.listen({ port: 3000 })
  .then((address) => console.log(`server listening on ${address}`))
  .catch(err => {
    console.log('Error starting server:', err)
    process.exit(1)
  })
```

Beim Deployment in Docker- und möglicherweise weiteren Containern empfiehlt es sich,
auf `0.0.0.0` zu lauschen, da diese gemappte Ports standardmäßig nicht auf
`localhost` bereitstellen:

```js
fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```

Wird `port` weggelassen (oder auf null gesetzt), wird automatisch ein zufälliger
verfügbarer Port gewählt (abrufbar über `fastify.server.address().port`).

Die Standardoptionen von listen sind:

```js
fastify.listen({
  port: 0,
  host: 'localhost',
  exclusive: false,
  readableAll: false,
  writableAll: false,
  ipv6Only: false
}, (err) => {})
```

#### addresses
<a id="addresses"></a>

Diese Methode gibt ein Array der Adressen zurück, auf denen der Server lauscht.
Rufen Sie sie auf, bevor `listen()` aufgerufen wurde, oder nach der Funktion
`close()`, gibt sie ein leeres Array zurück.

```js
await fastify.listen({ port: 8080 })
const addresses = fastify.addresses()
// [
//   { port: 8080, family: 'IPv6', address: '::1' },
//   { port: 8080, family: 'IPv4', address: '127.0.0.1' }
// ]
```

Beachten Sie, dass das Array auch `fastify.server.address()` enthält.

#### routing
<a id="routing"></a>

Methode für den Zugriff auf die `lookup`-Methode des internen Routers, um den
Request dem passenden Handler zuzuordnen:

```js
fastify.routing(req, res)
```

#### route
<a id="route"></a>

Methode, um dem Server Routes hinzuzufügen; es gibt auch Kurzformfunktionen, siehe
[hier](./Routes.md).

#### hasRoute
<a id="hasRoute"></a>

Methode, um zu prüfen, ob eine Route bereits im internen Router registriert ist. Sie
erwartet ein Objekt als Payload. `url` und `method` sind Pflichtfelder. Es ist
zusätzlich möglich, `constraints` anzugeben. Die Methode gibt `true` zurück, wenn
die Route registriert ist, andernfalls `false`.

```js
const routeExists = fastify.hasRoute({
  url: '/',
  method: 'GET',
  constraints: { version: '1.0.0' } // optional
})

if (routeExists === false) {
  // add route
}
```

#### findRoute
<a id="findRoute"></a>

Methode, um eine bereits im internen Router registrierte Route abzurufen. Sie
erwartet ein Objekt als Payload. `url` und `method` sind Pflichtfelder. Es ist
zusätzlich möglich, `constraints` anzugeben.
Die Methode gibt ein Route-Objekt zurück oder `null`, wenn die Route nicht gefunden
werden kann.

```js
const route = fastify.findRoute({
  url: '/artists/:artistId',
  method: 'GET',
  constraints: { version: '1.0.0' } // optional
})

if (route !== null) {
  // perform some route checks
  console.log(route.params)   // `{artistId: ':artistId'}`
}
```


#### close
<a id="close"></a>

`fastify.close(callback)`: Rufen Sie diese Funktion auf, um die Serverinstanz zu
schließen und den [`'onClose'`](./Hooks.md#on-close)-Hook auszuführen.

Der Aufruf von `close` führt außerdem dazu, dass der Server auf jeden neu
eintreffenden Request mit einem `503`-Fehler antwortet und diesen Request zerstört.
Um dieses Verhalten zu ändern, siehe die
[`return503OnClosing`-Flags](#factory-return-503-on-closing).

Wird sie ohne Argumente aufgerufen, gibt sie ein Promise zurück:

```js
fastify.close().then(() => {
  console.log('successfully closed!')
}, (err) => {
  console.log('an error happened', err)
})
```

##### Lebenszyklus des Herunterfahrens

Wird `fastify.close()` aufgerufen, geschehen die folgenden Schritte der Reihe nach:

1. Der Server wird als **closing** markiert. Neu eintreffende Requests erhalten
   einen `Connection: close`-Header (HTTP/1.1) und werden gemäß
   [`return503OnClosing`](#factory-return-503-on-closing) behandelt.
2. Die [`preClose`](./Hooks.md#pre-close)-Hooks werden ausgeführt. Der Server
   verarbeitet zu diesem Zeitpunkt noch laufende Requests.
3. **Verbindungsabbau** auf Basis der Option
   [`forceCloseConnections`](#forcecloseconnections):
   - `"idle"` — untätige Keep-Alive-Verbindungen werden geschlossen; laufende
     Requests werden fortgesetzt.
   - `true` — alle persistenten Verbindungen werden sofort zerstört.
   - `false` — kein erzwungenes Schließen; untätige Verbindungen bleiben offen, bis
     sie auf natürlichem Weg ablaufen (siehe [`keepAliveTimeout`](#keepalivetimeout)).
4. Der HTTP-Server **nimmt keine** neuen TCP-Verbindungen mehr **an**
   (`server.close()`). Node.js wartet, bis alle laufenden Requests abgeschlossen
   sind, bevor der Callback aufgerufen wird.
5. Die [`onClose`](./Hooks.md#on-close)-Hooks werden ausgeführt. Alle laufenden
   Requests sind abgeschlossen, und der Server lauscht nicht mehr.
6. Der `close`-Callback (oder das zurückgegebene Promise) wird erfüllt.

```
fastify.close() called
  │
  ├─▶ closing = true (new requests receive 503)
  │
  ├─▶ preClose hooks
  │     (in-flight requests still active)
  │
  ├─▶ Connection draining (forceCloseConnections)
  │
  ├─▶ server.close()
  │     (waits for in-flight requests to complete)
  │
  ├─▶ onClose hooks
  │     (server stopped, all requests done)
  │
  └─▶ close callback / Promise resolves
```

> ℹ️ Hinweis:
> Hochgestufte Verbindungen (etwa WebSocket) werden vom HTTP-Server nicht
> verfolgt und verhindern, dass `server.close()` abgeschlossen wird. Schließen Sie
> sie ausdrücklich in einem [`preClose`](./Hooks.md#pre-close)-Hook.

#### decorate*
<a id="decorate"></a>

Nützliche Funktion, wenn Sie die Fastify-Instanz, Reply oder Request dekorieren
müssen; siehe [hier](./Decorators.md).

#### register
<a id="register"></a>

Fastify erlaubt es dem Anwender, seine Funktionalität mit Plugins zu erweitern. Ein
Plugin kann eine Menge von Routes, ein Server-Decorator oder was auch immer sein;
siehe [hier](./Plugins.md).

#### addHook
<a id="addHook"></a>

Funktion, um einen bestimmten Hook im Lebenszyklus von Fastify hinzuzufügen; siehe
[hier](./Hooks.md).

#### prefix
<a id="prefix"></a>

Der vollständige Pfad, der einer Route vorangestellt wird.

Beispiel:

```js
fastify.register(function (instance, opts, done) {
  instance.get('/foo', function (request, reply) {
    // Will log "prefix: /v1"
    request.log.info('prefix: %s', instance.prefix)
    reply.send({ prefix: instance.prefix })
  })

  instance.register(function (instance, opts, done) {
    instance.get('/bar', function (request, reply) {
      // Will log "prefix: /v1/v2"
      request.log.info('prefix: %s', instance.prefix)
      reply.send({ prefix: instance.prefix })
    })

    done()
  }, { prefix: '/v2' })

  done()
}, { prefix: '/v1' })
```

#### pluginName
<a id="pluginName"></a>

Name des aktuellen Plugins. Das Root-Plugin heißt `'fastify'`. Es gibt
verschiedene Wege, einen Namen zu definieren (in dieser Reihenfolge).

1. Wenn Sie [fastify-plugin](https://github.com/fastify/fastify-plugin) verwenden,
   werden die Metadaten `name` verwendet.
2. Hat das exportierte Plugin die Eigenschaft `Symbol.for('fastify.display-name')`,
   wird der Wert dieser Eigenschaft verwendet.
   Beispiel: `pluginFn[Symbol.for('fastify.display-name')] = "Custom Name"`
3. Wenn Sie ein Plugin per `module.exports` exportieren, wird der Dateiname
   verwendet.
4. Wenn Sie eine gewöhnliche
   [Funktionsdeklaration](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Functions#defining_functions)
   verwenden, wird der Funktionsname verwendet.

*Rückfall*: Die ersten beiden Zeilen Ihres Plugins stellen den Plugin-Namen dar.
Zeilenumbrüche werden durch ` -- ` ersetzt. Das hilft, die Ursache zu erkennen, wenn
Sie mit vielen Plugins arbeiten.

> ⚠ Warnung:
> Wenn Sie mit verschachtelten Plugins arbeiten, unterscheidet sich der Name je nach
> Verwendung von [fastify-plugin](https://github.com/fastify/fastify-plugin), weil
> kein neuer Scope erzeugt wird und wir daher keinen Ort haben, um kontextbezogene
> Daten anzuhängen. In diesem Fall stellt der Plugin-Name die Boot-Reihenfolge aller
> beteiligten Plugins im Format `fastify -> plugin-A -> plugin-B` dar.

#### hasPlugin
<a id="hasPlugin"></a>

Methode, um zu prüfen, ob ein bestimmtes Plugin registriert wurde. Stützt sich auf
den Namen in den Plugin-Metadaten. Gibt `true` zurück, wenn das Plugin registriert
ist. Andernfalls wird `false` zurückgegeben.

```js
const fastify = require('fastify')()
fastify.register(require('@fastify/cookie'), {
  secret: 'my-secret',
  parseOptions: {}
})

fastify.ready(() => {
  fastify.hasPlugin('@fastify/cookie') // true
})
```

#### listeningOrigin
<a id="listeningOrigin"></a>

Der aktuelle Origin, auf den der Server lauscht.
Ein auf einem TCP-Socket basierender Server gibt zum Beispiel
eine Basisadresse wie `http://127.0.0.1:3000` zurück,
und ein Unix-Socket-Server gibt den Socket-Pfad zurück,
z. B. `fastify.temp.sock`.

#### log
<a id="log"></a>

Die Logger-Instanz; siehe [hier](./Logging.md).

#### version
<a id="version"></a>

Fastify-Version der Instanz. Wird für die Plugin-Unterstützung verwendet.
Informationen dazu, wie die Version von Plugins verwendet wird, finden Sie unter
[Plugins](./Plugins.md#handle-the-scope).

#### inject
<a id="inject"></a>

Simulierte HTTP-Injektion (zu Testzwecken)
[hier](../Guides/Testing.md#benefits-of-using-fastifyinject).

#### addHttpMethod
<a id="addHttpMethod"></a>

Fastify unterstützt standardmäßig die HTTP-Methoden `GET`, `HEAD`, `TRACE`,
`DELETE`, `OPTIONS`, `PATCH`, `PUT`, `POST` und `QUERY`.
Die Methode `addHttpMethod` erlaubt es, dem Server beliebige nicht standardisierte
HTTP-Methoden hinzuzufügen, die [von Node.js unterstützt werden](https://nodejs.org/api/http.html#httpmethods).

Die Methode akzeptiert ein optionales Konfigurationsobjekt:

| Eigenschaft | Typ | Standard | Beschreibung |
| -------- | ---- | ------- | ----------- |
| `hasBody` | `boolean` | `false` | Ob die Methode einen Request-Body akzeptiert. |
| `overrideExisting` | `boolean` | `false` | Ob eine bestehende Methode ausdrücklich überschrieben werden soll. |

```js
// Add a new HTTP method called 'MKCOL' that supports a request body
fastify.addHttpMethod('MKCOL', { hasBody: true,  })

// Add a new HTTP method called 'COPY' that does not support a request body
fastify.addHttpMethod('COPY')
```

Nach dem Aufruf von `addHttpMethod` ist es möglich, die Kurzformmethoden für Routes
zu verwenden, um Routes für die neue HTTP-Methode zu definieren:

```js
fastify.addHttpMethod('MKCOL', { hasBody: true })
fastify.mkcol('/', (req, reply) => {
  // Handle the 'MKCOL' request
})
```

Der Aufruf von `addHttpMethod` für eine bestehende Methode überschreibt deren
Body-Verhalten.

```js
fastify.addHttpMethod('GET', {
  hasBody: true,
  overrideExisting: true
})
```

In Fastify v5 führt das Weglassen von `overrideExisting: true` zu `FSTDEP025`; in
Fastify v6 wird es einen Fehler werfen.

#### addSchema
<a id="add-schema"></a>

`fastify.addSchema(schemaObj)` fügt der Fastify-Instanz ein JSON-Schema hinzu. So
können Sie es überall in Ihrer Anwendung einfach über das übliche Schlüsselwort
`$ref` wiederverwenden.

Mehr dazu erfahren Sie in der Dokumentation
[Validation and Serialization](./Validation-and-Serialization.md).

#### getSchemas
<a id="get-schemas"></a>

`fastify.getSchemas()` gibt einen Hash aller über `.addSchema` hinzugefügten
Schemata zurück. Die Schlüssel des Hashs sind die `$id`s der bereitgestellten
JSON-Schemata.

#### getSchema
<a id="get-schema"></a>

`fastify.getSchema(id)` gibt das mit `.addSchema` hinzugefügte JSON-Schema mit der
passenden `id` zurück. Wird es nicht gefunden, gibt es `undefined` zurück.

#### setReplySerializer
<a id="set-reply-serializer"></a>

Setzt den Reply-Serializer für alle Routes. Er wird als Standard verwendet, wenn
kein [Reply.serializer(func)](./Reply.md#serializerfunc) gesetzt wurde. Der Handler
ist vollständig gekapselt, sodass verschiedene Plugins verschiedene Error-Handler
setzen können. Hinweis: Der Funktionsparameter wird nur bei Status `2xx` aufgerufen.
Für Fehler siehe [`setErrorHandler`](#seterrorhandler).

```js
fastify.setReplySerializer(function (payload, statusCode){
  // serialize the payload with a sync function
  return `my serialized ${statusCode} content: ${payload}`
})
```

#### setValidatorCompiler
<a id="set-validator-compiler"></a>

Setzt den Schema-Validator-Compiler für alle Routes. Siehe
[#schema-validator](./Validation-and-Serialization.md#schema-validator).

#### setSchemaErrorFormatter
<a id="set-schema-error-formatter"></a>

Setzt den Schema-Error-Formatter für alle Routes. Siehe
[#error-handling](./Validation-and-Serialization.md#schemaerrorformatter).

#### setSerializerCompiler
<a id="set-serializer-resolver"></a>

Setzt den Schema-Serializer-Compiler für alle Routes. Siehe
[#schema-serializer](./Validation-and-Serialization.md#schema-serializer).

> ℹ️ Hinweis:
> [`setReplySerializer`](#set-reply-serializer) hat Vorrang, wenn es gesetzt ist!

#### validatorCompiler
<a id="validator-compiler"></a>

Über diese Eigenschaft lässt sich der Schema-Validator abrufen. Ist sie nicht
gesetzt, ist sie bis zum Serverstart `null`; danach ist sie eine Funktion mit der
Signatur `function ({ schema, method, url, httpPart })`, die das übergebene `schema`
zu einer Funktion zum Validieren von Daten kompiliert zurückgibt. Das übergebene
`schema` kann auf alle geteilten Schemata zugreifen, die mit der Funktion
[`.addSchema`](#add-schema) hinzugefügt wurden.

#### serializerCompiler
<a id="serializer-compiler"></a>

Über diese Eigenschaft lässt sich der Schema-Serializer abrufen. Ist sie nicht
gesetzt, ist sie bis zum Serverstart `null`; danach ist sie eine Funktion mit der
Signatur `function ({ schema, method, url, httpPart })`, die das übergebene `schema`
zu einer Funktion zum Validieren von Daten kompiliert zurückgibt. Das übergebene
`schema` kann auf alle geteilten Schemata zugreifen, die mit der Funktion
[`.addSchema`](#add-schema) hinzugefügt wurden.

#### schemaErrorFormatter
<a id="schema-error-formatter"></a>

Über diese Eigenschaft lässt sich eine Funktion setzen, um Fehler zu formatieren, die

auftreten, während der `validationCompiler` das Schema nicht validieren kann. Siehe
[#error-handling](./Validation-and-Serialization.md#schemaerrorformatter).

#### schemaController
<a id="schema-controller"></a>

Über diese Eigenschaft lässt sich Folgendes vollständig verwalten:
- `bucket`: wo die Schemata Ihrer Anwendung gespeichert werden
- `compilersFactory`: welches Modul die JSON-Schemata kompilieren muss

Das kann nützlich sein, wenn Ihre Schemata in einer anderen Datenstruktur gespeichert
sind, die Fastify unbekannt ist.

Ein weiterer Anwendungsfall ist die Feinjustierung der gesamten Schemaverarbeitung.
Damit ist es möglich, Ajv v8 JTD oder die Standalone-Funktion zu verwenden. Um JTD
oder den Standalone-Modus zu nutzen, siehe die [Dokumentation zu
`@fastify/ajv-compiler`](https://github.com/fastify/ajv-compiler#usage).

```js
const fastify = Fastify({
  schemaController: {
    /**
     * This factory is called whenever `fastify.register()` is called.
     * It may receive as input the schemas of the parent context if some schemas have been added.
     * @param {object} parentSchemas these schemas will be returned by the
     * `getSchemas()` method function of the returned `bucket`.
     */
    bucket: function factory (parentSchemas) {
      return {
        add (inputSchema) {
          // This function must store the schema added by the user.
          // This function is invoked when `fastify.addSchema()` is called.
        },
        getSchema (schema$id) {
          // This function must return the raw schema requested by the `schema$id`.
          // This function is invoked when `fastify.getSchema(id)` is called.
          return aSchema
        },
        getSchemas () {
          // This function must return all the schemas referenced by the routes schemas' $ref
          // It must return a JSON where the property is the schema `$id` and the value is the raw JSON Schema.
          const allTheSchemaStored = {
            'schema$id1': schema1,
            'schema$id2': schema2
          }
          return allTheSchemaStored
        }
      }
    },

    /**
     * The compilers factory lets you fully control the validator and serializer
     * in the Fastify's lifecycle, providing the encapsulation to your compilers.
     */
    compilersFactory: {
      /**
       * This factory is called whenever a new validator instance is needed.
       * It may be called whenever `fastify.register()` is called only if new schemas have been added to the
       * encapsulation context.
       * It may receive as input the schemas of the parent context if some schemas have been added.
       * @param {object} externalSchemas these schemas will be returned by the
       * `bucket.getSchemas()`. Needed to resolve the external references $ref.
       * @param {object} ajvServerOption the server `ajv` options to build your compilers accordingly
       */
      buildValidator: function factory (externalSchemas, ajvServerOption) {
        // This factory function must return a schema validator compiler.
        // See [#schema-validator](./Validation-and-Serialization.md#schema-validator) for details.
        const yourAjvInstance = new Ajv(ajvServerOption.customOptions)
        return function validatorCompiler ({ schema, method, url, httpPart }) {
          return yourAjvInstance.compile(schema)
        }
      },

      /**
       * This factory is called whenever a new serializer instance is needed.
       * It may be called whenever `fastify.register()` is called only if new schemas have been added to the
       * encapsulation context.
       * It may receive as input the schemas of the parent context if some schemas have been added.
       * @param {object} externalSchemas these schemas will be returned by the
       * `bucket.getSchemas()`. Needed to resolve the external references $ref.
       * @param {object} serializerOptsServerOption the server `serializerOpts`
       * options to build your compilers accordingly
       */
      buildSerializer: function factory (externalSchemas, serializerOptsServerOption) {
        // This factory function must return a schema serializer compiler.
        // See [#schema-serializer](./Validation-and-Serialization.md#schema-serializer) for details.
        return function serializerCompiler ({ schema, method, url, httpStatus, contentType }) {
          return data => JSON.stringify(data)
        }
      }
    }
  }
});
```

#### setNotFoundHandler
<a id="set-not-found-handler"></a>

`fastify.setNotFoundHandler(handler(request, reply))`: Setzt den 404-Handler. Dieser
Aufruf wird nach Präfix gekapselt, sodass verschiedene Plugins verschiedene
Not-Found-Handler setzen können, wenn `fastify.register()` eine andere
[`prefix`-Option](./Plugins.md#route-prefixing-option) übergeben wird. Der Handler
wird wie ein gewöhnlicher Route-Handler behandelt, sodass Requests für nicht
existierende URLs den vollständigen
[Fastify-Lebenszyklus](./Lifecycle.md#lifecycle) durchlaufen.
*async-await* wird ebenfalls unterstützt.
Fehlerhaft formatierte URLs werden stattdessen an den
[`onBadUrl`](#onbadurl)-Handler gesendet.

Sie können für den 404-Handler auch [`preValidation`](./Hooks.md#route-hooks)- und
[`preHandler`](./Hooks.md#route-hooks)-Hooks registrieren.

> ℹ️ Hinweis:
> Der mit dieser Methode registrierte `preValidation`-Hook läuft für eine
> Route, die Fastify nicht kennt, und **nicht**, wenn ein Route-Handler manuell
> [`reply.callNotFound`](./Reply.md#call-not-found) aufruft. In diesem Fall läuft nur
> preHandler.


```js
fastify.setNotFoundHandler({
  preValidation: (req, reply, done) => {
    // your code
    done()
  },
  preHandler: (req, reply, done) => {
    // your code
    done()
  }
}, function (request, reply) {
    // Default not found handler with preValidation and preHandler hooks
})

fastify.register(function (instance, options, done) {
  instance.setNotFoundHandler(function (request, reply) {
    // Handle not found request without preValidation and preHandler hooks
    // to URLs that begin with '/v1'
  })
  done()
}, { prefix: '/v1' })
```

Fastify ruft setNotFoundHandler beim Start auf, um vor dem Registrieren der Plugins
einen Standard-404-Handler hinzuzufügen. Wenn Sie das Verhalten des
Standard-404-Handlers erweitern möchten, zum Beispiel mit Plugins, können Sie
setNotFoundHandler ohne Argumente – `fastify.setNotFoundHandler()` – im Kontext
dieser registrierten Plugins aufrufen.

> ℹ️ Hinweis:
> Einige Konfigurationseigenschaften des Request-Objekts sind innerhalb des eigenen
> Not-Found-Handlers undefined. Zum Beispiel:
> `request.routeOptions.url`, `routeOptions.method` und `routeOptions.config`.
> Ziel des Entwurfs dieser Methode ist es, den Aufruf der gemeinsamen
> Not-Found-Route zu ermöglichen.
> Um eine pro Route angepasste 404-Antwort zurückzugeben, können Sie das in der
> Antwort selbst tun.

#### setErrorHandler
<a id="set-error-handler"></a>

`fastify.setErrorHandler(handler(error, request, reply))`: Setzt eine Funktion, die
aufgerufen wird, wann immer während des Request-Lebenszyklus eine Exception geworfen
wird. Der Handler ist an die Fastify-Instanz gebunden und vollständig gekapselt,
sodass verschiedene Plugins verschiedene Error-Handler setzen können. *async-await*
wird ebenfalls unterstützt.

Ist der `statusCode` des Fehlers kleiner als 400, setzt Fastify ihn automatisch auf
500, bevor der Error-Handler aufgerufen wird.

`setErrorHandler` fängt ***nicht***:
- Exceptions, die in einem `onResponse`-Hook geworfen werden, weil die Response
  bereits an den Client gesendet wurde. Verwenden Sie stattdessen den
  `onSend`-Hook.
- Not-Found-Fehler (404). Verwenden Sie stattdessen
  [`setNotFoundHandler`](#set-not-found-handler).
- Stream-Fehler, die beim Weiterleiten in den Response-Socket geworfen werden, da
  Header/Response bereits an den Client gesendet wurden.
  Verwenden Sie eigene Daten im Stream, um solche Fehler zu signalisieren.

```js
fastify.setErrorHandler(function (error, request, reply) {
  // Log error
  this.log.error(error)
  // Send error response
  reply.status(409).send({ ok: false })
})
```

Fastify bringt eine Standardfunktion mit, die aufgerufen wird, wenn kein
Error-Handler gesetzt ist. Sie ist über `fastify.errorHandler` zugänglich und loggt
den Fehler entsprechend seinem `statusCode`.

```js
const statusCode = error.statusCode
if (statusCode >= 500) {
  log.error(error)
} else if (statusCode >= 400) {
  log.info(error)
} else {
  log.error(error)
}
```

> ⚠ Warnung:
> Vermeiden Sie es, setErrorHandler im selben Scope mehrfach aufzurufen.
> Siehe [`allowErrorHandlerOverride`](#allowerrorhandleroverride).

##### Eigener Error-Handler für Stream-Antworten
<a id="set-error-handler-stream-replies"></a>

Unterscheidet sich der `Content-Type` zwischen Endpunkt und Error-Handler, definieren
Sie ihn in beiden ausdrücklich. Gibt der Endpunkt zum Beispiel einen
`application/text`-Stream zurück und antwortet der Error-Handler mit
`application/json`, muss der Error-Handler den `Content-Type` ausdrücklich setzen.
Andernfalls schlägt die Serialisierung mit dem Statuscode `500` fehl. Alternativ
antworten Sie im Error-Handler immer mit serialisierten Daten, indem Sie manuell eine
Serialisierungsmethode aufrufen (z. B. `JSON.stringify`).

```js
fastify.setErrorHandler((err, req, reply) => {
  reply
    .code(400)
    .type('application/json')
    .send({ error: err.message })
})
```

```js
fastify.setErrorHandler((err, req, reply) => {
  reply
    .code(400)
    .send(JSON.stringify({ error: err.message }))
})
```

#### setChildLoggerFactory
<a id="set-child-logger-factory"></a>

`fastify.setChildLoggerFactory(factory(logger, bindings, opts, rawReq))`: Setzt eine
Funktion, die beim Erzeugen einer Child-Logger-Instanz für jeden Request aufgerufen
wird und es erlaubt, Bindings und Logger-Optionen des Child-Loggers zu verändern oder
zu ergänzen oder eine eigene Child-Logger-Implementierung zurückzugeben.

Bindings des Child-Loggers haben einen Performance-Vorteil gegenüber Bindings pro
Log-Eintrag, weil sie von Pino beim Erzeugen des Child-Loggers vorserialisiert
werden.

Der erste Parameter ist die übergeordnete Logger-Instanz, gefolgt von den
Standard-Bindings und Logger-Optionen, die an den Child-Logger übergeben werden
sollen, und schließlich dem rohen Request (kein Fastify-Request-Objekt). Die Funktion
ist so gebunden, dass `this` die Fastify-Instanz ist.

Zum Beispiel:
```js
const fastify = require('fastify')({
  childLoggerFactory: function (logger, bindings, opts, rawReq) {
    // Calculate additional bindings from the request if needed
    bindings.traceContext = rawReq.headers['x-cloud-trace-context']
    return logger.child(bindings, opts)
  }
})
```

Der Handler ist an die Fastify-Instanz gebunden und vollständig gekapselt, sodass
verschiedene Plugins verschiedene Logger-Factories setzen können.

#### setgenreqid
<a id="set-gen-req-id"></a>

`fastify.setGenReqId(function (rawReq))` Synchrone Funktion zum Setzen der
Request-ID für zusätzliche Fastify-Instanzen. Sie erhält den _rohen_ eingehenden
Request als Parameter. Die bereitgestellte Funktion sollte auf keinen Fall einen
Error werfen.

Besonders in verteilten Systemen möchten Sie das Standardverhalten der ID-Erzeugung
vielleicht überschreiben, um eigene Wege zur Erzeugung unterschiedlicher IDs für
verschiedene Anwendungsfälle abzudecken, etwa für Observability- oder
Webhook-Plugins.

Zum Beispiel:
```js
const fastify = require('fastify')({
  genReqId: (req) => {
    return 'base'
  }
})

fastify.register((instance, opts, done) => {
  instance.setGenReqId((req) => {
    // custom request ID for `/webhooks`
    return 'webhooks-id'
  })
  done()
}, { prefix: '/webhooks' })

fastify.register((instance, opts, done) => {
  instance.setGenReqId((req) => {
    // custom request ID for `/observability`
    return 'observability-id'
  })
  done()
}, { prefix: '/observability' })
```

Der Handler ist an die Fastify-Instanz gebunden und vollständig gekapselt, sodass
verschiedene Plugins eine unterschiedliche Request-ID setzen können.

#### addConstraintStrategy
<a id="addConstraintStrategy"></a>

Funktion zum Hinzufügen einer eigenen Constraint-Strategie. Um einen neuen Typ von
Constraint zu registrieren, müssen Sie eine neue Constraint-Strategie hinzufügen, die
weiß, wie Werte auf Handler abzubilden sind und wie der Constraint-Wert aus einem
Request zu ermitteln ist.

Fügen Sie eine eigene Constraint-Strategie mit der Methode
`fastify.addConstraintStrategy` hinzu:

```js
const customResponseTypeStrategy = {
  // strategy name for referencing in the route handler `constraints` options
  name: 'accept',
  // storage factory for storing routes in the find-my-way route tree
  storage: function () {
    let handlers = {}
    return {
      get: (type) => { return handlers[type] || null },
      set: (type, store) => { handlers[type] = store }
    }
  },
  // function to get the value of the constraint from each incoming request
  deriveConstraint: (req, ctx) => {
    return req.headers['accept']
  },
  // optional flag marking if handlers without constraints can match requests that have a value for this constraint
  mustMatchWhenDerived: true
}

const router = Fastify();
router.addConstraintStrategy(customResponseTypeStrategy);
```

#### hasConstraintStrategy
<a id="hasConstraintStrategy"></a>

`fastify.hasConstraintStrategy(strategyName)` prüft, ob bereits eine eigene
Constraint-Strategie mit demselben Namen existiert.

#### printRoutes
<a id="print-routes"></a>

`fastify.printRoutes()`: Fastifys Router baut für jede HTTP-Methode einen Baum von
Routes auf. Rufen Sie prettyPrint ohne Angabe einer HTTP-Methode auf, werden alle
Bäume zu einem zusammengeführt und ausgegeben. Der zusammengeführte Baum stellt nicht
die interne Router-Struktur dar. **Verwenden Sie ihn nicht zum Debuggen.**

*Denken Sie daran, ihn innerhalb oder nach einem `ready`-Aufruf aufzurufen.*

```js
fastify.get('/test', () => {})
fastify.get('/test/hello', () => {})
fastify.get('/testing', () => {})
fastify.get('/testing/:param', () => {})
fastify.put('/update', () => {})

fastify.ready(() => {
  console.log(fastify.printRoutes())
  // └── /
  //     ├── test (GET)
  //     │   ├── /hello (GET)
  //     │   └── ing (GET)
  //     │       └── /
  //     │           └── :param (GET)
  //     └── update (PUT)
})
```

Wenn Sie den internen Router-Baum ausgeben möchten, sollten Sie den Parameter
`method` angeben. Der ausgegebene Baum stellt dann die interne Router-Struktur dar.
**Sie können ihn zum Debuggen verwenden.**

```js
  console.log(fastify.printRoutes({ method: 'GET' }))
  // └── /
  //     └── test (GET)
  //         ├── /hello (GET)
  //         └── ing (GET)
  //             └── /
  //                 └── :param (GET)

  console.log(fastify.printRoutes({ method: 'PUT' }))
  // └── /
  //     └── update (PUT)
```

`fastify.printRoutes({ commonPrefix: false })` gibt komprimierte Bäume aus. Das kann
nützlich sein, wenn Sie eine große Zahl von Routes mit gemeinsamen Präfixen haben.
Es stellt nicht die interne Router-Struktur dar. **Verwenden Sie es nicht zum Debuggen.**

```js
  console.log(fastify.printRoutes({ commonPrefix: false }))
  // ├── /test (GET)
  // │   ├── /hello (GET)
  // │   └── ing (GET)
  // │       └── /:param (GET)
  // └── /update (PUT)
```

`fastify.printRoutes({ includeMeta: (true | []) })` zeigt für jede ausgegebene Route
Eigenschaften aus dem `route.store`-Objekt an. Das kann ein `array` von Schlüsseln
sein (z. B. `['onRequest', Symbol('key')]`) oder `true`, um alle Eigenschaften
anzuzeigen. Als Kurzform bindet `fastify.printRoutes({ includeHooks: true })` alle
[Hooks](./Hooks.md) ein.

```js
  fastify.get('/test', () => {})
  fastify.get('/test/hello', () => {})

  const onTimeout = () => {}

  fastify.addHook('onRequest', () => {})
  fastify.addHook('onTimeout', onTimeout)

  console.log(fastify.printRoutes({ includeHooks: true, includeMeta: ['errorHandler'] }))
  // └── /
  //     └── test (GET)
  //         • (onTimeout) ["onTimeout()"]
  //         • (onRequest) ["anonymous()"]
  //         • (errorHandler) "defaultErrorHandler()"
  //         test (HEAD)
  //         • (onTimeout) ["onTimeout()"]
  //         • (onRequest) ["anonymous()"]
  //         • (onSend) ["headRouteOnSendHandler()"]
  //         • (errorHandler) "defaultErrorHandler()"
  //         └── /hello (GET)
  //             • (onTimeout) ["onTimeout()"]
  //             • (onRequest) ["anonymous()"]
  //             • (errorHandler) "defaultErrorHandler()"
  //             /hello (HEAD)
  //             • (onTimeout) ["onTimeout()"]
  //             • (onRequest) ["anonymous()"]
  //             • (onSend) ["headRouteOnSendHandler()"]
  //             • (errorHandler) "defaultErrorHandler()"

  console.log(fastify.printRoutes({ includeHooks: true }))
  // └── /
  //     └── test (GET)
  //         • (onTimeout) ["onTimeout()"]
  //         • (onRequest) ["anonymous()"]
  //         test (HEAD)
  //         • (onTimeout) ["onTimeout()"]
  //         • (onRequest) ["anonymous()"]
  //         • (onSend) ["headRouteOnSendHandler()"]
  //         └── /hello (GET)
  //             • (onTimeout) ["onTimeout()"]
  //             • (onRequest) ["anonymous()"]
  //             /hello (HEAD)
  //             • (onTimeout) ["onTimeout()"]
  //             • (onRequest) ["anonymous()"]
  //             • (onSend) ["headRouteOnSendHandler()"]
```

#### printPlugins
<a id="print-plugins"></a>

`fastify.printPlugins()`: Gibt die Darstellung des internen, von avvio verwendeten
Plugin-Baums aus; nützlich zum Debuggen von Problemen mit der require-Reihenfolge.

*Denken Sie daran, es innerhalb oder nach einem `ready`-Aufruf aufzurufen.*

```js
fastify.register(async function foo (instance) {
  instance.register(async function bar () {})
})
fastify.register(async function baz () {})

fastify.ready(() => {
  console.error(fastify.printPlugins())
  // will output the following to stderr:
  // └── root
  //     ├── foo
  //     │   └── bar
  //     └── baz
})
```

#### addContentTypeParser
<a id="addContentTypeParser"></a>

`fastify.addContentTypeParser(content-type, options, parser)` wird verwendet, um
einen eigenen Parser für einen bestimmten Content-Type zu übergeben. Nützlich, um
Parser für eigene Content-Types hinzuzufügen, z. B. `text/json,
application/vnd.oasis.opendocument.text`.
`content-type` kann eine Zeichenkette, ein Zeichenketten-Array oder ein RegExp sein.

```js
// The two arguments passed to getDefaultJsonParser are for ProtoType poisoning
// and Constructor Poisoning configuration respectively. The possible values are
// 'ignore', 'remove', 'error'. ignore  skips all validations and it is similar
// to calling JSON.parse() directly. See the
// [`secure-json-parse` documentation](https://github.com/fastify/secure-json-parse#api) for more information.

fastify.addContentTypeParser('text/json', { asString: true }, fastify.getDefaultJsonParser('ignore', 'ignore'))
```

#### hasContentTypeParser
<a id="hasContentTypeParser"></a>

`fastify.hasContentTypeParser(contentType)` wird verwendet, um zu prüfen, ob im
aktuellen Kontext ein Content-Type-Parser für den angegebenen Content-Type existiert.

```js
fastify.hasContentTypeParser('text/json')

fastify.hasContentTypeParser(/^.+\/json$/)
```

#### removeContentTypeParser
<a id="removeContentTypeParser"></a>

`fastify.removeContentTypeParser(contentType)` wird verwendet, um
Content-Type-Parser im aktuellen Kontext zu entfernen. Diese Methode erlaubt es zum
Beispiel, beide eingebauten Parser für `application/json` und `text/plain` zu
entfernen.

```js
fastify.removeContentTypeParser('application/json')

fastify.removeContentTypeParser(['application/json', 'text/plain'])
```

#### removeAllContentTypeParsers
<a id="removeAllContentTypeParsers"></a>

Die Methode `fastify.removeAllContentTypeParsers()` erlaubt es, alle
Content-Type-Parser im aktuellen Kontext zu entfernen. Ein Anwendungsfall dieser
Methode ist die Umsetzung eines Catch-all-Content-Type-Parsers. Vor dem Hinzufügen
dieses Parsers mit `fastify.addContentTypeParser()` könnte man die Methode
`removeAllContentTypeParsers` aufrufen.

Weitere Einzelheiten zur Verwendung der verschiedenen Content-Type-Parser-APIs finden
Sie [hier](./ContentTypeParser.md#usage).

#### getDefaultJsonParser
<a id="getDefaultJsonParser"></a>

`fastify.getDefaultJsonParser(onProtoPoisoning, onConstructorPoisoning)` nimmt zwei
Argumente entgegen. Das erste Argument ist die Konfiguration für Prototype Poisoning,
das zweite Argument die Konfiguration für Constructor Poisoning. Weitere
Informationen finden Sie in der [Dokumentation zu
`secure-json-parse`](https://github.com/fastify/secure-json-parse#api).


#### defaultTextParser
<a id="defaultTextParser"></a>

`fastify.defaultTextParser()` kann verwendet werden, um Inhalt als reinen Text zu
parsen.

```js
fastify.addContentTypeParser('text/json', { asString: true }, fastify.defaultTextParser)
```

#### errorHandler
<a id="errorHandler"></a>

`fastify.errorHandler` kann verwendet werden, um Fehler mit Fastifys
Standard-Error-Handler zu behandeln.

```js
fastify.get('/', {
  errorHandler: (error, request, reply) => {
    if (error.code === 'SOMETHING_SPECIFIC') {
      reply.send({ custom: 'response' })
      return
    }

    fastify.errorHandler(error, request, reply)
  }
}, handler)
```

#### childLoggerFactory
<a id="childLoggerFactory"></a>

`fastify.childLoggerFactory` gibt die eigene Logger-Factory-Funktion der
Fastify-Instanz zurück. Weitere Informationen finden Sie bei der
[Konfigurationsoption `childLoggerFactory`](#setchildloggerfactory).

#### Symbol.asyncDispose
<a id="symbolAsyncDispose"></a>

`fastify[Symbol.asyncDispose]` ist ein Symbol, mit dem sich eine asynchrone Funktion
definieren lässt, die aufgerufen wird, wenn die Fastify-Instanz geschlossen wird.

Es wird häufig zusammen mit dem TypeScript-Schlüsselwort `using` verwendet, um
sicherzustellen, dass Ressourcen aufgeräumt werden, wenn die Fastify-Instanz
geschlossen wird.

Das passt hervorragend in kurzlebige Prozesse oder Unit-Tests, in denen Sie alle
Fastify-Ressourcen schließen müssen, nachdem Sie aus der Funktion zurückgekehrt sind.

```ts
test('Uses app and closes it afterwards', async () => {
  await using app = fastify();
  // do something with app.
})
```

Im obigen Beispiel wird Fastify nach dem Ende des Tests automatisch geschlossen.

Lesen Sie mehr über
[ECMAScript Explicit Resource Management](https://tc39.es/proposal-explicit-resource-management/)
und das [Schlüsselwort using](https://devblogs.microsoft.com/typescript/announcing-typescript-5-2/),
das in TypeScript 5.2 eingeführt wurde.

#### initialConfig
<a id="initial-config"></a>

`fastify.initialConfig`: Stellt ein eingefrorenes, schreibgeschütztes Objekt bereit,
das die anfänglichen Optionen festhält, die der Anwender an die Fastify-Instanz
übergeben hat.

Die Eigenschaften, die derzeit bereitgestellt werden können, sind:
- connectionTimeout
- keepAliveTimeout
- handlerTimeout
- bodyLimit
- caseSensitive
- http2
- https (gibt `false`/`true` oder `{ allowHTTP1: true/false }` zurück, sofern
  ausdrücklich übergeben)
- disableRequestLogging
- onProtoPoisoning
- onConstructorPoisoning
- pluginTimeout
- requestIdHeader
- requestIdLogLabel
- http2SessionTimeout
- routerOptions
  - allowUnsafeRegex
  - buildPrettyMeta
  - caseSensitive
  - constraints
  - defaultRoute
  - ignoreDuplicateSlashes
  - ignoreTrailingSlash
  - maxParamLength
  - onBadUrl
  - querystringParser
  - useSemicolonDelimiter

```js
const { readFileSync } = require('node:fs')
const Fastify = require('fastify')

const fastify = Fastify({
  https: {
    allowHTTP1: true,
    key: readFileSync('./fastify.key'),
    cert: readFileSync('./fastify.cert')
  },
  logger: { level: 'trace'},
  routerOptions: {
    ignoreTrailingSlash: true,
    maxParamLength: 200,
    caseSensitive: true,
  },
  trustProxy: '127.0.0.1,192.168.1.1/24',
})

console.log(fastify.initialConfig)
/*
will log :
{
  https: { allowHTTP1: true },
  routerOptions: {
    caseSensitive: true,
    ignoreTrailingSlash: true,
    maxParamLength: 200
  }
}
*/

fastify.register(async (instance, opts) => {
  instance.get('/', async (request, reply) => {
    return instance.initialConfig
    /*
    will return :
    {
      https: { allowHTTP1: true },
      routerOptions: {
        caseSensitive: true,
        ignoreTrailingSlash: true,
        maxParamLength: 200
      }
    }
    */
  })

  instance.get('/error', async (request, reply) => {
    // will throw an error because initialConfig is read-only
    // and can not be modified
    instance.initialConfig.https.allowHTTP1 = false

    return instance.initialConfig
  })
})

// Start listening.
fastify.listen({ port: 3000 }, (err) => {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```
