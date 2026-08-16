<h1 align="center">Fastify</h1>

## Reply
- [Reply](#reply)
  - [Einführung](#introduction)
  - [.code(statusCode)](#codestatuscode)
  - [.elapsedTime](#elapsedtime)
  - [.statusCode](#statuscode)
  - [.server](#server)
  - [.header(key, value)](#headerkey-value)
  - [.headers(object)](#headersobject)
  - [.getHeader(key)](#getheaderkey)
  - [.getHeaders()](#getheaders)
  - [.removeHeader(key)](#removeheaderkey)
  - [.hasHeader(key)](#hasheaderkey)
  - [.writeEarlyHints(hints, callback)](#writeearlyhintshints-callback)
  - [.trailer(key, function)](#trailerkey-function)
  - [.hasTrailer(key)](#hastrailerkey)
  - [.removeTrailer(key)](#removetrailerkey)
  - [.redirect(dest, [code ,])](#redirectdest--code)
  - [.callNotFound()](#callnotfound)
  - [.type(contentType)](#typecontenttype)
  - [.getSerializationFunction(schema | httpStatus, [contentType])](#getserializationfunctionschema--httpstatus)
  - [.compileSerializationSchema(schema, [httpStatus], [contentType])](#compileserializationschemaschema-httpstatus)
  - [.serializeInput(data, [schema | httpStatus], [httpStatus], [contentType])](#serializeinputdata-schema--httpstatus-httpstatus)
  - [.serializer(func)](#serializerfunc)
  - [.raw](#raw)
  - [.sent](#sent)
  - [.hijack()](#hijack)
  - [.send(data)](#senddata)
    - [Objekte](#objects)
    - [Strings](#strings)
    - [Streams](#streams)
    - [Buffer](#buffers)
    - [TypedArrays](#typedarrays)
    - [ReadableStream](#readablestream)
    - [Response](#response)
    - [Fehler](#errors)
    - [Typ des endgültigen Payloads](#type-of-the-final-payload)
    - [Async-Await und Promises](#async-await-and-promises)
  - [.then(fulfilled, rejected)](#thenfulfilled-rejected)

### Einführung
<a id="introduction"></a>

Der zweite Parameter der Handler-Funktion ist `Reply`. Reply ist ein zentrales
Fastify-Objekt, das die folgenden Funktionen und Eigenschaften bereitstellt:

- `.code(statusCode)` – Setzt den Statuscode.
- `.status(statusCode)` – Ein Alias für `.code(statusCode)`.
- `.statusCode` – Liest und setzt den HTTP-Statuscode.
- `.elapsedTime` – Gibt die Zeitspanne zurück, die vergangen ist,
seit der Request von Fastify empfangen wurde.
- `.server` – Eine Referenz auf das Objekt der Fastify-Instanz.
- `.header(name, value)` – Setzt einen Response-Header.
- `.headers(object)` – Setzt alle Schlüssel des Objekts als Response-Header.
- `.getHeader(name)` – Liest den Wert eines bereits gesetzten Headers.
- `.getHeaders()` – Liefert eine flache Kopie aller aktuellen Response-Header.
- `.removeHeader(key)` – Entfernt den Wert eines zuvor gesetzten Headers.
- `.hasHeader(name)` – Stellt fest, ob ein Header gesetzt wurde.
- `.writeEarlyHints(hints, callback)` – Sendet Early Hints an den Anwender,
  während die Response vorbereitet wird.
- `.trailer(key, function)` – Setzt einen Response-Trailer.
- `.hasTrailer(key)` – Stellt fest, ob ein Trailer gesetzt wurde.
- `.removeTrailer(key)` – Entfernt den Wert eines zuvor gesetzten Trailers.
- `.type(value)` – Setzt den Header `Content-Type`.
- `.redirect(dest, [code,])` – Leitet auf die angegebene URL um; der Statuscode ist
  optional (Standard `302`).
- `.callNotFound()` – Ruft den eigenen Not-Found-Handler auf.
- `.serialize(payload)` – Serialisiert den angegebenen Payload mit dem
  Standard-JSON-Serializer oder mit dem eigenen Serializer (falls einer gesetzt ist)
  und gibt den serialisierten Payload zurück.
- `.getSerializationFunction(schema | httpStatus, [contentType])` – Gibt die
  Serialisierungsfunktion für das angegebene Schema oder den angegebenen
  HTTP-Status zurück, sofern eines von beidem gesetzt ist.
- `.compileSerializationSchema(schema, [httpStatus], [contentType])` – Kompiliert
  das angegebene Schema und gibt eine Serialisierungsfunktion zurück, die den
  Standard-`SerializerCompiler` (oder einen angepassten) verwendet. Das optionale
  `httpStatus` wird, falls angegeben, an den `SerializerCompiler` weitergereicht;
  Standard ist `undefined`.
- `.serializeInput(data, schema, [,httpStatus], [contentType])` – Serialisiert
  die angegebenen Daten mit dem angegebenen Schema und gibt den serialisierten Payload
  zurück. Sind die optionalen Parameter `httpStatus` und `contentType` angegeben,
  verwendet die Funktion die Serializer-Funktion für genau diesen Content-Type und
  HTTP-Statuscode. Standard ist `undefined`.
- `.serializer(function)` – Setzt einen eigenen Serializer für den Payload.
- `.send(payload)` – Sendet den Payload an den Anwender; das kann reiner Text, ein
  Buffer, JSON, ein Stream oder ein Error-Objekt sein.
- `.sent` – Ein Boolescher Wert, den Sie verwenden können, wenn Sie wissen müssen, ob
  `send` bereits aufgerufen wurde.
- `.hijack()` – Unterbricht den normalen Request-Lebenszyklus.
- `.raw` – Das
  [`http.ServerResponse`](https://nodejs.org/dist/latest-v20.x/docs/api/http.html#http_class_http_serverresponse)
  aus dem Node-Kern.
- `.log` – Die Logger-Instanz des eingehenden Requests.
- `.request` – Der eingehende Request.

```js
fastify.get('/', options, function (request, reply) {
  // Your code
  reply
    .code(200)
    .header('Content-Type', 'application/json; charset=utf-8')
    .send({ hello: 'world' })
})
```

### .code(statusCode)
<a id="code"></a>

Wenn er nicht über `reply.code` gesetzt wird, ist der resultierende `statusCode` `200`.

### .elapsedTime
<a id="elapsedTime"></a>

Ruft den eigenen Getter für die Antwortzeit auf, um die Zeitspanne zu berechnen, die
vergangen ist, seit der Request von Fastify empfangen wurde.

```js
const milliseconds = reply.elapsedTime
```

### .statusCode
<a id="statusCode"></a>

Diese Eigenschaft liest und setzt den HTTP-Statuscode. Als Setter verwendet, ist sie
ein Alias für `reply.code()`.
```js
if (reply.statusCode >= 299) {
  reply.statusCode = 500
}
```

### .server
<a id="server"></a>

Die Fastify-Serverinstanz, bezogen auf den aktuellen
[Kapselungskontext](./Encapsulation.md).

```js
fastify.decorate('util', function util () {
  return 'foo'
})

fastify.get('/', async function (req, rep) {
  return rep.server.util() // foo
})
```

### .header(key, value)
<a id="header"></a>

Setzt einen Response-Header. Wird der Wert weggelassen oder ist er undefined, wird er
zu `''` umgewandelt.

> ℹ️ Hinweis:
> Der Wert des Headers muss korrekt kodiert sein, etwa mit
> [`encodeURI`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURI)
> oder ähnlichen Modulen wie
> [`encodeurl`](https://www.npmjs.com/package/encodeurl). Ungültige Zeichen
> führen zu einer 500er-Response mit `TypeError`.

Weitere Informationen finden Sie unter
[`http.ServerResponse#setHeader`](https://nodejs.org/dist/latest-v20.x/docs/api/http.html#http_response_setheader_name_value).

- ### set-cookie
  <a id="set-cookie"></a>

    - Wenn unterschiedliche Werte als Cookie mit `set-cookie` als Schlüssel gesendet
      werden, wird jeder Wert als Cookie gesendet, statt den vorherigen Wert zu
      ersetzen.

    ```js
    reply.header('set-cookie', 'foo');
    reply.header('set-cookie', 'bar');
    ```
  - Der Browser berücksichtigt beim Header `set-cookie` nur die zuletzt genannte
    Referenz eines Schlüssels. Das geschieht, um das Parsen des `set-cookie`-Headers
    beim Hinzufügen zu einer Reply zu vermeiden, und beschleunigt die Serialisierung
    der Reply.

  - Um den Header `set-cookie` zurückzusetzen, müssen Sie explizit
    `reply.removeHeader('set-cookie')` aufrufen; mehr zu `.removeHeader(key)` lesen
    Sie [hier](#removeheaderkey).



### .headers(object)
<a id="headers"></a>

Setzt alle Schlüssel des Objekts als Response-Header.
[`.header`](#headerkey-value) wird dabei unter der Haube aufgerufen.
```js
reply.headers({
  'x-foo': 'foo',
  'x-bar': 'bar'
})
```

### .getHeader(key)
<a id="getHeader"></a>

Liest den Wert eines zuvor gesetzten Headers.
```js
reply.header('x-foo', 'foo') // setHeader: key, value
reply.getHeader('x-foo') // 'foo'
```

### .getHeaders()
<a id="getHeaders"></a>

Liefert eine flache Kopie aller aktuellen Response-Header, einschließlich jener, die
über das rohe `http.ServerResponse` gesetzt wurden. Beachten Sie, dass über Fastify
gesetzte Header Vorrang vor jenen haben, die über `http.ServerResponse` gesetzt wurden.

```js
reply.header('x-foo', 'foo')
reply.header('x-bar', 'bar')
reply.raw.setHeader('x-foo', 'foo2')
reply.getHeaders() // { 'x-foo': 'foo', 'x-bar': 'bar' }
```

### .removeHeader(key)
<a id="removeHeader"></a>

Entfernt den Wert eines zuvor gesetzten Headers.
```js
reply.header('x-foo', 'foo')
reply.removeHeader('x-foo')
reply.getHeader('x-foo') // undefined
```

### .hasHeader(key)
<a id="hasHeader"></a>

Gibt einen Booleschen Wert zurück, der angibt, ob der angegebene Header gesetzt wurde.

### .writeEarlyHints(hints, callback)
<a id="writeEarlyHints"></a>

Sendet Early Hints an den Client. Early Hints erlauben es dem Client, mit der
Verarbeitung von Ressourcen zu beginnen, bevor die endgültige Response gesendet wird.
Das kann die Performance verbessern, weil der Client Ressourcen vorladen oder
Verbindungen vorab aufbauen kann, während der Server die Response noch erzeugt.

Der Parameter hints ist ein Objekt, das die Schlüssel-Wert-Paare der Early Hints
enthält.

Beispiel:

```js
reply.writeEarlyHints({
  Link: '</styles.css>; rel=preload; as=style'
});
```

Der optionale Callback-Parameter ist eine Funktion, die aufgerufen wird, sobald der
Hint gesendet wurde oder ein Fehler auftritt.

### .trailer(key, function)
<a id="trailer"></a>

Setzt einen Response-Trailer. Trailer werden üblicherweise verwendet, wenn Sie einen
Header brauchen, dessen Erzeugung viele Ressourcen erfordert und der daher nach den
`data` gesendet werden soll, zum Beispiel `Server-Timing` und `Etag`. So erhält der
Client die Antwortdaten so früh wie möglich.

> ℹ️ Hinweis:
> Der Header `Transfer-Encoding: chunked` wird hinzugefügt, sobald Sie einen Trailer
> verwenden. Das ist eine zwingende Voraussetzung für die Verwendung von Trailern in
> Node.js.

> ℹ️ Hinweis:
> Jeder an den `done`-Callback übergebene Fehler wird ignoriert. Wenn Sie sich für den
> Fehler interessieren, können Sie das Logging auf `debug` stellen.

```js
reply.trailer('server-timing', async function () {
  return 'db;dur=53, app;dur=47.2'
})

const { createHash } = require('node:crypto')
// trailer function also receive two argument
// @param {object} reply fastify reply
// @param {string|Buffer|null} payload payload that already sent, note that it will be null when stream is sent
// @param {function} done callback to set trailer value
reply.trailer('content-md5', function(reply, payload, done) {
  const hash = createHash('md5')
  hash.update(payload)
  done(null, hash.digest('hex'))
})

// when you prefer async-await
reply.trailer('content-md5', async function(reply, payload) {
  const hash = createHash('md5')
  hash.update(payload)
  return hash.digest('hex')
})
```

### .hasTrailer(key)
<a id="hasTrailer"></a>

Gibt einen Booleschen Wert zurück, der angibt, ob der angegebene Trailer gesetzt wurde.

### .removeTrailer(key)
<a id="removeTrailer"></a>

Entfernt den Wert eines zuvor gesetzten Trailers.
```js
reply.trailer('server-timing', async function () {
  return 'db;dur=53, app;dur=47.2'
})
reply.removeTrailer('server-timing')
reply.hasTrailer('server-timing') // false
```


### .redirect(dest, [code ,])
<a id="redirect"></a>

Leitet einen Request auf die angegebene URL um; der Statuscode ist optional, Standard
ist `302` (sofern der Statuscode nicht bereits durch einen Aufruf von `code` gesetzt
wurde).

> ℹ️ Hinweis:
> Die übergebene URL muss korrekt kodiert sein, etwa mit
> [`encodeURI`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURI)
> oder ähnlichen Modulen wie
> [`encodeurl`](https://www.npmjs.com/package/encodeurl). Ungültige URLs führen zu
> einer 500er-Response mit `TypeError`.

Beispiel (ohne Aufruf von `reply.code()`) setzt den Statuscode auf `302` und leitet
nach `/home` um
```js
reply.redirect('/home')
```

Beispiel (ohne Aufruf von `reply.code()`) setzt den Statuscode auf `303` und leitet
nach `/home` um
```js
reply.redirect('/home', 303)
```

Beispiel (mit Aufruf von `reply.code()`) setzt den Statuscode auf `303` und leitet nach
`/home` um
```js
reply.code(303).redirect('/home')
```

Beispiel (mit Aufruf von `reply.code()`) setzt den Statuscode auf `302` und leitet nach
`/home` um
```js
reply.code(303).redirect('/home', 302)
```

### .callNotFound()
<a id="call-not-found"></a>

Ruft den eigenen Not-Found-Handler auf. Beachten Sie, dass dabei nur der in
[`setNotFoundHandler`](./Server.md#set-not-found-handler) angegebene
`preHandler`-Hook aufgerufen wird.

```js
reply.callNotFound()
```

### .type(contentType)
<a id="type"></a>

Setzt den Content-Type für die Response. Das ist eine Kurzform für
`reply.header('Content-Type', 'the/type')`.

```js
reply.type('text/html')
```
Hat der `Content-Type` einen JSON-Subtyp und ist der Charset-Parameter nicht gesetzt,
wird standardmäßig `utf-8` als Charset verwendet. Bei anderen Content-Types muss das
Charset ausdrücklich gesetzt werden.

### .getSerializationFunction(schema | httpStatus, [contentType])
<a id="getserializationfunction"></a>

Wenn Sie diese Funktion mit einem angegebenen `schema` oder `httpStatus` und dem
optionalen `contentType` aufrufen, gibt sie eine `serialization`-Funktion zurück, mit
der sich verschiedenste Eingaben serialisieren lassen. Sie gibt `undefined` zurück,
wenn zu keiner der übergebenen Eingaben eine Serialisierungsfunktion gefunden wurde.

Das hängt stark von dem an die Route angehängten `schema#responses` ab oder von den
Serialisierungsfunktionen, die mit `compileSerializationSchema` kompiliert wurden.

```js
const serialize = reply
                  .getSerializationFunction({
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string'
                      }
                    }
                  })
serialize({ foo: 'bar' }) // '{"foo":"bar"}'

// or

const serialize = reply
                  .getSerializationFunction(200)
serialize({ foo: 'bar' }) // '{"foo":"bar"}'

// or

const serialize = reply
                  .getSerializationFunction(200, 'application/json')
serialize({ foo: 'bar' }) // '{"foo":"bar"}'
```

Weitere Informationen dazu, wie Serialisierungsschemata kompiliert werden, finden Sie
unter [.compileSerializationSchema(schema, [httpStatus], [contentType])](#compileserializationschema).

### .compileSerializationSchema(schema, [httpStatus], [contentType])
<a id="compileserializationschema"></a>

Diese Funktion kompiliert ein Serialisierungsschema und gibt eine Funktion zurück, mit
der sich Daten serialisieren lassen. Die zurückgegebene Funktion (auch
_Serialisierungsfunktion_ genannt) wird mit dem bereitgestellten
`SerializerCompiler` kompiliert. Außerdem wird sie über eine `WeakMap` gecacht, um
Kompilierungsaufrufe zu reduzieren.

Die optionalen Parameter `httpStatus` und `contentType` werden, sofern angegeben,
direkt an den `SerializerCompiler` weitergereicht, sodass sie zum Kompilieren der
Serialisierungsfunktion genutzt werden können, wenn ein eigener `SerializerCompiler`
verwendet wird.

Das hängt stark von dem an die Route angehängten `schema#responses` ab oder von den
Serialisierungsfunktionen, die mit `compileSerializationSchema` kompiliert wurden.

```js
const serialize = reply
                  .compileSerializationSchema({
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string'
                      }
                    }
                  })
serialize({ foo: 'bar' }) // '{"foo":"bar"}'

// or

const serialize = reply
                  .compileSerializationSchema({
                    type: 'object',
                    properties: {
                      foo: {
                        type: 'string'
                      }
                    }
                  }, 200)
serialize({ foo: 'bar' }) // '{"foo":"bar"}'

// or

const serialize = reply
                  .compileSerializationSchema({
                        '3xx': {
                          content: {
                            'application/json': {
                              schema: {
                                name: { type: 'string' },
                                phone: { type: 'number' }
                              }
                            }
                          }
                        }
                  }, '3xx', 'application/json')
serialize({ name: 'Jone', phone: 201090909090 }) // '{"name":"Jone", "phone":201090909090}'
```

Beachten Sie, dass Sie bei der Verwendung dieser Funktion vorsichtig sein sollten, da
sie die kompilierten Serialisierungsfunktionen anhand des übergebenen Schemas cacht.
Wird das übergebene Schema verändert, erkennen die Serialisierungsfunktionen die
Änderung nicht und verwenden beispielsweise die zuvor kompilierte
Serialisierungsfunktion auf Basis der Referenz des zuvor übergebenen Schemas weiter.

Wenn die Eigenschaften eines Schemas geändert werden müssen, erstellen Sie stets ein
vollständig neues Objekt, sonst profitiert die Implementierung nicht vom
Cache-Mechanismus.

:Das folgende Schema als Beispiel:
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
const serialize = reply.compileSerializationSchema(schema1)

// Later on...
schema1.properties.foo.type = 'integer'
const newSerialize = reply.compileSerializationSchema(schema1)

console.log(newSerialize === serialize) // true
```

*Sondern so*
```js
const serialize = reply.compileSerializationSchema(schema1)

// Later on...
const newSchema = Object.assign({}, schema1)
newSchema.properties.foo.type = 'integer'

const newSerialize = reply.compileSerializationSchema(newSchema)

console.log(newSerialize === serialize) // false
```

### .serializeInput(data, [schema | httpStatus], [httpStatus], [contentType])
<a id="serializeinput"></a>

Diese Funktion serialisiert die Eingabedaten auf Basis des angegebenen Schemas oder
HTTP-Statuscodes. Sind beide angegeben, hat `httpStatus` Vorrang.

Gibt es für ein gegebenes `schema` keine Serialisierungsfunktion, wird eine neue
kompiliert, wobei `httpStatus` und `contentType` – sofern angegeben – weitergereicht
werden.

```js
reply
  .serializeInput({ foo: 'bar'}, {
    type: 'object',
    properties: {
      foo: {
        type: 'string'
      }
    }
  }) // '{"foo":"bar"}'

// or

reply
  .serializeInput({ foo: 'bar'}, {
    type: 'object',
    properties: {
      foo: {
        type: 'string'
      }
    }
  }, 200) // '{"foo":"bar"}'

// or

reply
  .serializeInput({ foo: 'bar'}, 200) // '{"foo":"bar"}'

// or

reply
  .serializeInput({ name: 'Jone', age: 18 }, '200', 'application/vnd.v1+json') // '{"name": "Jone", "age": 18}'
```

Weitere Informationen dazu, wie Serialisierungsschemata kompiliert werden, finden Sie
unter [.compileSerializationSchema(schema, [httpStatus], [contentType])](#compileserializationschema).

### .serializer(func)
<a id="serializer"></a>

Standardmäßig serialisiert `.send()` jeden Wert als JSON, der nicht `Buffer`,
`stream`, `string`, `undefined` oder `Error` ist. Wenn Sie den Standard-Serializer für
einen bestimmten Request durch einen eigenen ersetzen müssen, können Sie das mit der
Hilfsfunktion `.serializer()` tun. Beachten Sie: Wenn Sie einen eigenen Serializer
verwenden, müssen Sie einen eigenen `'Content-Type'`-Header setzen.

```js
reply
  .header('Content-Type', 'application/x-protobuf')
  .serializer(protoBuf.serialize)
```

Beachten Sie, dass Sie diese Hilfsfunktion innerhalb eines `handler` nicht benötigen,
weil Buffer, Streams und Strings (sofern kein Serializer gesetzt ist) bereits als
serialisiert gelten.

```js
reply
  .header('Content-Type', 'application/x-protobuf')
  .send(protoBuf.serialize(data))
```

Weitere Informationen zum Senden unterschiedlicher Werttypen finden Sie unter
[`.send()`](#send).

### .raw
<a id="raw"></a>

Dies ist das
[`http.ServerResponse`](https://nodejs.org/dist/latest-v20.x/docs/api/http.html#http_class_http_serverresponse)
aus dem Node-Kern. Solange Sie das Fastify-`Reply`-Objekt verwenden, geschieht die
Nutzung von `Reply.raw`-Funktionen auf eigene Gefahr, da Sie damit die gesamte
Fastify-Logik zur Behandlung der HTTP-Response umgehen. Zum Beispiel:

```js
app.get('/cookie-2', (req, reply) => {
  reply.setCookie('session', 'value', { secure: false }) // this will not be used

  // in this case we are using only the nodejs http server response object
  reply.raw.writeHead(200, { 'Content-Type': 'text/plain' })
  reply.raw.write('ok')
  reply.raw.end()
})
```
Ein weiteres Beispiel für den Fehlgebrauch von `Reply.raw` wird unter
[Reply](#getheaders) erläutert.

### .sent
<a id="sent"></a>

Wie der Name vermuten lässt, ist `.sent` eine Eigenschaft, die angibt, ob eine
Response über `reply.send()` gesendet wurde. Sie ist auch `true`, wenn
`reply.hijack()` verwendet wurde.

Ist ein Route-Handler als async-Funktion definiert oder gibt er ein Promise zurück,
kann `reply.hijack()` aufgerufen werden, um anzuzeigen, dass der automatische Aufruf
von `reply.send()` nach dem Erfüllen des Handler-Promise übersprungen werden soll.
Mit dem Aufruf von `reply.hijack()` übernimmt eine Anwendung die volle Verantwortung
für Request und Response auf niedriger Ebene. Zudem werden keine Hooks aufgerufen.

*Das direkte Verändern der Eigenschaft `.sent` ist veraltet. Verwenden Sie bitte die
zuvor genannte Methode `.hijack()`, um denselben Effekt zu erzielen.*

### .hijack()
<a name="hijack"></a>

Manchmal müssen Sie die Ausführung des normalen Request-Lebenszyklus anhalten und das
Senden der Response selbst übernehmen.

Dafür stellt Fastify die Methode `reply.hijack()` bereit, die während des
Request-Lebenszyklus aufgerufen werden kann (zu jedem Zeitpunkt, bevor `reply.send()`
aufgerufen wird), und es Ihnen erlaubt, Fastify daran zu hindern, die Response zu
senden und die verbleibenden Hooks auszuführen (sowie den Anwender-Handler, wenn die
Reply vorher gekapert wurde).

```js
app.get('/', (req, reply) => {
  reply.hijack()
  reply.raw.end('hello world')

  return Promise.resolve('this will be skipped')
})
```

Wird `reply.raw` verwendet, um eine Response an den Anwender zu senden, werden die
`onResponse`-Hooks dennoch ausgeführt.

### .send(data)
<a id="send"></a>

Wie der Name vermuten lässt, ist `.send()` die Funktion, die den Payload an den
Endanwender sendet.

#### Objekte
<a id="send-object"></a>

Wie oben erwähnt: Wenn Sie JSON-Objekte senden, serialisiert `send` das Objekt mit
[fast-json-stringify](https://www.npmjs.com/package/fast-json-stringify), sofern Sie
ein Ausgabeschema gesetzt haben; andernfalls wird `JSON.stringify()` verwendet.
```js
fastify.get('/json', options, function (request, reply) {
  reply.send({ hello: 'world' })
})
```

#### Strings
<a id="send-string"></a>

Wenn Sie einen String ohne `Content-Type` an `send` übergeben, wird er als
`text/plain; charset=utf-8` gesendet. Wenn Sie den `Content-Type`-Header setzen und
einen String an `send` übergeben, wird er mit dem eigenen Serializer serialisiert,
sofern einer gesetzt ist; andernfalls wird er unverändert gesendet.

> ℹ️ Hinweis:
> Selbst wenn der `Content-Type`-Header auf `application/json` gesetzt ist,
> werden Strings standardmäßig unverändert gesendet. Um einen String als JSON zu
> serialisieren, müssen Sie einen eigenen Serializer setzen:

```js
fastify.get('/json-string', async function (request, reply) {
  reply
    .type('application/json; charset=utf-8')
    .serializer(JSON.stringify)
    .send('Hello') // Returns "Hello" (JSON-encoded string)
})
```
```js
fastify.get('/json', options, function (request, reply) {
  reply.send('plain string')
})
```

#### Streams
<a id="send-streams"></a>

Wenn Sie einen Stream senden und keinen `'Content-Type'`-Header gesetzt haben, setzt
*send* ihn auf `'application/octet-stream'`.

Wie oben erwähnt, gelten Streams als vorserialisiert und werden daher unverändert und
ohne Response-Validierung gesendet.

Beim Senden von Streams über HTTP/2 verändert Fastify die vom Stream ausgegebenen
Chunks nicht. Wenn ein Stream sehr große Chunks ausgeben kann, teilen Sie diese in
Ihrem Anwendungscode auf, zum Beispiel mit `fs.createReadStream()` oder einem
Transform-Stream, der kleinere Chunks ausgibt.

Beachten Sie den besonderen Hinweis zur Fehlerbehandlung bei Streams unter
[`setErrorHandler`](./Server.md#seterrorhandler).

```js
const fs = require('node:fs')

fastify.get('/streams', function (request, reply) {
  const stream = fs.createReadStream('some-file', 'utf8')
  reply.header('Content-Type', 'application/octet-stream')
  reply.send(stream)
})
```
Bei Verwendung von async-await müssen Sie das Reply-Objekt zurückgeben oder abwarten:
```js
const fs = require('node:fs')

fastify.get('/streams', async function (request, reply) {
  const stream = fs.createReadStream('some-file', 'utf8')
  reply.header('Content-Type', 'application/octet-stream')
  return reply.send(stream)
})
```

#### Buffer
<a id="send-buffers"></a>

Wenn Sie einen Buffer senden und keinen `'Content-Type'`-Header gesetzt haben, setzt
*send* ihn auf `'application/octet-stream'`.

Wie oben erwähnt, gelten Buffer als vorserialisiert und werden daher unverändert und
ohne Response-Validierung gesendet.

```js
const fs = require('node:fs')

fastify.get('/streams', function (request, reply) {
  fs.readFile('some-file', (err, fileBuffer) => {
    reply.send(err || fileBuffer)
  })
})
```

Bei Verwendung von async-await müssen Sie das Reply-Objekt zurückgeben oder abwarten:
```js
const fs = require('node:fs')

fastify.get('/streams', async function (request, reply) {
  fs.readFile('some-file', (err, fileBuffer) => {
    reply.send(err || fileBuffer)
  })
  return reply
})
```

#### TypedArrays
<a id="send-typedarrays"></a>

`send` behandelt TypedArray wie einen Buffer und setzt den
`'Content-Type'`-Header auf `'application/octet-stream'`, falls er nicht bereits
gesetzt ist.

Wie oben erwähnt, gelten TypedArrays/Buffer als vorserialisiert und werden daher
unverändert und ohne Response-Validierung gesendet.

```js
const fs = require('node:fs')

fastify.get('/streams', function (request, reply) {
  const typedArray = new Uint16Array(10)
  reply.send(typedArray)
})
```

#### ReadableStream
<a id="send-readablestream"></a>

Ein `ReadableStream` wird wie ein oben erwähnter Node-Stream behandelt; der Inhalt
gilt als vorserialisiert und wird daher unverändert und ohne Response-Validierung
gesendet.

```js
const fs = require('node:fs')
const { ReadableStream } = require('node:stream/web')

fastify.get('/streams', function (request, reply) {
  const stream = fs.createReadStream('some-file')
  reply.header('Content-Type', 'application/octet-stream')
  reply.send(ReadableStream.from(stream))
})
```

#### Response
<a id="send-response"></a>

`Response` erlaubt es, Payload, Statuscode und Header der Reply an einer Stelle zu
verwalten. Der in `Response` bereitgestellte Payload gilt als vorserialisiert und wird
daher unverändert und ohne Response-Validierung gesendet.

Beachten Sie bei der Verwendung von `Response`, dass sich Statuscode und Header nicht
direkt in `reply.statusCode` und `reply.getHeaders()` widerspiegeln. Dieses Verhalten
rührt daher, dass `Response` Statuscode und Header nur `readonly` erlaubt. Die Daten
lassen sich nicht in beide Richtungen bearbeiten, was beim Prüfen des `payload` in
`onSend`-Hooks verwirren kann.

```js
const fs = require('node:fs')
const { ReadableStream } = require('node:stream/web')

fastify.get('/streams', function (request, reply) {
  const stream = fs.createReadStream('some-file')
  const readableStream = ReadableStream.from(stream)
  const response = new Response(readableStream, {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' }
  })
  reply.send(response)
})
```


#### Fehler
<a id="errors"></a>

Wenn Sie an *send* ein Objekt übergeben, das eine Instanz von *Error* ist, erzeugt
Fastify automatisch einen Fehler mit folgender Struktur:

```js
{
  error: String        // the HTTP error message
  code: String         // the Fastify error code
  message: String      // the user error message
  statusCode: Number   // the HTTP status code
}
```

Sie können dem Error-Objekt eigene Eigenschaften hinzufügen, etwa `headers`, die zur
Anreicherung der HTTP-Response verwendet werden.

> ℹ️ Hinweis:
> Wenn Sie einen Fehler an `send` übergeben und der statusCode kleiner als
> 400 ist, setzt Fastify ihn automatisch auf 500.

Tipp: Sie können Fehler vereinfachen, indem Sie das Modul
[`http-errors`](https://www.npmjs.com/package/http-errors) oder das Plugin
[`@fastify/sensible`](https://github.com/fastify/fastify-sensible) zum Erzeugen von
Fehlern verwenden:

```js
fastify.get('/', function (request, reply) {
  reply.send(httpErrors.Gone())
})
```

Um die JSON-Fehlerausgabe anzupassen, können Sie:

- ein JSON-Response-Schema für den benötigten Statuscode setzen
- die zusätzlichen Eigenschaften der `Error`-Instanz hinzufügen

Beachten Sie: Ist der zurückgegebene Statuscode nicht in der Liste der
Response-Schemata enthalten, greift das Standardverhalten.

```js
fastify.get('/', {
  schema: {
    response: {
      501: {
        type: 'object',
        properties: {
          statusCode: { type: 'number' },
          code: { type: 'string' },
          error: { type: 'string' },
          message: { type: 'string' },
          time: { type: 'string' }
        }
      }
    }
  }
}, function (request, reply) {
  const error = new Error('This endpoint has not been implemented')
  error.time = 'it will be implemented in two weeks'
  reply.code(501).send(error)
})
```

Wenn Sie die Fehlerbehandlung anpassen möchten, sehen Sie sich die API
[`setErrorHandler`](./Server.md#seterrorhandler) an.

> ℹ️ Hinweis:
> Beim Anpassen des Error-Handlers sind Sie selbst für das Logging verantwortlich.

API:

```js
fastify.setErrorHandler(function (error, request, reply) {
  request.log.warn(error)
  const statusCode = error.statusCode >= 400 ? error.statusCode : 500
  reply
    .code(statusCode)
    .type('text/plain')
    .send(statusCode >= 500 ? 'Internal server error' : error.message)
})
```

Beachten Sie, dass ein Aufruf von `reply.send(error)` in Ihrem eigenen Error-Handler
den Fehler an den Standard-Error-Handler weitergibt.
Weitere Informationen finden Sie unter [Reply Lifecycle](./Lifecycle.md#reply-lifecycle).

Die vom Router erzeugten Not-Found-Fehler verwenden
[`setNotFoundHandler`](./Server.md#setnotfoundhandler)

API:

```js
fastify.setNotFoundHandler(function (request, reply) {
  reply
    .code(404)
    .type('text/plain')
    .send('a custom not found')
})
```

#### Typ des endgültigen Payloads
<a id="payload-type"></a>

Der Typ des gesendeten Payloads (nach der Serialisierung und nachdem er alle
[`onSend`-Hooks](./Hooks.md#onsend) durchlaufen hat) muss einer der folgenden Typen
sein, andernfalls wird ein Fehler geworfen:

- `string`
- `Buffer`
- `stream`
- `undefined`
- `null`

#### Async-Await und Promises
<a id="async-await-promise"></a>

Fastify behandelt Promises nativ und unterstützt async-await.

*Beachten Sie, dass wir in den folgenden Beispielen kein reply.send verwenden.*
```js
const { promisify } = require('node:util')
const delay = promisify(setTimeout)

fastify.get('/promises', options, function (request, reply) {
 return delay(200).then(() => { return { hello: 'world' }})
})

fastify.get('/async-await', options, async function (request, reply) {
  await delay(200)
  return { hello: 'world' }
})
```

Abgelehnte Promises führen standardmäßig zum HTTP-Statuscode `500`. Lehnen Sie das
Promise ab oder werfen Sie in einer `async function` ein Objekt mit den Eigenschaften
`statusCode` (oder `status`) und `message`, um die Reply anzupassen.

```js
fastify.get('/teapot', async function (request, reply) {
  const err = new Error()
  err.statusCode = 418
  err.message = 'short and stout'
  throw err
})

fastify.get('/botnet', async function (request, reply) {
  throw { statusCode: 418, message: 'short and stout' }
  // will return to the client the same json
})
```

Wenn Sie mehr wissen möchten, lesen Sie bitte
[Routes#async-await](./Routes.md#async-await).

### .then(fulfilled, rejected)
<a id="then"></a>

Wie der Name vermuten lässt, kann auf ein `Reply`-Objekt gewartet werden, d. h.
`await reply` wartet, bis die Reply gesendet ist. Die `await`-Syntax ruft
`reply.then()` auf.

`reply.then(fulfilled, rejected)` akzeptiert zwei Parameter:

- `fulfilled` wird aufgerufen, wenn eine Response vollständig gesendet wurde,
- `rejected` wird aufgerufen, wenn im zugrunde liegenden Stream ein Fehler auftrat,
  z. B. wenn der Socket zerstört wurde.

Weitere Einzelheiten finden Sie unter:

- https://github.com/fastify/fastify/issues/1864 für die Diskussion zu diesem
  Feature
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/then
  für die Signatur
