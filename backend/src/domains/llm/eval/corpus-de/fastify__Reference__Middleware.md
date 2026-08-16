<h1 align="center">Fastify</h1>

## Middleware

Seit Fastify v3.0.0 wird Middleware nicht mehr ab Werk unterstützt und erfordert
ein externes Plugin wie
[`@fastify/express`](https://github.com/fastify/fastify-express) oder
[`@fastify/middie`](https://github.com/fastify/middie).

Das folgende Beispiel registriert das Plugin `@fastify/express` und verwendet
Express-Middleware:

```js
await fastify.register(require('@fastify/express'))
fastify.use(require('cors')())
fastify.use(require('dns-prefetch-control')())
fastify.use(require('frameguard')())
fastify.use(require('hsts')())
fastify.use(require('ienoopen')())
fastify.use(require('x-xss-protection')())
```

Es kann auch [`@fastify/middie`](https://github.com/fastify/middie) verwendet werden,
das einfache Middleware im Express-Stil mit besserer Performance unterstützt:

```js
await fastify.register(require('@fastify/middie'))
fastify.use(require('cors')())
```

Middleware kann mit `register` gekapselt werden, was steuert, wo sie ausgeführt wird,
wie im [Plugins-Guide](../Guides/Plugins-Guide.md) erläutert.

Der Grund dafür ist, dass Fastify die eingehenden Node.js-Objekte `req` und `res` nach
der Middleware-Phase in [Request](./Request.md#request)- und [Reply](./Reply.md#reply)-Instanzen
verpackt. Folglich stellt Fastify-Middleware weder die Methode `send` noch andere Methoden
bereit, die spezifisch für die Fastify-[Reply](./Reply.md#reply)-Instanz sind. Verwenden Sie
zum Erstellen von Middleware die Node.js-Objekte `req` und `res`. Alternativ können Sie den
`preHandler`-Hook nutzen, der Zugriff auf die Fastify-Instanzen
[Request](./Request.md#request) und [Reply](./Reply.md#reply) hat. Weitere
Informationen finden Sie unter [Hooks](./Hooks.md).

### Die Ausführung von Middleware auf bestimmte Pfade beschränken
<a id="restrict-usage"></a>

Um Middleware auf bestimmte Pfade zu beschränken, übergeben Sie den Pfad als erstes Argument an
`use`.

> ℹ️ Hinweis:
> Routen mit Parametern werden dabei nicht unterstützt
> (z. B. `/user/:id/comments`). Wildcards werden bei mehreren Pfaden nicht unterstützt.

```js
const path = require('node:path')
const serveStatic = require('serve-static')

// Single path
fastify.use('/css', serveStatic(path.join(__dirname, '/assets')))

// Wildcard path
fastify.use('/css/(.*)', serveStatic(path.join(__dirname, '/assets')))

// Multiple paths
fastify.use(['/css', '/js'], serveStatic(path.join(__dirname, '/assets')))
```

### Fastify-Alternativen

Fastify bietet native Alternativen zu häufig verwendeter Middleware, etwa
[`@fastify/helmet`](https://github.com/fastify/fastify-helmet) für
[`helmet`](https://github.com/helmetjs/helmet),
[`@fastify/cors`](https://github.com/fastify/fastify-cors) für
[`cors`](https://github.com/expressjs/cors) und
[`@fastify/static`](https://github.com/fastify/fastify-static) für
[`serve-static`](https://github.com/expressjs/serve-static).
