# Migrationsleitfaden V5

Dieser Leitfaden soll bei der Migration von Fastify v4 auf v5 helfen.

Bevor du auf v5 migrierst, stelle bitte sicher, dass du alle Deprecation-Warnungen aus v4 behoben hast. Alle Deprecations aus v4 wurden entfernt und funktionieren nach dem Upgrade nicht mehr.

## Long-Term-Support-Zyklus

Fastify v5 unterstützt ausschließlich Node.js v20+. Wenn du eine ältere Node.js-Version verwendest, musst du auf eine neuere Version aktualisieren, um Fastify v5 einsetzen zu können.

Fastify v4 wird noch bis zum 30. Juni 2025 unterstützt. Wenn du nicht aktualisieren kannst, solltest du in Betracht ziehen, einen End-of-Life-Supportvertrag bei HeroDevs abzuschließen.

### Warum Node.js v20?

Fastify v5 unterstützt ausschließlich Node.js v20+, weil sich diese Version deutlich von v18 unterscheidet, etwa durch bessere Unterstützung für `node:test`. Das erlaubt uns, eine bessere Developer Experience zu bieten und die Wartung zu straffen.

Node.js v18 verlässt den Long Term Support am 30. April 2025, du solltest ein Upgrade auf v20 also ohnehin einplanen.

## Breaking Changes

### Für `querystring`, `params`, `body` und Response-Schemas ist nun ein vollständiges JSON-Schema erforderlich

Ab v5 verlangt Fastify ein vollständiges JSON-Schema für die Schemas `querystring`, `params` und `body`. Beachte, dass auch die Option `jsonShortHand` entfernt wurde.

Wenn der standardmäßige JSON-Schema-Validator verwendet wird, musst du für die Schemas `querystring`, `params`, `body` und `response` ein vollständiges JSON-Schema bereitstellen, einschließlich der Eigenschaft `type`.

```js
// v4
fastify.get('/route', {
  schema: {
    querystring: {
      name: { type: 'string' }
    }
  }
}, (req, reply) => {
  reply.send({ hello: req.query.name });
});
```

```js
// v5
fastify.get('/route', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        name: { type: 'string' }
      },
      required: ['name']
    }
  }
}, (req, reply) => {
  reply.send({ hello: req.query.name });
});
```

