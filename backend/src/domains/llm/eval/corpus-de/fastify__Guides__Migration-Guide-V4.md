# Migrationsleitfaden V4

Dieser Leitfaden soll bei der Migration von Fastify v3 auf v4 helfen.

Bevor du auf v4 migrierst, stelle bitte sicher, dass du alle Deprecation-Warnungen aus v3 behoben hast. Alle Deprecations aus v3 wurden entfernt und funktionieren nach dem Upgrade nicht mehr.

## Codemods
### Fastify-v4-Codemods

Um beim Upgrade zu helfen, haben wir mit dem Team von [Codemod](https://github.com/codemod/codemod) zusammengearbeitet und Codemods veröffentlicht, die deinen Code automatisch auf viele der neuen APIs und Muster in Fastify v4 aktualisieren.


```bash
npx codemod@latest fastify/4/migration-recipe
```
Damit werden die folgenden Codemods angewendet:

- fastify/4/remove-app-use
- fastify/4/reply-raw-access
- fastify/4/wrap-routes-plugin
- fastify/4/await-register-calls

Informationen zum Migrations-Rezept findest du unter
https://app.codemod.com/registry/fastify/4/migration-recipe.


## Breaking Changes

### Komposition der Fehlerbehandlung ([#3261](https://github.com/fastify/fastify/pull/3261))

Wenn in einer asynchronen Error-Handler-Funktion ein Fehler geworfen wird, wird der übergeordnete Error-Handler ausgeführt, sofern gesetzt. Gibt es keinen übergeordneten Error-Handler, wird wie bisher der Standard-Handler ausgeführt:

```js
import Fastify from 'fastify'

const fastify = Fastify()

fastify.register(async fastify => {
  fastify.setErrorHandler(async err => {
    console.log(err.message) // 'kaboom'
    throw new Error('caught')
  })

  fastify.get('/encapsulated', async () => {
    throw new Error('kaboom')
  })
})

fastify.setErrorHandler(async err => {
  console.log(err.message) // 'caught'
  throw new Error('wrapped')
})

const res = await fastify.inject('/encapsulated')
console.log(res.json().message) // 'wrapped'
```

>Der Root-Error-Handler ist Fastifys generischer Error-Handler.
>Dieser Error-Handler verwendet die Header und den Statuscode aus dem Error-Objekt,
>sofern vorhanden. **Header und Statuscode werden nicht automatisch gesetzt, wenn
>ein eigener Error-Handler bereitgestellt wird**.

### `app.use()` entfernt ([#3506](https://github.com/fastify/fastify/pull/3506))

Mit Fastify v4 wurde `app.use()` entfernt und die Verwendung von Middleware wird nicht mehr unterstützt.

Wenn du Middleware benötigst, verwende [`@fastify/middie`](https://github.com/fastify/middie) oder [`@fastify/express`](https://github.com/fastify/fastify-express), die weiterhin gepflegt werden. Es wird jedoch dringend empfohlen, auf Fastifys [Hooks](../Reference/Hooks.md) zu migrieren.

> ℹ️ Hinweis:
> `app.use()` per Codemod entfernen mit:
> ```bash
> npx codemod@latest fastify/4/remove-app-use
> ```

### `reply.res` nach `reply.raw` verschoben

Wenn du zuvor das Attribut `reply.res` verwendet hast, um auf das zugrunde liegende Request-Objekt zuzugreifen, musst du nun `reply.raw` verwenden.

> ℹ️ Hinweis:
> `reply.res` per Codemod nach `reply.raw` überführen mit:
> ```bash
> npx codemod@latest fastify/4/reply-raw-access
> ```

### `return reply` nötig, um eine „Verzweigung“ der Promise-Kette zu signalisieren

In manchen Situationen, etwa wenn eine Response asynchron gesendet wird oder wenn du nicht explizit eine Response zurückgibst, musst du nun das Argument `reply` aus deinem Router-Handler zurückgeben.

### `exposeHeadRoutes` standardmäßig true

Ab v4 erzeugt jede `GET`-Route eine gleichrangige `HEAD`-Route. Du kannst dieses Verhalten rückgängig machen, indem du in den Server-Optionen `exposeHeadRoutes: false` setzt.

### Synchrone Route-Definitionen ([#2954](https://github.com/fastify/fastify/pull/2954))

Um die Fehlerberichterstattung bei Route-Definitionen zu verbessern, erfolgt die Registrierung von Routes nun synchron. Wenn du daher in einem Plugin einen `onRoute`-Hook angibst, solltest du nun entweder:
* deine Routes in ein Plugin einpacken (empfohlen)

  Zum Beispiel dies umbauen:
  ```js
  fastify.register((instance, opts, done) => {
    instance.addHook('onRoute', (routeOptions) => {
      const { path, method } = routeOptions;
      console.log({ path, method });
      done();
    });
  });

  fastify.get('/', (request, reply) => { reply.send('hello') });
  ```

  Zu diesem:
  ```js
  fastify.register((instance, opts, done) => {
    instance.addHook('onRoute', (routeOptions) => {
      const { path, method } = routeOptions;
      console.log({ path, method });
      done();
    });
  });

  fastify.register((instance, opts, done) => {
    instance.get('/', (request, reply) => { reply.send('hello') });
    done();
  });
  ```

> ℹ️ Hinweis:
> Synchrone Route-Definitionen per Codemod umsetzen mit:
> ```bash
> npx codemod@latest fastify/4/wrap-routes-plugin
> ```

* `await register(...)` verwenden

  Zum Beispiel dies umbauen:
  ```js
  fastify.register((instance, opts, done) => {
    instance.addHook('onRoute', (routeOptions) => {
      const { path, method } = routeOptions;
      console.log({ path, method });
    });
    done();
  });
  ```

  Zu diesem:
  ```js
  await fastify.register((instance, opts, done) => {
    instance.addHook('onRoute', (routeOptions) => {
      const { path, method } = routeOptions;
      console.log({ path, method });
    });
    done();
  });
  ```

> ℹ️ Hinweis:
> 'await register(...)' per Codemod umsetzen mit:
> ```bash
> npx codemod@latest fastify/4/await-register-calls
> ```


### Optionale URL-Parameter

Wenn du bereits implizit optionale Parameter verwendet hast, erhältst du beim Zugriff auf die Route einen 404-Fehler. Du musst die optionalen Parameter nun explizit deklarieren.

Wenn du zum Beispiel dieselbe Route zum Auflisten und Anzeigen eines Posts hast, baue dies um:
```js
fastify.get('/posts/:id', (request, reply) => {
  const { id } = request.params;
});
```

Zu diesem:
```js
fastify.get('/posts/:id?', (request, reply) => {
  const { id } = request.params;
});
```

## Nicht brechende Änderungen

### Deprecation der variadischen `.listen()`-Signatur

Die [variadische Signatur](https://en.wikipedia.org/wiki/Variadic_function) der Methode `fastify.listen()` ist nun deprecated.

Vor diesem Release waren die folgenden Aufrufe dieser Methode gültig:

  - `fastify.listen(8000)`
  - `fastify.listen(8000, ‘127.0.0.1’)`
  - `fastify.listen(8000, ‘127.0.0.1’, 511)`
  - `fastify.listen(8000, (err) => { if (err) throw err })`
  - `fastify.listen({ port: 8000 }, (err) => { if (err) throw err })`

Mit Fastify v4 sind nur noch die folgenden Aufrufe gültig:

  - `fastify.listen()`
  - `fastify.listen({ port: 8000 })`
  - `fastify.listen({ port: 8000 }, (err) => { if (err) throw err })`

### Schema-Änderung bei mehreren Typen

Ajv wurde in Fastify v4 auf v8 aktualisiert, was bedeutet, dass „type“-Keywords mit mehreren Typen außer „null“ [nun verboten sind](https://ajv.js.org/strict-mode.html#strict-types).

Möglicherweise siehst du eine Konsolenwarnung wie:
```sh
strict mode: use allowUnionTypes to allow union type keyword at "#/properties/image" (strictTypes)
```

Entsprechend müssen Schemas wie das folgende geändert werden, von:
```js
{
  type: 'object',
  properties: {
    api_key: { type: 'string' },
    image: { type: ['object', 'array'] }
  }
}
```

Zu:
```js
{
  type: 'object',
  properties: {
    api_key: { type: 'string' },
    image: {
      anyOf: [
        { type: 'array' },
        { type: 'object' }
      ]
    }
  }
}
```

### Methoden `reply.trailers` hinzugefügt ([#3794](https://github.com/fastify/fastify/pull/3794))

Fastify unterstützt nun die [HTTP Trailer]-Response-Header.


[HTTP Trailer]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Trailer
