<h1 align="center">Fastify</h1>

## Kapselung
<a id="encapsulation"></a>

Ein grundlegendes Merkmal von Fastify ist der „Kapselungskontext“. Er bestimmt, welche [Decorators](./Decorators.md), registrierten [Hooks](./Hooks.md) und [Plugins](./Plugins.md) für [Routes](./Routes.md) verfügbar sind. Eine visuelle Darstellung des Kapselungskontexts zeigt die folgende Abbildung:

![Figure 1](../resources/encapsulation_context.svg)

In der Abbildung oben gibt es mehrere Entitäten:

1. Den _Root-Kontext_
2. Drei _Root-Plugins_
3. Zwei _Kind-Kontexte_, jeweils mit:
    * Zwei _Kind-Plugins_
    * Einem _Enkel-Kontext_, jeweils mit:
        - Drei _Kind-Plugins_

Jeder _Kind-Kontext_ und _Enkel-Kontext_ hat Zugriff auf die _Root-Plugins_. Innerhalb jedes _Kind-Kontexts_ haben die _Enkel-Kontexte_ Zugriff auf die _Kind-Plugins_, die im umgebenden _Kind-Kontext_ registriert sind, aber der umgebende _Kind-Kontext_ hat **keinen** Zugriff auf die _Kind-Plugins_, die in seinem _Enkel-Kontext_ registriert sind.

Da in Fastify alles außer dem _Root-Kontext_ ein [Plugin](./Plugins.md) ist, ist jeder „Kontext“ und jedes „Plugin“ in diesem Beispiel ein Plugin, das aus Decorators, Hooks, Plugins und Routes bestehen kann. Als Plugins müssen sie weiterhin ihren Abschluss signalisieren, entweder indem sie ein Promise zurückgeben (z. B. über `async`-Funktionen) oder indem sie die Funktion `done` aufrufen, sofern der Callback-Stil verwendet wird.

Um dieses Beispiel konkret zu machen, betrachte ein einfaches Szenario eines REST-API-Servers mit drei Routes: Die erste Route (`/one`) erfordert Authentifizierung, die zweite Route (`/two`) nicht, und die dritte Route (`/three`) hat Zugriff auf denselben Kontext wie die zweite Route. Mit [@fastify/bearer-auth][bearer] für die Authentifizierung sieht der Code für dieses Beispiel so aus:

```js
'use strict'

const fastify = require('fastify')()

fastify.decorateRequest('answer', 42)

fastify.register(async function authenticatedContext (childServer) {
  childServer.register(require('@fastify/bearer-auth'), { keys: ['abc123'] })

  childServer.route({
    path: '/one',
    method: 'GET',
    handler (request, reply) {
      reply.send({
        answer: request.answer,
        // request.foo will be undefined as it is only defined in publicContext
        foo: request.foo,
        // request.bar will be undefined as it is only defined in grandchildContext
        bar: request.bar
      })
    }
  })
})

fastify.register(async function publicContext (childServer) {
  childServer.decorateRequest('foo', 'foo')

  childServer.route({
    path: '/two',
    method: 'GET',
    handler (request, reply) {
      reply.send({
        answer: request.answer,
        foo: request.foo,
        // request.bar will be undefined as it is only defined in grandchildContext
        bar: request.bar
      })
    }
  })

  childServer.register(async function grandchildContext (grandchildServer) {
    grandchildServer.decorateRequest('bar', 'bar')

    grandchildServer.route({
      path: '/three',
      method: 'GET',
      handler (request, reply) {
        reply.send({
          answer: request.answer,
          foo: request.foo,
          bar: request.bar
        })
      }
    })
  })
})

fastify.listen({ port: 8000 })
```

Das obige Server-Beispiel veranschaulicht die Kapselungskonzepte aus dem ursprünglichen Diagramm:

