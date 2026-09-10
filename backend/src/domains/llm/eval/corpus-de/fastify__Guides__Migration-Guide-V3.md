# Migrationsleitfaden V3

Dieser Leitfaden soll bei der Migration von Fastify v2 auf v3 helfen.

Stelle bitte vor dem Beginn sicher, dass alle Deprecation-Warnungen aus v2 behoben sind. Alle Deprecations aus v2 wurden entfernt und funktionieren nach dem Upgrade nicht mehr. ([#1750](https://github.com/fastify/fastify/pull/1750))

## Breaking Changes

### Geänderte Middleware-Unterstützung ([#2014](https://github.com/fastify/fastify/pull/2014))

Ab Fastify v3 bringt das Framework selbst keine Middleware-Unterstützung mehr von Haus aus mit.

Wenn du Express-Middleware in deiner Anwendung verwendest, installiere und registriere zuvor bitte das Plugin [`@fastify/express`](https://github.com/fastify/fastify-express) oder [`@fastify/middie`](https://github.com/fastify/middie).

**v2:**

```js
// Using the Express `cors` middleware in Fastify v2.
fastify.use(require('cors')());
```

**v3:**

```js
// Using the Express `cors` middleware in Fastify v3.
await fastify.register(require('@fastify/express'));
fastify.use(require('cors')());
```

### Geänderte Log-Serialisierung ([#2017](https://github.com/fastify/fastify/pull/2017))

Die [Serializer](../Reference/Logging.md) für das Logging wurden aktualisiert und erhalten nun Fastifys [`Request`](../Reference/Request.md)- und [`Reply`](../Reference/Reply.md)-Objekte statt der nativen Objekte.

Alle eigenen Serializer müssen angepasst werden, wenn sie sich auf `request`- oder `reply`-Eigenschaften stützen, die auf den nativen Objekten vorhanden sind, auf den Fastify-Objekten jedoch nicht.

**v2:**

```js
const fastify = require('fastify')({
  logger: {
    serializers: {
      res(res) {
        return {
          statusCode: res.statusCode,
          customProp: res.customProp
        };
      }
    }
  }
});
```

**v3:**

```js
const fastify = require('fastify')({
  logger: {
    serializers: {
      res(reply) {
        return {
          statusCode: reply.statusCode, // No change required
          customProp: reply.raw.customProp // Log custom property from res object
        };
      }
    }
  }
});
```

### Geänderte Schema-Substitution ([#2023](https://github.com/fastify/fastify/pull/2023))

Die nicht standardkonforme Unterstützung für geteilte Schemas nach dem `replace-way`-Prinzip wurde entfernt. Diese Funktion wurde durch eine an die JSON-Schema-Spezifikation angelehnte Substitution auf `$ref`-Basis ersetzt. Zum besseren Verständnis dieser Änderung lies [Validation and Serialization in Fastify v3](https://dev.to/eomm/validation-and-serialization-in-fastify-v3-2e8l).

**v2:**

```js
const schema = {
  body: 'schemaId#'
};
fastify.route({ method, url, schema, handler });
```

**v3:**

```js
const schema = {
  body: {
    $ref: 'schemaId#'
  }
};
fastify.route({ method, url, schema, handler });
```

### Geänderte Optionen zur Schema-Validierung ([#2023](https://github.com/fastify/fastify/pull/2023))

Die Optionen `setSchemaCompiler` und `setSchemaResolver` wurden durch `setValidatorCompiler` ersetzt, um künftige Verbesserungen im Tooling zu ermöglichen. Zum besseren Verständnis dieser Änderung lies [Validation and Serialization in Fastify v3](https://dev.to/eomm/validation-and-serialization-in-fastify-v3-2e8l).

**v2:**

```js
const fastify = Fastify();
const ajv = new AJV();
ajv.addSchema(schemaA);
ajv.addSchema(schemaB);

fastify.setSchemaCompiler(schema => ajv.compile(schema));
fastify.setSchemaResolver(ref => ajv.getSchema(ref).schema);
```

**v3:**

```js
const fastify = Fastify();
const ajv = new AJV();
ajv.addSchema(schemaA);
ajv.addSchema(schemaB);

fastify.setValidatorCompiler(({ schema, method, url, httpPart }) =>
  ajv.compile(schema)
);
```

### Geändertes Verhalten des preParsing-Hooks ([#2286](https://github.com/fastify/fastify/pull/2286))

Ab Fastify v3 ändert sich das Verhalten des `preParsing`-Hooks leicht, um die Manipulation des Request-Payloads zu unterstützen.

Der Hook nimmt nun ein zusätzliches Argument, `payload`, entgegen, sodass die neue Hook-Signatur `fn(request, reply, payload, done)` bzw. `async fn(request, reply, payload)` lautet.

Der Hook kann optional über `done(null, stream)` einen neuen Stream zurückgeben oder – bei async-Funktionen – den Stream direkt zurückgeben.

Gibt der Hook einen neuen Stream zurück, wird dieser in nachfolgenden Hooks anstelle des ursprünglichen verwendet. Ein Beispielanwendungsfall dafür ist die Behandlung komprimierter Requests.

Der neue Stream sollte die Eigenschaft `receivedEncodedLength` am Stream ergänzen, die die tatsächliche vom Client empfangene Datenmenge widerspiegeln soll. Bei einem komprimierten Request sollte das etwa die Größe des komprimierten Payloads sein. Diese Eigenschaft kann (und sollte) während der `data`-Events dynamisch aktualisiert werden.

Die alte Syntax von Fastify v2 ohne Payload wird weiterhin unterstützt, ist aber deprecated.

### Geändertes Verhalten der Hooks ([#2004](https://github.com/fastify/fastify/pull/2004))

Ab Fastify v3 ändert sich das Verhalten der Hooks `onRoute` und `onRegister` leicht, um Hook-Kapselung zu unterstützen.

- `onRoute` – Der Hook wird asynchron aufgerufen. Der Hook wird nun vererbt, wenn ein neues Plugin innerhalb desselben Kapselungs-Scopes registriert wird. Dieser Hook sollte daher registriert werden, _bevor_ irgendwelche Plugins registriert werden.
- `onRegister` – Wie beim onRoute-Hook. Der einzige Unterschied besteht darin, dass der allererste Aufruf nun nicht mehr vom Framework selbst stammt, sondern vom ersten registrierten Plugin.

### Geänderte Syntax des Content Type Parsers ([#2286](https://github.com/fastify/fastify/pull/2286))

In Fastify v3 haben die Content-Type-Parser nun eine einheitliche Signatur.

Die neuen Signaturen lauten `fn(request, payload, done)` bzw. `async fn(request, payload)`. Beachte, dass `request` nun ein Fastify-Request ist und keine `IncomingMessage`. Das Payload ist standardmäßig ein Stream. Wird die Option `parseAs` in `addContentTypeParser` verwendet, entspricht `payload` dem Wert der Option (String oder Buffer).

Die alten Signaturen `fn(req, [done])` bzw. `fn(req, payload, [done])` (wobei `req` eine `IncomingMessage` ist) werden weiterhin unterstützt, sind aber deprecated.

### Geänderte TypeScript-Unterstützung

Das Typsystem wurde in Fastify Version 3 geändert. Das neue Typsystem führt generische Constraints und Defaults ein sowie eine neue Möglichkeit, Schematypen wie Request-Body, Querystring und mehr zu definieren!

**v2:**

```ts
interface PingQuerystring {
  foo?: number;
}

interface PingParams {
  bar?: string;
}

interface PingHeaders {
  a?: string;
}

interface PingBody {
  baz?: string;
}

server.get<PingQuerystring, PingParams, PingHeaders, PingBody>(
  '/ping/:bar',
  opts,
  (request, reply) => {
    console.log(request.query); // This is of type `PingQuerystring`
    console.log(request.params); // This is of type `PingParams`
    console.log(request.headers); // This is of type `PingHeaders`
    console.log(request.body); // This is of type `PingBody`
  }
);
```

**v3:**

```ts
server.get<{
  Querystring: PingQuerystring;
  Params: PingParams;
  Headers: PingHeaders;
  Body: PingBody;
}>('/ping/:bar', opts, async (request, reply) => {
  console.log(request.query); // This is of type `PingQuerystring`
  console.log(request.params); // This is of type `PingParams`
  console.log(request.headers); // This is of type `PingHeaders`
  console.log(request.body); // This is of type `PingBody`
});
```

### Umgang mit nicht abgefangenen Exceptions ([#2073](https://github.com/fastify/fastify/pull/2073))

In synchronen Route-Handlern stürzte der Server bei einem geworfenen Fehler bewusst ab, ohne den konfigurierten `.setErrorHandler()` aufzurufen. Das hat sich geändert: Nun werden alle unerwarteten Fehler in synchronen und asynchronen Routes behandelt.

**v2:**

```js
fastify.setErrorHandler((error, request, reply) => {
  // this is NOT called
  reply.send(error)
})
fastify.get('/', (request, reply) => {
  const maybeAnArray = request.body.something ? [] : 'I am a string'
  maybeAnArray.substr() // Thrown: [].substr is not a function and crash the server
})
```

**v3:**

```js
fastify.setErrorHandler((error, request, reply) => {
  // this IS called
  reply.send(error)
})
fastify.get('/', (request, reply) => {
  const maybeAnArray = request.body.something ? [] : 'I am a string'
  maybeAnArray.substr() // Thrown: [].substr is not a function, but it is handled
})
```

## Weitere Ergänzungen und Verbesserungen

- Hooks haben nun einen konsistenten Kontext, unabhängig davon, wie sie registriert werden
  ([#2005](https://github.com/fastify/fastify/pull/2005))
- `request.req` und `reply.res` zugunsten von
  [`request.raw`](../Reference/Request.md) und
  [`reply.raw`](../Reference/Reply.md) als deprecated markiert
  ([#2008](https://github.com/fastify/fastify/pull/2008))
- Option `modifyCoreObjects` entfernt
  ([#2015](https://github.com/fastify/fastify/pull/2015))
- Option [`connectionTimeout`](../Reference/Server.md#factory-connection-timeout)
  hinzugefügt ([#2086](https://github.com/fastify/fastify/pull/2086))
- Option [`keepAliveTimeout`](../Reference/Server.md#factory-keep-alive-timeout)
  hinzugefügt ([#2086](https://github.com/fastify/fastify/pull/2086))
- async-await-Unterstützung für [Plugins](../Reference/Plugins.md#async-await) hinzugefügt
  ([#2093](https://github.com/fastify/fastify/pull/2093))
- Möglichkeit hinzugefügt, ein Objekt als Fehler zu werfen
  ([#2134](https://github.com/fastify/fastify/pull/2134))
