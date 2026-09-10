<h1 align="center">Fastify</h1>

## Request
Der erste Parameter der Handler-Funktion ist `Request`.

Request ist ein zentrales Fastify-Objekt, das die folgenden Felder enthält:
- `query` - Der geparste Querystring; sein Format wird durch
  [`querystringParser`](./Server.md#querystringparser) bestimmt.
- `body` - Das Payload des Requests, siehe [Content-Type Parser](./ContentTypeParser.md)
  für Details dazu, welche Request-Payloads Fastify nativ parst und wie sich
  weitere Content-Typen unterstützen lassen.
- `params` - Die Parameter, die auf die URL passen. Werte sind
  prozentdekodiert (aus `%20` wird zum Beispiel ein Leerzeichen und aus `%2f`
  ein `/`). Dekodierte Werte können `.`, `..`, `/` oder andere Zeichen
  enthalten; behandeln Sie sie als nicht vertrauenswürdige Eingabe. Siehe den
  Sicherheitshinweis unten und
  [Routes - Url building](./Routes.md#url-building).
- [`headers`](#headers) - Getter und Setter für die Header.
- `raw` - Der eingehende HTTP-Request aus dem Node-Core.
- `server` - Die Fastify-Serverinstanz, begrenzt auf den aktuellen
  [Kapselungskontext](./Encapsulation.md).
- `id` - Die Request-ID.
- `log` - Die Logger-Instanz des eingehenden Requests.
- `ip` - Die IP-Adresse des eingehenden Requests. Dieser Wert stammt aus
  `socket.remoteAddress` (oder aus `X-Forwarded-For`, wenn
  [`trustProxy`](./Server.md#factory-trust-proxy) aktiviert ist).
- `ips` - Ein Array von IP-Adressen, geordnet vom nächsten zum entferntesten,
  aus `X-Forwarded-For` (nur wenn
  [`trustProxy`](./Server.md#factory-trust-proxy) aktiviert ist).
- `host` - Der Host des eingehenden Requests (abgeleitet aus `X-Forwarded-Host`,
  wenn [`trustProxy`](./Server.md#factory-trust-proxy) aktiviert ist). Aus
  Gründen der HTTP/2-Kompatibilität wird `:authority` zurückgegeben, wenn kein
  Host-Header existiert. Der Host-Header kann eine leere Zeichenkette liefern,
  wenn `requireHostHeader` `false` ist, er bei HTTP/1.0 nicht mitgeliefert oder
  durch die Schemavalidierung entfernt wurde.
- `hostname` - Der aus `request.host` geparste Hostname.
- `port` - Der aus `request.host` geparste Port, der sich auf den Port beziehen
  kann, auf dem der Server lauscht.
- `protocol` - Das Protokoll des eingehenden Requests (`https` oder `http`).
  Dieser Wert stammt aus `socket.encrypted` (oder aus `X-Forwarded-Proto`, wenn
  [`trustProxy`](./Server.md#factory-trust-proxy) aktiviert ist).

> ⚠️ Sicherheit:
> `request.params`, `request.query`, `request.headers` und `request.body`
> sind nicht vertrauenswürdige Netzwerkeingaben. Werte von Route-Parametern
> werden prozentdekodiert, bevor Ihr Handler läuft, sodass ein Segment wie
> `..%2ffile` in `request.params` zu `../file` wird. Verwenden Sie
> Parameterwerte nicht als Dateisystempfade, Templatenamen oder
> Weiterleitungsziele, ohne sie zu validieren oder einzugrenzen. Bevorzugen
> Sie [`@fastify/static`](https://github.com/fastify/fastify-static)
> (oder `reply.sendFile`), wenn Sie Dateien aus einem Wurzelverzeichnis
> ausliefern.
>
> `request.ip`, `request.ips`, `request.host`, `request.hostname`,
> `request.port` und `request.protocol` stammen aus Request-Metadaten
> (Socket und/oder Weiterleitungs-Header) und sollten ebenfalls als nicht
> vertrauenswürdige Eingabe behandelt werden. Fastify führt keine
> Sicherheitsvalidierung für Geschäftslogik durch. Werden diese Werte in
> sicherheitsrelevanten Entscheidungen verwendet, müssen sie explizit
> validiert werden (zum Beispiel durch Konfiguration vertrauenswürdiger
> Proxys, Allow-Lists, striktes Parsen und Normalisierung).

- `method` - Die Methode des eingehenden Requests.
- `url` - Die URL des eingehenden Requests.
- `originalUrl` - Ähnlich wie `url`, erlaubt den Zugriff auf die ursprüngliche
  `url` im Fall eines internen Re-Routings.
- `mediaType` - Der aus dem `Content-Type`-Header extrahierte Medientyp. Fehlt der
  `Content-Type`-Header, wird `undefined` zurückgegeben.
- `is404` - `true`, wenn der Request vom 404-Handler behandelt wird, sonst `false`.
- `socket` - Die zugrundeliegende Verbindung des eingehenden Requests.
- `signal` - Ein `AbortSignal`, das abbricht, wenn das Handler-Timeout
  auslöst oder der Client die Verbindung trennt. Es wird beim ersten Zugriff
  lazy erzeugt, sodass ohne Verwendung kein Overhead entsteht. Ist
  [`handlerTimeout`](./Server.md#factory-handler-timeout) konfiguriert,
  wird das Signal vorab erzeugt und bricht auch bei Timeout ab. Übergeben Sie
  es an `fetch()`, an Datenbankabfragen oder an jede API, die eine
  `signal`-Option akzeptiert, um kooperativ abbrechen zu können. Bei einem
  Timeout ist `signal.reason` der Fehler
  `FST_ERR_HANDLER_TIMEOUT`; bei einer Trennung durch den Client ein generischer
  `AbortError`. Prüfen Sie `signal.reason.code`, um die beiden Fälle zu unterscheiden.
- `context` - Veraltet, verwenden Sie stattdessen `request.routeOptions.config`. Ein
  internes Fastify-Objekt. Verwenden oder ändern Sie es nicht direkt. Es ist
  nützlich, um auf einen speziellen Schlüssel zuzugreifen:
  - `context.config` - Das [`config`](./Routes.md#routes-config)-Objekt der Route.
- `routeOptions` - Das [`option`](./Routes.md#routes-options)-Objekt der Route.
  - `bodyLimit` - Entweder das Serverlimit oder das Routenlimit.
  - `handlerTimeout` - Das für diese Route konfigurierte Handler-Timeout.
  - `config` - Das [`config`](./Routes.md#routes-config)-Objekt für diese Route.
  - `method` - Die HTTP-Methode der Route.
  - `url` - Der Pfad der URL, auf den diese Route passt.
  - `handler` - Der Handler für diese Route.
  - `attachValidation` - Hängt `validationError` an den Request an (sofern ein
    Schema definiert ist).
  - `logLevel` - Das für diese Route definierte Log-Level.
  - `schema` - Die Definition der JSON-Schemas für diese Route.
  - `version` - Eine semver-kompatible Zeichenkette, die die Version des Endpunkts definiert.
  - `exposeHeadRoute` - Erzeugt zu jeder GET-Route eine begleitende HEAD-Route.
  - `prefixTrailingSlash` - Zeichenkette, die bestimmt, wie die Übergabe von `/`
    als Route mit einem Präfix behandelt wird.
- [.getValidationFunction(schema | httpPart)](#getvalidationfunction) -
  Gibt eine Validierungsfunktion für das angegebene Schema oder den angegebenen
  HTTP-Teil zurück, sofern gesetzt oder gecacht.
- [.compileValidationSchema(schema, [httpPart])](#compilevalidationschema) -
  Kompiliert das angegebene Schema und gibt über den standardmäßigen (oder
  angepassten) `ValidationCompiler` eine Validierungsfunktion zurück. Der optionale
  `httpPart` wird, sofern angegeben, an den `ValidationCompiler` weitergereicht; Standard ist `null`.
- [.validateInput(data, schema | httpPart, [httpPart])](#validate) -
  Validiert die Eingabe anhand des angegebenen Schemas oder HTTP-Teils und gibt
  `true` zurück, wenn die Eingabe gültig ist, sonst `false`. Ist `httpPart` angegeben,
  verwendet die Funktion den Validator für diesen HTTP-Teil. Standard ist `null`.

### Headers

`request.headers` ist ein Getter, der ein Objekt mit den Headern des eingehenden
Requests zurückgibt. Eigene Header setzen Sie wie folgt:

```js
request.headers = {
  'foo': 'bar',
  'baz': 'qux'
}
```

Dieser Vorgang fügt den Request-Headern neue Werte hinzu, die über
`request.headers.bar` zugänglich sind. Standard-Request-Header bleiben über
`request.raw.headers` erreichbar.

Aus Performancegründen kann bei `not found`-Routen
`Symbol('fastify.RequestAcceptVersion')` zu den Headern hinzugefügt werden.

> ℹ️ Hinweis:
> Die Schemavalidierung kann die Objekte `request.headers` und
> `request.raw.headers` verändern, wodurch die Header leer werden können.

```js
fastify.post('/:params', options, function (request, reply) {
  console.log(request.body)
  console.log(request.query)
  console.log(request.params)
  console.log(request.headers)
  console.log(request.raw)
  console.log(request.server)
  console.log(request.id)
  console.log(request.ip)
  console.log(request.ips)
  console.log(request.host)
  console.log(request.hostname)
  console.log(request.port)
  console.log(request.protocol)
  console.log(request.url)
  console.log(request.routeOptions.method)
  console.log(request.routeOptions.bodyLimit)
  console.log(request.routeOptions.handlerTimeout)
  console.log(request.routeOptions.url)
  console.log(request.routeOptions.attachValidation)
  console.log(request.routeOptions.logLevel)
  console.log(request.routeOptions.version)
  console.log(request.routeOptions.exposeHeadRoute)
  console.log(request.routeOptions.prefixTrailingSlash)
  console.log(request.routeOptions.config)
  request.log.info('some info')
})
```
### .getValidationFunction(schema | httpPart)
<a id="getvalidationfunction"></a>

Beim Aufruf dieser Funktion mit einem angegebenen `schema` oder `httpPart` gibt sie
eine `validation`-Funktion zurück, um verschiedene Eingaben zu validieren. Sie gibt
`undefined` zurück, wenn mit den angegebenen Eingaben keine Serialisierungsfunktion
gefunden wird.

Diese Funktion besitzt eine Eigenschaft `errors`. Fehler, die während der letzten
Validierung aufgetreten sind, werden `errors` zugewiesen.

```js
const validate = request
                  .getValidationFunction({
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string'
                      }
                    }
                  })
console.log(validate({ foo: 'bar' })) // true
console.log(validate.errors) // null

// or

const validate = request
                  .getValidationFunction('body')
console.log(validate({ foo: 0.5 })) // false
console.log(validate.errors) // validation errors
```

Weitere Informationen zum Kompilieren von Validierungsschemas finden Sie unter
[.compileValidationSchema(schema, [httpStatus])](#compileValidationSchema).

### .compileValidationSchema(schema, [httpPart])
<a id="compilevalidationschema"></a>

Diese Funktion kompiliert ein Validierungsschema und gibt eine Funktion zur Validierung von Daten zurück.
Die zurückgegebene Funktion (auch _Validierungsfunktion_ genannt) wird über den angegebenen
[`SchemaController#ValidationCompiler`](./Server.md#schema-controller) kompiliert. Zum Cachen wird eine
`WeakMap` verwendet, was die Anzahl der Kompilierungsaufrufe reduziert.

Der optionale Parameter `httpPart` wird, sofern angegeben, an den
`ValidationCompiler` weitergereicht, sodass dieser die Validierungsfunktion kompilieren kann, wenn für
die Route ein eigener `ValidationCompiler` bereitgestellt wird.

Diese Funktion besitzt eine Eigenschaft `errors`. Fehler, die während der letzten
Validierung aufgetreten sind, werden `errors` zugewiesen.

```js
const validate = request
                  .compileValidationSchema({
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string'
                      }
                    }
                  })
console.log(validate({ foo: 'bar' })) // true
console.log(validate.errors) // null

// or

const validate = request
                  .compileValidationSchema({
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string'
                      }
                    }
                  }, 200)
console.log(validate({ hello: 'world' })) // false
console.log(validate.errors) // validation errors
```

Seien Sie vorsichtig beim Einsatz dieser Funktion, da sie kompilierte Validierungsfunktionen
anhand des angegebenen Schemas cacht. Werden Schemas mutiert oder verändert, bemerken die
Validierungsfunktionen die Änderungen nicht und verwenden die zuvor kompilierte
Validierungsfunktion weiter, da der Cache auf der Referenz des Schemas basiert.

Wenn Schemaeigenschaften geändert werden müssen, erstellen Sie ein neues Schemaobjekt, um vom
Cache-Mechanismus zu profitieren.

Am Beispiel des folgenden Schemas:
```js
const schema1 = {
  type: 'object',
  properties: {
    foo: {
      type: 'string'
    }
  }
}
```

*Nicht so*
```js
const validate = request.compileValidationSchema(schema1)

// Later on...
schema1.properties.foo.type = 'integer'
const newValidate = request.compileValidationSchema(schema1)

console.log(newValidate === validate) // true
```

*Sondern so*
```js
const validate = request.compileValidationSchema(schema1)

// Later on...
const newSchema = Object.assign({}, schema1)
newSchema.properties.foo.type = 'integer'

const newValidate = request.compileValidationSchema(newSchema)

console.log(newValidate === validate) // false
```

### .validateInput(data, [schema | httpPart], [httpPart])
<a id="validate"></a>

Diese Funktion validiert die Eingabe anhand des angegebenen Schemas oder HTTP-Teils. Sind
beide angegeben, hat der Parameter `httpPart` Vorrang.

Existiert für ein gegebenes `schema` keine Validierungsfunktion, wird eine neue kompiliert,
wobei `httpPart` weitergereicht wird, sofern angegeben.

```js
request
  .validateInput({ foo: 'bar'}, {
    type: 'object',
    properties: {
      foo: {
        type: 'string'
      }
    }
  }) // true

// or

request
  .validateInput({ foo: 'bar'}, {
    type: 'object',
    properties: {
      foo: {
        type: 'string'
      }
    }
  }, 'body') // true

// or

request
  .validateInput({ hello: 'world'}, 'query') // false
```

Weitere Informationen zum Kompilieren von Validierungsschemas finden Sie unter
[.compileValidationSchema(schema, [httpStatus])](#compileValidationSchema).
