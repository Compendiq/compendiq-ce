<h1 align="center">Fastify</h1>

## `Content-Type`-Parser
Fastify unterstützt die Content-Types `'application/json'` und `'text/plain'`
nativ, mit `utf-8` als Standard-Zeichensatz. Diese Standardparser lassen sich
ändern oder entfernen.

Nicht unterstützte Content-Types lösen einen Fehler
`FST_ERR_CTP_INVALID_MEDIA_TYPE` aus.

Um weitere Content-Types zu unterstützen, verwenden Sie die API
`addContentTypeParser` oder ein bestehendes
[Plugin](https://fastify.dev/ecosystem/).

Wie andere APIs ist auch `addContentTypeParser` in dem Scope gekapselt, in dem es
deklariert wird. Im Root-Scope deklariert, ist es überall verfügbar; in einem
Plugin deklariert, nur in diesem Scope und dessen Kindern.

Fastify hängt den geparsten Request-Payload automatisch an das
[Fastify-Request](./Request.md)-Objekt, erreichbar über `request.body`.

> **Wichtig:** Wenn Sie ein Body-Schema mit der Eigenschaft
> [`content`](./Validation-and-Serialization.md#body-content-type-validation)
> verwenden, um pro Content-Type zu validieren, werden nur die im Schema
> aufgeführten Content-Types validiert. Wenn Sie einen eigenen
> Content-Type-Parser hinzufügen, dessen Content-Type aber nicht in der
> `content`-Eigenschaft des Body-Schemas aufführen, werden die eingehenden Daten
> zwar geparst, aber **nicht validiert**.

Beachten Sie, dass der Payload bei `GET`- und `HEAD`-Requests nie geparst wird.
Bei `OPTIONS`- und `DELETE`-Requests wird der Payload nur geparst, wenn ein
gültiger `content-type`-Header mitgeliefert wird. Anders als bei `POST`, `PUT`
und `PATCH` wird der [Catch-All](#catch-all)-Parser nicht ausgeführt und der
Payload schlicht nicht geparst.

> ⚠ Warnung:
> Wenn Sie reguläre Ausdrücke verwenden, um den `Content-Type` zu erkennen, ist
> es wichtig, auf eine korrekte Erkennung zu achten. Um beispielsweise
> `application/*` zu treffen, verwenden Sie `/^application\/([\w-]+);?/`, damit
> ausschließlich der
> [essenzielle MIME-Typ](https://mimesniff.spec.whatwg.org/#mime-type-miscellaneous)
> getroffen wird.
>
> Wenn die Route zudem eine Body-Validierung pro Content-Type über
> `schema.body.content` nutzt, wird das Schema über eine **exakte
> Übereinstimmung** des essenziellen MIME-Typs ausgewählt, nicht über den Regex
> des Parsers. Ein Regex-Parser, der Content-Types akzeptiert, für die es keinen
> passenden Schlüssel in der `content`-Schema-Map gibt, führt dazu, dass diese
> Requests **nicht validiert** werden. Stellen Sie sicher, dass jeder vom Regex
> getroffene Content-Type einen entsprechenden Eintrag in der `content`-Map des
> Schemas hat. Details finden Sie unter
> [Validation and Serialization](./Validation-and-Serialization.md).

### Verwendung
```js
fastify.addContentTypeParser('application/jsoff', function (request, payload, done) {
  jsoffParser(payload, function (err, body) {
    done(err, body)
  })
})

// Handle multiple content types with the same function
fastify.addContentTypeParser(['text/xml', 'application/xml'], function (request, payload, done) {
  xmlParser(payload, function (err, body) {
    done(err, body)
  })
})

// Async is also supported in Node versions >= 8.0.0
fastify.addContentTypeParser('application/jsoff', async function (request, payload) {
  const res = await jsoffParserAsync(payload)

  return res
})

// Handle all content types that matches RegExp
fastify.addContentTypeParser(/^image\/([\w-]+);?/, function (request, payload, done) {
  imageParser(payload, function (err, body) {
    done(err, body)
  })
})

// Can use default JSON/Text parser for different content Types
fastify.addContentTypeParser('text/json', { parseAs: 'string' }, fastify.getDefaultJsonParser('ignore', 'ignore'))
```

Fastify versucht zuerst, einen Content-Type-Parser mit einem `string`-Wert zu
treffen, bevor es nach einem passenden `RegExp` sucht. Bei sich überschneidenden
Content-Types beginnt es mit dem zuletzt konfigurierten und endet mit dem ersten
(last in, first out). Um einen allgemeinen Content-Type genauer zu spezifizieren,
geben Sie zuerst den allgemeinen und dann den spezifischen an, wie unten gezeigt.

```js
// Here only the second content type parser is called because its value also matches the first one
fastify.addContentTypeParser('application/vnd.custom+xml', (request, body, done) => {} )
fastify.addContentTypeParser('application/vnd.custom', (request, body, done) => {} )

// Here the desired behavior is achieved because fastify first tries to match the
// `application/vnd.custom+xml` content type parser
fastify.addContentTypeParser('application/vnd.custom', (request, body, done) => {} )
fastify.addContentTypeParser('application/vnd.custom+xml', (request, body, done) => {} )
```

### addContentTypeParser zusammen mit fastify.register verwenden
Wenn Sie `addContentTypeParser` zusammen mit `fastify.register` verwenden,
vermeiden Sie `await` beim Registrieren von Routen. Durch `await` wird die
Routenregistrierung asynchron, sodass Routen möglicherweise registriert werden,
bevor `addContentTypeParser` gesetzt ist.

#### Korrekte Verwendung
```js
const fastify = require('fastify')();


fastify.register((fastify, opts) => {
  fastify.addContentTypeParser('application/json', function (request, payload, done) {
    jsonParser(payload, function (err, body) {
      done(err, body)
    })
  })

  fastify.get('/hello', async (req, res) => {});
});
```

Neben `addContentTypeParser` stehen die APIs `hasContentTypeParser`,
`removeContentTypeParser` und `removeAllContentTypeParsers` zur Verfügung.

#### hasContentTypeParser

Verwenden Sie die API `hasContentTypeParser`, um zu prüfen, ob ein bestimmter
Content-Type-Parser existiert.

```js
if (!fastify.hasContentTypeParser('application/jsoff')){
  fastify.addContentTypeParser('application/jsoff', function (request, payload, done) {
    jsoffParser(payload, function (err, body) {
      done(err, body)
    })
  })
}
```

#### removeContentTypeParser

`removeContentTypeParser` kann einen einzelnen Content-Type oder ein Array von
Content-Types entfernen und unterstützt sowohl `string` als auch `RegExp`.

```js
fastify.addContentTypeParser('text/xml', function (request, payload, done) {
  xmlParser(payload, function (err, body) {
    done(err, body)
  })
})

// Removes the both built-in content type parsers so that only the content type parser for text/html is available
fastify.removeContentTypeParser(['application/json', 'text/plain'])
```

#### removeAllContentTypeParsers
Die API `removeAllContentTypeParsers` entfernt alle vorhandenen
Content-Type-Parser, sodass Sie nicht jeden einzeln angeben müssen. Diese API
unterstützt Kapselung und ist nützlich, um einen
[Catch-All-Content-Type-Parser](#catch-all) zu registrieren, der für jeden
Content-Type ausgeführt werden soll und die eingebauten Parser ignoriert.

```js
fastify.removeAllContentTypeParsers()

fastify.addContentTypeParser('text/xml', function (request, payload, done) {
  xmlParser(payload, function (err, body) {
    done(err, body)
  })
})
```

> ℹ️ Hinweis:
> `function(req, done)` und `async function(req)` werden
> weiterhin unterstützt, gelten aber als veraltet.

#### Body-Parser
Der Request-Body kann auf zwei Arten geparst werden. Erstens, indem Sie einen
eigenen Content-Type-Parser hinzufügen und den Request-Stream selbst behandeln.
Oder zweitens, indem Sie in der API `addContentTypeParser` die Option `parseAs`
mit `'string'` oder `'buffer'` angeben. Fastify kümmert sich dann um den Stream,
prüft die [maximale Größe](./Server.md#factory-body-limit) des Bodys sowie die
Content-Length. Wird das Limit überschritten, wird der eigene Parser nicht
aufgerufen.
```js
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
  try {
    const json = JSON.parse(body)
    done(null, json)
  } catch (err) {
    err.statusCode = 400
    done(err, undefined)
  }
})
```

Ein Beispiel finden Sie unter
[`example/parser.js`](https://github.com/fastify/fastify/blob/main/examples/parser.js).

##### Optionen für eigene Parser
+ `parseAs` (string): `'string'` oder `'buffer'`, um festzulegen, wie die
  eingehenden Daten gesammelt werden sollen. Standard: `'buffer'`.
+ `bodyLimit` (number): Die maximale Payload-Größe in Byte, die der eigene
  Parser akzeptiert. Standardmäßig gilt das globale Body-Limit, das an die
  [`Fastify-Factory-Funktion`](./Server.md#bodylimit) übergeben wurde.

#### Catch-All
Um alle Requests unabhängig vom Content-Type abzufangen, verwenden Sie den
Content-Type `'*'`:
```js
fastify.addContentTypeParser('*', function (request, payload, done) {
  let data = ''
  payload.on('data', chunk => { data += chunk })
  payload.on('end', () => {
    done(null, data)
  })
})
```
Alle Requests ohne passenden Content-Type-Parser werden von dieser Funktion
behandelt.

Das ist auch nützlich, um den Request-Stream weiterzuleiten. Definieren Sie
einen Content-Parser wie diesen:

```js
fastify.addContentTypeParser('*', function (request, payload, done) {
  done()
})
```

Und greifen Sie dann für das Piping direkt auf den HTTP-Core-Request zu:

```js
app.post('/hello', (request, reply) => {
  reply.send(request.raw)
})
```

Hier ein vollständiges Beispiel, das eingehende
[JSON-Lines](https://jsonlines.org/)-Objekte protokolliert:

```js
const split2 = require('split2')
const pump = require('pump')

fastify.addContentTypeParser('*', (request, payload, done) => {
  done(null, pump(payload, split2(JSON.parse)))
})

fastify.route({
  method: 'POST',
  url: '/api/log/jsons',
  handler: (req, res) => {
    req.body.on('data', d => console.log(d)) // log every incoming object
  }
})
 ```

Für das Piping von Datei-Uploads sehen Sie sich
[`@fastify/multipart`](https://github.com/fastify/fastify-multipart) an.

Um den Content-Type-Parser für alle Content-Types auszuführen, rufen Sie zuerst
`removeAllContentTypeParsers` auf.

```js
// Without this call, the request body with the content type application/json would be processed by the built-in JSON parser
fastify.removeAllContentTypeParsers()

fastify.addContentTypeParser('*', function (request, payload, done) {
  const data = ''
  payload.on('data', chunk => { data += chunk })
  payload.on('end', () => {
    done(null, data)
  })
})
```
