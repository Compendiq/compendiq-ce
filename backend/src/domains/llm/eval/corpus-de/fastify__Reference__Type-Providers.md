<h1 align="center">Fastify</h1>

## Type Provider

Type Provider sind eine TypeScript-Funktion, die es Fastify ermöglicht,
Typinformationen aus inline notiertem JSON Schema abzuleiten. Sie sind eine
Alternative dazu, generische Argumente an Routen anzugeben, und können den
Aufwand reduzieren, für jedes Schema im Projekt zugehörige Typen zu pflegen.

### Provider

Die offiziellen Type-Provider-Pakete folgen der Namenskonvention
`@fastify/type-provider-{provider-name}`.
Außerdem sind mehrere Provider aus der Community verfügbar.

Die folgenden Inferenz-Pakete werden unterstützt:

- [`json-schema-to-ts`](https://github.com/ThomasAribart/json-schema-to-ts)
- [`typebox`](https://github.com/sinclairzx81/typebox)
- [`zod`](https://github.com/colinhacks/zod)

Siehe auch die jeweiligen Type-Provider-Wrapper-Pakete für die einzelnen Pakete:

- [`@fastify/type-provider-json-schema-to-ts`](https://github.com/fastify/fastify-type-provider-json-schema-to-ts)
- [`@fastify/type-provider-typebox`](https://github.com/fastify/fastify-type-provider-typebox)
- [`@fastify/type-provider-zod`](https://github.com/fastify/fastify-type-provider-zod)

### Json Schema to Ts

Folgendermaßen richten Sie einen `json-schema-to-ts`-Type-Provider ein:

```bash
$ npm i @fastify/type-provider-json-schema-to-ts
```

```typescript
import Fastify from 'fastify'
import { JsonSchemaToTsProvider } from '@fastify/type-provider-json-schema-to-ts'

const server = Fastify().withTypeProvider<JsonSchemaToTsProvider>()

server.get('/route', {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        foo: { type: 'number' },
        bar: { type: 'string' },
      },
      required: ['foo', 'bar']
    }
  }
}, (request, reply) => {

  // type Query = { foo: number, bar: string }
  const { foo, bar } = request.query // type safe!
})
```

Wenn Sie rohe JSON-Schema-Objekte mit `JsonSchemaToTsProvider` verwenden, muss
TypeScript die exakten Literalwerte im Schema sehen können. Inline notierte
Schemas wie im obigen Beispiel werden aus dem Routenaufruf abgeleitet. Wird das
Schema in eine eigene Variable ausgelagert, verwenden Sie `as const`:

```typescript
const querystringSchema = {
  type: 'object',
  properties: {
    foo: { type: 'number' },
    bar: { type: 'string' },
  },
  required: ['foo', 'bar']
} as const
```

Ohne `as const` kann TypeScript Schemawerte wie `type: 'object'` zu
`type: string` verallgemeinern, was `json-schema-to-ts` daran hindert, die
Routentypen abzuleiten. Diese Assertion hat keinerlei Auswirkung auf das Schema,
das Fastify zur Laufzeit verwendet.

### TypeBox

Folgendermaßen richten Sie einen TypeBox-Type-Provider ein:

```bash
$ npm i typebox @fastify/type-provider-typebox
```

```typescript
import Fastify from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

const server = Fastify().withTypeProvider<TypeBoxTypeProvider>()

server.get('/route', {
  schema: {
    querystring: Type.Object({
      foo: Type.Number(),
      bar: Type.String()
    })
  }
}, (request, reply) => {

  // type Query = { foo: number, bar: string }
  const { foo, bar } = request.query // type safe!
})
```

In der [TypeBox-Dokumentation](https://sinclairzx81.github.io/typebox/)
erfahren Sie, wie Sie AJV für die Zusammenarbeit mit TypeBox einrichten.

### Zod

Folgendermaßen richten Sie einen Zod-Type-Provider ein:

```bash
$ npm i zod @fastify/type-provider-zod
```

```typescript
import fastify from 'fastify'
import { ZodTypeProvider, serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { z } from 'zod/v4'

const server = fastify()
server.setValidatorCompiler(validatorCompiler)
server.setSerializerCompiler(serializerCompiler)

server.withTypeProvider<ZodTypeProvider>().get('/route', {
  schema: {
    querystring: z.object({
      foo: z.number(),
      bar: z.string()
    })
  }
}, (request, reply) => {

  // type Query = { foo: number, bar: string }
  const { foo, bar } = request.query // type safe!
})
```

### Gekapselter Type Provider

Die Provider-Typen propagieren nicht global. Im gekapselten Einsatz lässt sich
der Kontext neu abbilden, um einen oder mehrere Provider zu nutzen (so können
etwa `typebox` und `json-schema-to-ts` in derselben Anwendung verwendet werden).

Beispiel:

```ts
import Fastify from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { JsonSchemaToTsProvider } from '@fastify/type-provider-json-schema-to-ts'
import { Type } from 'typebox'

const fastify = Fastify()

function pluginWithTypebox(fastify: FastifyInstance, _opts, done): void {
  fastify.withTypeProvider<TypeBoxTypeProvider>()
    .get('/', {
      schema: {
        body: Type.Object({
          x: Type.String(),
          y: Type.Number(),
          z: Type.Boolean()
        })
      }
    }, (req) => {
        const { x, y, z } = req.body // type safe
    });
  done()
}

function pluginWithJsonSchema(fastify: FastifyInstance, _opts, done): void {
  fastify.withTypeProvider<JsonSchemaToTsProvider>()
    .get('/', {
      schema: {
        body: {
          type: 'object',
          properties: {
            x: { type: 'string' },
            y: { type: 'number' },
            z: { type: 'boolean' }
          },
        }
      }
    }, (req) => {
      const { x, y, z } = req.body // type safe
    });
  done()
}

fastify.register(pluginWithJsonSchema)
fastify.register(pluginWithTypebox)
```

Wichtig ist: Da die Typen nicht global propagieren, lässt es sich derzeit nicht
vermeiden, Routen bei mehreren Scopes mehrfach zu registrieren, wie unten
gezeigt:

```ts
import Fastify from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { Type } from 'typebox'

const server = Fastify().withTypeProvider<TypeBoxTypeProvider>()

server.register(plugin1) // wrong
server.register(plugin2) // correct

function plugin1(fastify: FastifyInstance, _opts, done): void {
  fastify.get('/', {
    schema: {
      body: Type.Object({
        x: Type.String(),
        y: Type.Number(),
        z: Type.Boolean()
      })
    }
  }, (req) => {
    // In a new scope, call `withTypeProvider` again to ensure it works
    const { x, y, z } = req.body
  });
  done()
}

function plugin2(fastify: FastifyInstance, _opts, done): void {
  const server = fastify.withTypeProvider<TypeBoxTypeProvider>()

  server.get('/', {
    schema: {
      body: Type.Object({
        x: Type.String(),
        y: Type.Number(),
        z: Type.Boolean()
      })
    }
  }, (req) => {
    // works
    const { x, y, z } = req.body
  });
  done()
}
```

### Typdefinition von FastifyInstance + TypeProvider

Wenn Sie mit Modulen arbeiten, verwenden Sie `FastifyInstance` mit den
Type-Provider-Generics. Siehe das folgende Beispiel:

```ts
// index.ts
import Fastify from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import { registerRoutes } from './routes'

const server = Fastify().withTypeProvider<TypeBoxTypeProvider>()

registerRoutes(server)

server.listen({ port: 3000 })
```

```ts
// routes.ts
import { Type } from 'typebox'
import {
  FastifyInstance,
  FastifyBaseLogger,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'

type FastifyTypebox = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  FastifyBaseLogger,
  TypeBoxTypeProvider
>;

export function registerRoutes(fastify: FastifyTypebox): void {
  fastify.get('/', {
    schema: {
      body: Type.Object({
        x: Type.String(),
        y: Type.Number(),
        z: Type.Boolean()
      })
    }
  }, (req) => {
    // works
    const { x, y, z } = req.body
  });
}
```
