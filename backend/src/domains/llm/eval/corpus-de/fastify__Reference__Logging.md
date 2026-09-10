<h1 align="center">Fastify</h1>

## Logging

### Logging aktivieren
Logging ist standardmäßig deaktiviert. Aktivieren Sie es, indem Sie beim Erzeugen
einer Fastify-Instanz `{ logger: true }` oder `{ logger: { level: 'info' } }`
übergeben. Beachten Sie: Ist der Logger deaktiviert, kann er zur Laufzeit nicht
mehr aktiviert werden. Zu diesem Zweck wird
[abstract-logging](https://www.npmjs.com/package/abstract-logging) verwendet.

Da Fastify auf Performance ausgerichtet ist, nutzt es
[pino](https://github.com/pinojs/pino) als Logger, wobei der Standard-Log-Level
im aktivierten Zustand auf `'info'` gesetzt ist.

Der Log-Level lässt sich pro Route setzen. Siehe [die
Routen-Dokumentation](./Routes.md#custom-log-level).

#### Grundlegende Logging-Einrichtung
Das Folgende aktiviert den JSON-Logger für die Produktion:

```js
const fastify = require('fastify')({
  logger: true
})
```

#### Umgebungsspezifische Konfiguration
Den Logger für lokale Entwicklung sowie Produktions- und Testumgebungen zu
aktivieren erfordert zusätzliche Konfiguration:

```js
const envToLogger = {
  development: {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
  production: true,
  test: false,
}
const fastify = require('fastify')({
  logger: envToLogger[environment] ?? true // defaults to true if no matching environment is found
})
```

> ⚠ Warnung:
> `pino-pretty` muss als Dev-Dependency installiert werden. Aus Performance-Gründen
> ist es standardmäßig nicht enthalten.

### Verwendung
Der Logger kann in Route-Handlern wie folgt verwendet werden:

```js
fastify.get('/', options, function (request, reply) {
  request.log.info('Some info about the current request')
  reply.send({ hello: 'world' })
})
```

Um außerhalb von Route-Handlern zu loggen, verwenden Sie den Logger, der auf der
Fastify-Instanz verfügbar ist:

```js
fastify.log.info('Something important happened!')
```

#### Logger-Optionen übergeben
Um Optionen an den Logger zu übergeben, reichen Sie diese an Fastify weiter. Die
vollständige Liste der verfügbaren Optionen finden Sie in der
[Pino-Dokumentation](https://github.com/pinojs/pino/blob/main/docs/api.md#options).
Um ein Dateiziel anzugeben, verwenden Sie:

```js
const fastify = require('fastify')({
  logger: {
    level: 'info',
    file: '/path/to/file' // Uses pino.destination()
  }
})

fastify.get('/', options, function (request, reply) {
  request.log.info('Some info about the current request')
  reply.send({ hello: 'world' })
})
```

Um einen eigenen Stream an die Pino-Instanz zu übergeben, fügen Sie dem
Logger-Objekt ein Feld `stream` hinzu:

```js
const split = require('split2')
const stream = split(JSON.parse)

const fastify = require('fastify')({
  logger: {
    level: 'info',
    stream: stream
  }
})
```

### Fortgeschrittene Logger-Konfiguration

<a id="logging-request-id"></a>
#### Request-ID-Tracking
Standardmäßig fügt Fastify jedem Request eine ID hinzu, um die Nachverfolgung zu
erleichtern. Ist die Option `requestIdHeader` gesetzt und der entsprechende Header
vorhanden, wird dessen Wert verwendet; andernfalls wird eine neue, inkrementelle ID
erzeugt. Möglichkeiten zur Anpassung finden Sie bei den Factory-Optionen
[`requestIdHeader`](./Server.md#factory-request-id-header) und
[`genReqId`](./Server.md#genreqid) von Fastify.

> ⚠ Warnung:
> Das Aktivieren von `requestIdHeader` erlaubt es Aufrufern, `reqId` auf einen
> beliebigen Wert zu setzen. Der Header-Wert wird nicht validiert.

#### Serializer
Der Standard-Logger verwendet Standard-Serializer für Objekte mit den
Eigenschaften `req`, `res` und `err`. Das `req`-Objekt ist das Fastify-Objekt
[`Request`](./Request.md), das `res`-Objekt das Fastify-Objekt
[`Reply`](./Reply.md). Dieses Verhalten lässt sich mit eigenen Serializern
überschreiben.

```js
const fastify = require('fastify')({
  logger: {
    serializers: {
      req (request) {
        return { url: request.url }
      }
    }
  }
})
```

> ⚠ Warnung:
> Das Loggen von Response-Headern kann sensible Daten offenlegen, einschließlich
> Authentifizierungsdaten, und Datenschutzvorschriften verletzen.
> Verwenden Sie [Log-Redaction](#log-redaction), um sensible Informationen zu entfernen.
> Das folgende Beispiel dient ausschließlich der Veranschaulichung:

```js
const fastify = require('fastify')({
  logger: {
    transport: {
      target: 'pino-pretty'
    },
    serializers: {
      res (reply) {
        // The default
        return {
          statusCode: reply.statusCode
        }
      },
      req (request) {
        return {
          method: request.method,
          url: request.url,
          path: request.routeOptions.url,
          parameters: request.params,
          headers: request.headers
        }
      }
    }
  }
})
```

> ℹ️ Hinweis:
> In manchen Fällen kann das an den `res`-Serializer übergebene Objekt
> [`Reply`](./Reply.md) nicht vollständig konstruiert werden. Prüfen Sie beim
> Schreiben eines eigenen `res`-Serializers, ob andere Eigenschaften als
> `statusCode` auf `reply` existieren, bevor Sie darauf zugreifen. Prüfen Sie
> zum Beispiel die Existenz von `getHeaders`, bevor Sie es aufrufen:

```js
const fastify = require('fastify')({
  logger: {
    transport: {
      target: 'pino-pretty'
    },
    serializers: {
      res (reply) {
        // The default
        return {
          statusCode: reply.statusCode,
          headers: typeof reply.getHeaders === 'function'
            ? reply.getHeaders()
            : {}
        }
      },
    }
  }
})
```

> ℹ️ Hinweis:
> Der Body kann innerhalb des `req`-Serializers nicht serialisiert werden, weil der
> Request beim Erzeugen des Child-Loggers serialisiert wird. Zu diesem Zeitpunkt ist
> der Body noch nicht geparst.

Um `req.body` zu loggen, verwenden Sie den `preHandler`-Hook:

```js
app.addHook('preHandler', function (req, reply, done) {
  if (req.body) {
    req.log.info({ body: req.body }, 'parsed body')
  }
  done()
})
```

> ℹ️ Hinweis:
> Stellen Sie sicher, dass Serializer niemals Fehler werfen, da dies den
> Node.js-Prozess beenden kann. Weitere Informationen finden Sie in der
> [Pino-Dokumentation](https://getpino.io/#/docs/api?id=opt-serializers).

*Jeder andere Logger als Pino ignoriert die Option `serializers`.*

### Eigene Logger verwenden
Eine eigene Logger-Instanz kann übergeben werden, indem sie als `loggerInstance`
gesetzt wird. Der Logger muss dem Pino-Interface entsprechen und Folgendes
mitbringen:

- **Methoden:** `info`, `error`, `debug`, `fatal`, `warn`, `trace`, `silent`,
  `child`
- **Eigenschaften:** `level` (String)

Beispiel:

```js
const log = require('pino')({ level: 'info' })
const fastify = require('fastify')({ loggerInstance: log })

log.info('does not have request information')

fastify.get('/', function (request, reply) {
  request.log.info('includes request information, but is the same logger instance as `log`')
  reply.send({ hello: 'world' })
})
```

*Die Logger-Instanz für den aktuellen Request ist in jedem Abschnitt des
[Lifecycles](./Lifecycle.md) verfügbar.*

### Log-Redaction

[Pino](https://getpino.io) unterstützt Log-Redaction mit geringem Overhead, um
Werte bestimmter Eigenschaften in aufgezeichneten Logs zu maskieren. Loggen Sie
beispielsweise aus Sicherheitsgründen alle HTTP-Header außer dem
`Authorization`-Header:

```js
const fastify = Fastify({
  logger: {
    stream: stream,
    redact: ['req.headers.authorization'],
    level: 'info',
    serializers: {
      req (request) {
        return {
          method: request.method,
          url: request.url,
          headers: request.headers,
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort
        }
      }
    }
  }
})
```

Weitere Details finden Sie in der
[Pino-Dokumentation zu Redaction](https://getpino.io/#/docs/redaction).