1. Jeder _Kind-Kontext_ (`authenticatedContext`, `publicContext` und `grandchildContext`) hat Zugriff auf den Request-Decorator `answer`, der im _Root-Kontext_ definiert ist.
2. Nur `authenticatedContext` hat Zugriff auf das Plugin `@fastify/bearer-auth`.
3. Sowohl `publicContext` als auch `grandchildContext` haben Zugriff auf den Request-Decorator `foo`.
4. Nur `grandchildContext` hat Zugriff auf den Request-Decorator `bar`.

Um das zu sehen, starte den Server und setze Requests ab:

```sh
curl -H 'authorization: Bearer abc123' http://127.0.0.1:8000/one
# {"answer":42}
curl http://127.0.0.1:8000/two
# {"answer":42,"foo":"foo"}
curl http://127.0.0.1:8000/three
# {"answer":42,"foo":"foo","bar":"bar"}
```

[bearer]: https://github.com/fastify/fastify-bearer-auth

## Gemeinsame Nutzung zwischen Kontexten
<a id="shared-context"></a>

Jeder Kontext im vorherigen Beispiel erbt _ausschließlich_ von seinen Eltern-Kontexten. Eltern-Kontexte können nicht auf Entitäten innerhalb ihrer Nachfahren-Kontexte zugreifen. Falls nötig, kann die Kapselung mit [fastify-plugin][fastify-plugin] aufgebrochen werden, wodurch alles, was in einem Nachfahren-Kontext registriert wurde, für den Eltern-Kontext verfügbar wird.

Damit `publicContext` auf den Decorator `bar` aus `grandchildContext` zugreifen kann, aktualisiere den Code wie folgt:

```js
'use strict'

const fastify = require('fastify')()
const fp = require('fastify-plugin')

fastify.decorateRequest('answer', 42)

// `authenticatedContext` omitted for clarity

fastify.register(async function publicContext (childServer) {
  childServer.decorateRequest('foo', 'foo')

  childServer.route({
    path: '/two',
    method: 'GET',
    handler (request, reply) {
      reply.send({
        answer: request.answer,
        foo: request.foo,
        bar: request.bar
      })
    }
  })

  childServer.register(fp(grandchildContext))

  async function grandchildContext (grandchildServer) {
    grandchildServer.decorateRequest('bar', 'bar')

    grandchildServer.route({
      path: '/three',
      method: 'GET',
      handler (request, reply) {
        reply.send({
          answer: request.answer,
          foo: request.foo,
          bar: request.bar
        })
      }
    })
  }
})

fastify.listen({ port: 8000 })
```

Nach einem Neustart des Servers und erneutem Absetzen der Requests für `/two` und `/three`:

```sh
curl http://127.0.0.1:8000/two
# {"answer":42,"foo":"foo","bar":"bar"}
curl http://127.0.0.1:8000/three
# {"answer":42,"foo":"foo","bar":"bar"}
```

`fastify-plugin` bricht die Kapselung nur für das Plugin auf, das es umschließt. Plugins, die darin ohne `fastify-plugin` registriert werden, erzeugen weiterhin neue gekapselte Kontexte:

```js
'use strict'

const fastify = require('fastify')()
const fp = require('fastify-plugin')

fastify.register(fp(async function sharedContext (childServer) {
  childServer.decorate('foo', 'foo')

  childServer.register(async function encapsulatedContext (grandchildServer) {
    grandchildServer.decorate('bar', 'bar')
  })
}))

await fastify.ready()

console.log(fastify.foo) // 'foo'
console.log(fastify.bar) // undefined
```

Der Decorator `foo` ist im Root-Kontext verfügbar, weil er direkt von dem mit `fastify-plugin` umschlossenen Plugin hinzugefügt wird. Der verschachtelte `register`-Aufruf erzeugt weiterhin einen Enkel-Kontext, sodass der Decorator `bar` nur in diesem Kontext und seinen Kindern verfügbar bleibt.

[fastify-plugin]: https://github.com/fastify/fastify-plugin