Weitere Details siehe [#5586](https://github.com/fastify/fastify/pull/5586)

Beachte, dass es weiterhin möglich ist, den JSON-Schema-Validator zu überschreiben, um ein anderes Format zu verwenden, etwa Zod. Diese Änderung vereinfacht das ebenfalls.

Diese Änderung erleichtert die Integration anderer Werkzeuge wie [`@fastify/swagger`](https://github.com/fastify/fastify-swagger).

### Neue Konstruktor-Signatur für den Logger

In Fastify v4 nahm Fastify in der Option `logger` sowohl die Optionen zum Erzeugen eines pino-Loggers als auch eine eigene Logger-Instanz entgegen. Das war die Quelle erheblicher Verwirrung.

Daher akzeptiert die Option `logger` in v5 keine eigene Logger-Instanz mehr. Um einen eigenen Logger zu verwenden, solltest du stattdessen die Option `loggerInstance` nutzen:

```js
// v4
const logger = require('pino')();
const fastify = require('fastify')({
  logger
});
```

```js
// v5
const loggerInstance = require('pino')();
const fastify = require('fastify')({
  loggerInstance
});
```

### `useSemicolonDelimiter` standardmäßig false

Ab v5 unterstützen Fastify-Instanzen Semikolon-Trennzeichen im Querystring nicht mehr standardmäßig, wie es in v4 der Fall war. Grund dafür ist, dass es sich um nicht standardkonformes Verhalten handelt, das [RFC 3986](https://datatracker.ietf.org/doc/html/rfc3986#section-3.4) nicht entspricht.

Wenn du weiterhin Semikola als Trennzeichen verwenden möchtest, kannst du das tun, indem du in der Serverkonfiguration `useSemicolonDelimiter: true` setzt.

```js
const fastify = require('fastify')({
  useSemicolonDelimiter: true
});
```

### Das parameters-Objekt hat keinen Prototyp mehr

In v4 hatte das Objekt `parameters` einen Prototyp. In v5 ist das nicht mehr der Fall. Das bedeutet, dass du auf dem Objekt `parameters` nicht mehr auf von `Object` geerbte Eigenschaften wie `toString` oder `hasOwnProperty` zugreifen kannst.

```js
// v4
fastify.get('/route/:name', (req, reply) => {
  console.log(req.params.hasOwnProperty('name')); // true
  return { hello: req.params.name };
});
```

```js
// v5
fastify.get('/route/:name', (req, reply) => {
  console.log(Object.hasOwn(req.params, 'name')); // true
  return { hello: req.params.name };
});
```

Das erhöht die Sicherheit der Anwendung, indem es sie gegen Prototype-Pollution-Angriffe härtet.

### Type Provider unterscheiden nun zwischen Validator- und Serializer-Schemas

In v4 hatten die Type Provider dieselben Typen für Validierung und Serialisierung. In v5 wurden die Type Provider in zwei getrennte Typen aufgeteilt: `ValidatorSchema` und `SerializerSchema`.

[`@fastify/type-provider-json-schema-to-ts`](https://github.com/fastify/fastify-type-provider-json-schema-to-ts) und [`@fastify/type-provider-typebox`](https://github.com/fastify/fastify-type-provider-typebox) wurden bereits aktualisiert: Aktualisiere auf die neueste Version, um die neuen Typen zu erhalten. Wenn du einen eigenen Type Provider verwendest, musst du ihn wie folgt anpassen:

```
--- a/index.ts
+++ b/index.ts
@@ -11,7 +11,8 @@ import {
 import { FromSchema, FromSchemaDefaultOptions, FromSchemaOptions, JSONSchema } from 'json-schema-to-ts'

 export interface JsonSchemaToTsProvider<
   Options extends FromSchemaOptions = FromSchemaDefaultOptions
 > extends FastifyTypeProvider {
-  output: this['input'] extends JSONSchema ? FromSchema<this['input'], Options> : unknown;
+  validator: this['schema'] extends JSONSchema ? FromSchema<this['schema'], Options> : unknown;
+  serializer: this['schema'] extends JSONSchema ? FromSchema<this['schema'], Options> : unknown;
 }
 ```

### Änderungen an der Methode .listen()

Die variadische Argumentsignatur der Methode `.listen()` wurde entfernt. Das bedeutet, dass du `.listen()` nicht mehr mit einer variablen Anzahl von Argumenten aufrufen kannst.

```js
// v4
fastify.listen(8000)
```

Wird zu:

```js
// v5
fastify.listen({ port: 8000 })
```

Das war in v4 bereits als `FSTDEP011` deprecated, du solltest deinen Code also bereits auf die neue Signatur umgestellt haben.

### Direkte Rückgabe von Trailern wurde entfernt

In v4 konntest du Trailer direkt aus einem Handler zurückgeben. In v5 ist das nicht mehr möglich.

```js
// v4
fastify.get('/route', (req, reply) => {
  reply.trailer('ETag', function (reply, payload) {
    return 'custom-etag'
  })
  reply.send('')
});
```

```js
// v5
fastify.get('/route', (req, reply) => {
  reply.trailer('ETag', async function (reply, payload) {
    return 'custom-etag'
  })
  reply.send('')
});
```

Ein Callback konnte ebenfalls verwendet werden. Das war in v4 bereits als `FSTDEP013` deprecated, du solltest deinen Code also bereits auf die neue Signatur umgestellt haben.

### Vereinheitlichter Zugriff auf die Route-Definition

Alle als deprecated markierten Eigenschaften für den Zugriff auf die Route-Definition wurden entfernt; der Zugriff erfolgt nun über `request.routeOptions`.

| Code | Beschreibung | Lösung | Diskussion |
| ---- | ----------- | ------------ | ---------- |
| FSTDEP012 | Du versuchst, auf die deprecated Eigenschaft `request.context` zuzugreifen. | Verwende `request.routeOptions.config` oder `request.routeOptions.schema`. | [#4216](https://github.com/fastify/fastify/pull/4216) [#5084](https://github.com/fastify/fastify/pull/5084) |
| FSTDEP015 | Du greifst auf die deprecated Eigenschaft `request.routeSchema` zu. | Verwende `request.routeOptions.schema`. | [#4470](https://github.com/fastify/fastify/pull/4470) |
| FSTDEP016 | Du greifst auf die deprecated Eigenschaft `request.routeConfig` zu. | Verwende `request.routeOptions.config`. | [#4470](https://github.com/fastify/fastify/pull/4470) |
| FSTDEP017 | Du greifst auf die deprecated Eigenschaft `request.routerPath` zu. | Verwende `request.routeOptions.url`. | [#4470](https://github.com/fastify/fastify/pull/4470) |
| FSTDEP018 | Du greifst auf die deprecated Eigenschaft `request.routerMethod` zu. | Verwende `request.routeOptions.method`. | [#4470](https://github.com/fastify/fastify/pull/4470) |
| FSTDEP019 | Du greifst auf die deprecated Eigenschaft `reply.context` zu. | Verwende `reply.routeOptions.config` oder `reply.routeOptions.schema`. | [#5032](https://github.com/fastify/fastify/pull/5032) [#5084](https://github.com/fastify/fastify/pull/5084) |

Weitere Informationen siehe [#5616](https://github.com/fastify/fastify/pull/5616).

### `reply.redirect()` hat eine neue Signatur

Die Methode `reply.redirect()` hat eine neue Signatur: `reply.redirect(url: string, code?: number)`.

```js
// v4
reply.redirect(301, '/new-route')
```

Ändere es zu:

```js
// v5
reply.redirect('/new-route', 301)
```

Das war in v4 bereits als `FSTDEP021` deprecated, du solltest deinen Code also bereits auf die neue Signatur umgestellt haben.


### Das Ändern von `reply.sent` ist nun verboten

In v4 konntest du die Eigenschaft `reply.sent` ändern, um zu verhindern, dass die Response gesendet wird. In v5 ist das nicht mehr möglich, verwende stattdessen `reply.hijack()`.

```js
// v4
fastify.get('/route', (req, reply) => {
  reply.sent = true;
  reply.raw.end('hello');
});
```

Ändere es zu:

```js
// v5
fastify.get('/route', (req, reply) => {
  reply.hijack();
  reply.raw.end('hello');
});
```

Das war in v4 bereits als `FSTDEP010` deprecated, du solltest deinen Code also bereits auf die neue Signatur umgestellt haben.

### Signaturänderungen bei Constraints für Route-Versionierung

Wir haben die Signatur für Constraints zur Route-Versionierung geändert. Die Optionen `version` und `versioning` wurden entfernt; du solltest stattdessen die Option `constraints` verwenden.

| Code | Beschreibung | Lösung | Diskussion |
| ---- | ----------- | ------------ | ---------- |
| FSTDEP008 | Du verwendest Route-Constraints über die Route-Option `{version: "..."}`.  |  Verwende die Option `{constraints: {version: "..."}}`.  | [#2682](https://github.com/fastify/fastify/pull/2682) |
| FSTDEP009 | Du verwendest eine eigene Strategie zur Route-Versionierung über die Server-Option `{versioning: "..."}`. |  Verwende die Option `{constraints: {version: "..."}}`.  | [#2682](https://github.com/fastify/fastify/pull/2682) |

### `HEAD`-Routes müssen bei `exposeHeadRoutes: true` vor `GET` registriert werden

Wir haben eine strengere Anforderung an eigene `HEAD`-Routes, wenn `exposeHeadRoutes: true` gesetzt ist.

Wenn du eine eigene `HEAD`-Route bereitstellst, musst du entweder `exposeHeadRoutes` explizit auf `false` setzen

```js
// v4
fastify.get('/route', {

}, (req, reply) => {
  reply.send({ hello: 'world' });
});

fastify.head('/route', (req, reply) => {
  // ...
});
```

```js
// v5
fastify.get('/route', {
  exposeHeadRoutes: false
}, (req, reply) => {
  reply.send({ hello: 'world' });
});

fastify.head('/route', (req, reply) => {
  // ...
});
```

oder die `HEAD`-Route vor `GET` platzieren.

```js
// v5
fastify.head('/route', (req, reply) => {
  // ...
});

fastify.get('/route', {

}, (req, reply) => {
  reply.send({ hello: 'world' });
});
```

Das wurde in [#2700](https://github.com/fastify/fastify/pull/2700) geändert, und das alte Verhalten war in v4 als `FSTDEP007` deprecated.

### `request.connection` entfernt

Die Eigenschaft `request.connection` wurde in v5 entfernt. Du solltest stattdessen `request.socket` verwenden.

```js
// v4
fastify.get('/route', (req, reply) => {
  console.log(req.connection.remoteAddress);
  return { hello: 'world' };
});
```

```js
// v5
fastify.get('/route', (req, reply) => {
  console.log(req.socket.remoteAddress);
  return { hello: 'world' };
});
```

Das war in v4 bereits als `FSTDEP05` deprecated, du solltest deinen Code also bereits auf die neue Signatur umgestellt haben.

### `reply.getResponseTime()` wurde entfernt, verwende stattdessen `reply.elapsedTime`

Die Methode `reply.getResponseTime()` wurde in v5 entfernt. Du solltest stattdessen `reply.elapsedTime` verwenden.

```js
// v4
fastify.get('/route', (req, reply) => {
  console.log(reply.getResponseTime());
  return { hello: 'world' };
});
```

```js
// v5
fastify.get('/route', (req, reply) => {
  console.log(reply.elapsedTime);
  return { hello: 'world' };
});
```

Das war in v4 bereits als `FSTDEP20` deprecated, du solltest deinen Code also bereits auf die neue Signatur umgestellt haben.

### `fastify.hasRoute()` entspricht nun dem Verhalten von `find-my-way`

Die Methode `fastify.hasRoute()` entspricht nun dem Verhalten von `find-my-way` und verlangt, dass die Route-Definition so übergeben wird, wie sie in der Route definiert ist.

```js
// v4
fastify.get('/example/:file(^\\d+).png', function (request, reply) { })

console.log(fastify.hasRoute({
  method: 'GET',
  url: '/example/12345.png'
)); // true
```

```js
// v5

fastify.get('/example/:file(^\\d+).png', function (request, reply) { })

console.log(fastify.hasRoute({
  method: 'GET',
  url: '/example/:file(^\\d+).png'
)); // true
```

### Entfernung einiger nicht standardkonformer HTTP-Methoden

Wir haben die folgenden HTTP-Methoden aus Fastify entfernt:
- `PROPFIND`
- `PROPPATCH`
- `MKCOL`
- `COPY`
- `MOVE`
- `LOCK`
- `UNLOCK`
- `TRACE`
- `SEARCH`

Es ist nun möglich, sie über die Methode `addHttpMethod` wieder hinzuzufügen.

```js
const fastify = Fastify()

// add a new http method on top of the default ones:
fastify.addHttpMethod('REBIND')

// add a new HTTP method that accepts a body:
fastify.addHttpMethod('REBIND', { hasBody: true })

// reads the HTTP methods list:
fastify.supportedMethods // returns a string array
```

Weitere Informationen siehe [#5567](https://github.com/fastify/fastify/pull/5567).

### Unterstützung für Referenztypen in Decorators entfernt

Request/Reply mit einem Referenztyp (`Array`, `Object`) zu dekorieren ist nun verboten, da diese Referenz von allen Requests geteilt wird.

```js
// v4
fastify.decorateRequest('myObject', { hello: 'world' });
```

```js
// v5
fastify.decorateRequest('myObject');
fastify.addHook('onRequest', async (req, reply) => {
  req.myObject = { hello: 'world' };
});
```

oder mache eine Funktion daraus

```js
// v5
fastify.decorateRequest('myObject', () => ({ hello: 'world' }));
```

oder einen Getter

```js
// v5
fastify.decorateRequest('myObject', {
  getter () {
    return { hello: 'world' }
  }
});
```

Weitere Informationen siehe [#5462](https://github.com/fastify/fastify/pull/5462).

### Unterstützung für DELETE mit einem `Content-Type: application/json`-Header und leerem Body entfernt

In v4 erlaubte Fastify `DELETE`-Requests mit einem `Content-Type: application/json`-Header, und ein leerer Body wurde akzeptiert. In v5 ist das nicht mehr erlaubt.

Weitere Informationen siehe [#5419](https://github.com/fastify/fastify/pull/5419).

### Plugins dürfen Callback- und Promise-API nicht mehr mischen

In v4 konnten Plugins die Callback- und die Promise-API mischen, was zu unerwartetem Verhalten führte. In v5 ist das nicht mehr erlaubt.

```js
// v4
fastify.register(async function (instance, opts, done) {
  done();
});
```

```js
// v5
fastify.register(async function (instance, opts) {
  return;
});
```

oder

```js
// v5
fastify.register(function (instance, opts, done) {
  done();
});
```

### Requests haben nun `host`, `hostname` und `port`, und `hostname` enthält nicht mehr die Portnummer

In Fastify v4 enthielt `req.hostname` sowohl den Hostnamen als auch den Port des Servers, lokal konnte der Wert also `localhost:1234` lauten. Mit v5 haben wir uns am URL-Objekt von Node.js orientiert und stellen nun die Eigenschaften `host`, `hostname` und `port` bereit. `req.host` hat denselben Wert wie `req.hostname` in v4, während `req.hostname` den Hostnamen _ohne_ Port enthält, sofern ein Port vorhanden ist, und `req.port` nur die Portnummer enthält. Weitere Informationen siehe [#4766](https://github.com/fastify/fastify/pull/4766) und [#4682](https://github.com/fastify/fastify/issues/4682).

### Entfernt die Methoden `getDefaultRoute` und `setDefaultRoute`

Die Methoden `getDefaultRoute` und `setDefaultRoute` wurden in v5 entfernt.

Weitere Informationen siehe [#4485](https://github.com/fastify/fastify/pull/4485) und [#4480](https://github.com/fastify/fastify/pull/4480). Das war in v4 bereits als `FSTDEP014` deprecated, du solltest deinen Code also bereits angepasst haben.

### Die Formate `time` und `date-time` erzwingen eine Zeitzone

Der aktualisierte AJV-Compiler aktualisiert `ajv-formats`, das nun die Verwendung einer Zeitzone in den Formaten `time` und `date-time` erzwingt. Eine Übergangslösung ist die Verwendung der Formate `iso-time` und `iso-date-time`, die aus Gründen der Abwärtskompatibilität eine optionale Zeitzone unterstützen. Siehe die [vollständige Diskussion](https://github.com/fastify/fluent-json-schema/issues/267).

## Neue Funktionen

### Unterstützung für Diagnostic Channel

Fastify v5 unterstützt nun die [Diagnostics Channel](https://nodejs.org/api/diagnostics_channel.html)-API nativ und bietet eine Möglichkeit, den Lebenszyklus eines Requests nachzuverfolgen.

```js
'use strict'

const diagnostics = require('node:diagnostics_channel')
const Fastify = require('fastify')

diagnostics.subscribe('tracing:fastify.request.handler:start', (msg) => {
  console.log(msg.route.url) // '/:id'
  console.log(msg.route.method) // 'GET'
})

diagnostics.subscribe('tracing:fastify.request.handler:end', (msg) => {
  // msg is the same as the one emitted by the 'tracing:fastify.request.handler:start' channel
  console.log(msg)
})

diagnostics.subscribe('tracing:fastify.request.handler:error', (msg) => {
  // in case of error
})

const fastify = Fastify()
fastify.route({
  method: 'GET',
  url: '/:id',
  handler: function (req, reply) {
    return { hello: 'world' }
  }
})

fastify.listen({ port: 0 }, async function () {
  const result = await fetch(fastify.listeningOrigin + '/7')

  t.assert.ok(result.ok)
  t.assert.strictEqual(response.status, 200)
  t.assert.deepStrictEqual(await result.json(), { hello: 'world' })
})
```

Weitere Details siehe die [Dokumentation](https://github.com/fastify/fastify/blob/main/docs/Reference/Hooks.md#diagnostics-channel-hooks) und [#5252](https://github.com/fastify/fastify/pull/5252).

## Mitwirkende

Die vollständige Liste der Mitwirkenden über alle zentralen Fastify-Pakete hinweg findest du unten. Ziehe bitte in Betracht, jene zu unterstützen, die Sponsoring annehmen können.

| Mitwirkende:r | Sponsoring-Link | Pakete |
| --- | --- | --- |
| 10xLaCroixDrinker | [❤️ sponsern](https://github.com/sponsors/10xLaCroixDrinker) | fastify-cli |
| Bram-dc |  | fastify; fastify-swagger |
| BrianValente |  | fastify |
| BryanAbate |  | fastify-cli |
| Cadienvan | [❤️ sponsern](https://github.com/sponsors/Cadienvan) | fastify |
| Cangit |  | fastify |
| Cyberlane |  | fastify-elasticsearch |
| Eomm | [❤️ sponsern](https://github.com/sponsors/Eomm) | ajv-compiler; fastify; fastify-awilix; fastify-diagnostics-channel; fastify-elasticsearch; fastify-hotwire; fastify-mongodb; fastify-nextjs; fastify-swagger-ui; under-pressure |
| EstebanDalelR | [❤️ sponsern](https://github.com/sponsors/EstebanDalelR) | fastify-cli |
| Fdawgs | [❤️ sponsern](https://github.com/sponsors/Fdawgs) | aws-lambda-fastify; csrf-protection; env-schema; fastify; fastify-accepts; fastify-accepts-serializer; fastify-auth; fastify-awilix; fastify-basic-auth; fastify-bearer-auth; fastify-caching; fastify-circuit-breaker; fastify-cli; fastify-cookie; fastify-cors; fastify-diagnostics-channel; fastify-elasticsearch; fastify-env; fastify-error; fastify-etag; fastify-express; fastify-flash; fastify-formbody; fastify-funky; fastify-helmet; fastify-hotwire; fastify-http-proxy; fastify-jwt; fastify-kafka; fastify-leveldb; fastify-mongodb; fastify-multipart; fastify-mysql; fastify-nextjs; fastify-oauth2; fastify-passport; fastify-plugin; fastify-postgres; fastify-rate-limit; fastify-redis; fastify-reply-from; fastify-request-context; fastify-response-validation; fastify-routes; fastify-routes-stats; fastify-schedule; fastify-secure-session; fastify-sensible; fastify-swagger-ui; fastify-url-data; fastify-websocket; fastify-zipkin; fluent-json-schema; forwarded; middie; point-of-view; process-warning; proxy-addr; safe-regex2; secure-json-parse; under-pressure |
| Gehbt |  | fastify-secure-session |
| Gesma94 |  | fastify-routes-stats |
| H4ad | [❤️ sponsern](https://github.com/sponsors/H4ad) | aws-lambda-fastify |
| JohanManders |  | fastify-secure-session |
| LiviaMedeiros |  | fastify |
| Momy93 |  | fastify-secure-session |
| MunifTanjim |  | fastify-swagger-ui |
| Nanosync |  | fastify-secure-session |
| RafaelGSS | [❤️ sponsern](https://github.com/sponsors/RafaelGSS) | fastify; under-pressure |
| Rantoledo |  | fastify |
| SMNBLMRR |  | fastify |
| SimoneDevkt |  | fastify-cli |
| Tony133 |  | fastify |
| Uzlopak | [❤️ sponsern](https://github.com/sponsors/Uzlopak) | fastify; fastify-autoload; fastify-diagnostics-channel; fastify-hotwire; fastify-nextjs; fastify-passport; fastify-plugin; fastify-rate-limit; fastify-routes; fastify-static; fastify-swagger-ui; point-of-view; under-pressure |
| Zamiell |  | fastify-secure-session |
| aadito123 |  | fastify |
| aaroncadillac | [❤️ sponsern](https://github.com/sponsors/aaroncadillac) | fastify |
| aarontravass |  | fastify |
| acro5piano | [❤️ sponsern](https://github.com/sponsors/acro5piano) | fastify-secure-session |
| adamward459 |  | fastify-cli |
| adrai | [❤️ sponsern](https://github.com/sponsors/adrai) | aws-lambda-fastify |
| alenap93 |  | fastify |
| alexandrucancescu |  | fastify-nextjs |
| anthonyringoet |  | aws-lambda-fastify |
| arshcodemod |  | fastify |
| autopulated |  | point-of-view |
| barbieri |  | fastify |
| beyazit |  | fastify |
| big-kahuna-burger | [❤️ sponsern](https://github.com/sponsors/big-kahuna-burger) | fastify-cli; fastify-compress; fastify-helmet |
| bilalshareef |  | fastify-routes |
| blue86321 |  | fastify-swagger-ui |
| bodinsamuel |  | fastify-rate-limit |
| busybox11 | [❤️ sponsern](https://github.com/sponsors/busybox11) | fastify |
| climba03003 |  | csrf-protection; fastify; fastify-accepts; fastify-accepts-serializer; fastify-auth; fastify-basic-auth; fastify-bearer-auth; fastify-caching; fastify-circuit-breaker; fastify-compress; fastify-cors; fastify-env; fastify-etag; fastify-flash; fastify-formbody; fastify-http-proxy; fastify-mongodb; fastify-swagger-ui; fastify-url-data; fastify-websocket; middie |
| dancastillo | [❤️ sponsern](https://github.com/sponsors/dancastillo) | fastify; fastify-basic-auth; fastify-caching; fastify-circuit-breaker; fastify-cors; fastify-helmet; fastify-passport; fastify-response-validation; fastify-routes; fastify-schedule |
| danny-andrews |  | fastify-kafka |
| davidcralph | [❤️ sponsern](https://github.com/sponsors/davidcralph) | csrf-protection |
| davideroffo |  | under-pressure |
| dhensby |  | fastify-cli |
| dmkng |  | fastify |
| domdomegg |  | fastify |
| faustman |  | fastify-cli |
| floridemai |  | fluent-json-schema |
| fox1t |  | fastify-autoload |
| giuliowaitforitdavide |  | fastify |
| gunters63 |  | fastify-reply-from |
| gurgunday |  | fastify; fastify-circuit-breaker; fastify-cookie; fastify-multipart; fastify-mysql; fastify-rate-limit; fastify-response-validation; fastify-sensible; fastify-swagger-ui; fluent-json-schema; middie; proxy-addr; safe-regex2; secure-json-parse |
| ildella |  | under-pressure |
| james-kaguru |  | fastify |
| jcbain |  | fastify-http-proxy |
| jdhollander |  | fastify-swagger-ui |
| jean-michelet |  | fastify; fastify-autoload; fastify-cli; fastify-mysql; fastify-sensible |
| johaven |  | fastify-multipart |
| jordanebelanger |  | fastify-plugin |
| jscheffner |  | fastify |
| jsprw |  | fastify-secure-session |
| jsumners | [❤️ sponsern](https://github.com/sponsors/jsumners) | ajv-compiler; avvio; csrf-protection; env-schema; fast-json-stringify; fastify; fastify-accepts; fastify-accepts-serializer; fastify-auth; fastify-autoload; fastify-awilix; fastify-basic-auth; fastify-bearer-auth; fastify-caching; fastify-circuit-breaker; fastify-compress; fastify-cookie; fastify-cors; fastify-env; fastify-error; fastify-etag; fastify-express; fastify-flash; fastify-formbody; fastify-funky; fastify-helmet; fastify-http-proxy; fastify-jwt; fastify-kafka; fastify-leveldb; fastify-multipart; fastify-mysql; fastify-oauth2; fastify-plugin; fastify-postgres; fastify-redis; fastify-reply-from; fastify-request-context; fastify-response-validation; fastify-routes; fastify-routes-stats; fastify-schedule; fastify-secure-session; fastify-sensible; fastify-static; fastify-swagger; fastify-swagger-ui; fastify-url-data; fastify-websocket; fastify-zipkin; fluent-json-schema; forwarded; light-my-request; middie; process-warning; proxy-addr; safe-regex2; secure-json-parse; under-pressure |
| karankraina |  | under-pressure |
| kerolloz | [❤️ sponsern](https://github.com/sponsors/kerolloz) | fastify-jwt |
| kibertoad |  | fastify-rate-limit |
| kukidon-dev |  | fastify-passport |
| kunal097 |  | fastify |
| lamweili |  | fastify-sensible |
| lemonclown |  | fastify-mongodb |
| liuhanqu |  | fastify |
| matthyk |  | fastify-plugin |
| mch-dsk |  | fastify |
| mcollina | [❤️ sponsern](https://github.com/sponsors/mcollina) | ajv-compiler; avvio; csrf-protection; fastify; fastify-accepts; fastify-accepts-serializer; fastify-auth; fastify-autoload; fastify-awilix; fastify-basic-auth; fastify-bearer-auth; fastify-caching; fastify-circuit-breaker; fastify-cli; fastify-compress; fastify-cookie; fastify-cors; fastify-diagnostics-channel; fastify-elasticsearch; fastify-env; fastify-etag; fastify-express; fastify-flash; fastify-formbody; fastify-funky; fastify-helmet; fastify-http-proxy; fastify-jwt; fastify-kafka; fastify-leveldb; fastify-multipart; fastify-mysql; fastify-oauth2; fastify-passport; fastify-plugin; fastify-postgres; fastify-rate-limit; fastify-redis; fastify-reply-from; fastify-request-context; fastify-response-validation; fastify-routes; fastify-routes-stats; fastify-schedule; fastify-secure-session; fastify-static; fastify-swagger; fastify-swagger-ui; fastify-url-data; fastify-websocket; fastify-zipkin; fluent-json-schema; light-my-request; middie; point-of-view; proxy-addr; secure-json-parse; under-pressure |
| melroy89 | [❤️ sponsern](https://github.com/sponsors/melroy89) | under-pressure |
| metcoder95 | [❤️ sponsern](https://github.com/sponsors/metcoder95) | fastify-elasticsearch |
| mhamann |  | fastify-cli |
| mihaur |  | fastify-elasticsearch |
| mikesamm |  | fastify |
| mikhael-abdallah |  | secure-json-parse |
| miquelfire | [❤️ sponsern](https://github.com/sponsors/miquelfire) | fastify-routes |
| miraries |  | fastify-swagger-ui |
| mohab-sameh |  | fastify |
| monish001 |  | fastify |
| moradebianchetti81 |  | fastify |
| mouhannad-sh |  | aws-lambda-fastify |
| multivoltage |  | point-of-view |
| muya | [❤️ sponsern](https://github.com/sponsors/muya) | under-pressure |
| mweberxyz |  | point-of-view |
| nflaig |  | fastify |
| nickfla1 |  | avvio |
| o-az |  | process-warning |
| ojeytonwilliams |  | csrf-protection |
| onosendi |  | fastify-formbody |
| philippviereck |  | fastify |
| pip77 |  | fastify-mongodb |
| puskin94 |  | fastify |
| remidewitte |  | fastify |
| rozzilla |  | fastify |
| samialdury |  | fastify-cli |
| sknetl |  | fastify-cors |
| sourcecodeit |  | fastify |
| synapse |  | env-schema |
| timursaurus |  | secure-json-parse |
| tlhunter |  | fastify |
| tlund101 |  | fastify-rate-limit |
| ttshivers |  | fastify-http-proxy |
| voxpelli | [❤️ sponsern](https://github.com/sponsors/voxpelli) | fastify |
| weixinwu |  | fastify-cli |
| zetaraku |  | fastify-cli |
