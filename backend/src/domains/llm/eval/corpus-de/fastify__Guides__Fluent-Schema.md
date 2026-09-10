<h1 align="center">Fastify</h1>

## Fluent Schema

Die Dokumentation zu [Validierung und
Serialisierung](../Reference/Validation-and-Serialization.md) beschreibt alle Parameter, die Fastify akzeptiert, um die JSON-Schema-Validierung für die Prüfung der Eingaben und die JSON-Schema-Serialisierung zur Optimierung der Ausgabe einzurichten.

[`fluent-json-schema`](https://github.com/fastify/fluent-json-schema) kann verwendet werden,
um diese Aufgabe zu vereinfachen und dabei die Wiederverwendung von Konstanten zu ermöglichen.

### Grundlegende Einstellungen

```js
const S = require('fluent-json-schema')

// You can have an object like this, or query a DB to get the values
const MY_KEYS = {
  KEY1: 'ONE',
  KEY2: 'TWO'
}

const bodyJsonSchema = S.object()
  .prop('someKey', S.string())
  .prop('someOtherKey', S.number())
  .prop('requiredKey', S.array().maxItems(3).items(S.integer()).required())
  .prop('nullableKey', S.mixed([S.TYPES.NUMBER, S.TYPES.NULL]))
  .prop('multipleTypesKey', S.mixed([S.TYPES.BOOLEAN, S.TYPES.NUMBER]))
  .prop('multipleRestrictedTypesKey', S.oneOf([S.string().maxLength(5), S.number().minimum(10)]))
  .prop('enumKey', S.enum(Object.values(MY_KEYS)))
  .prop('notTypeKey', S.not(S.array()))

const queryStringJsonSchema = S.object()
  .prop('name', S.string())
  .prop('excitement', S.integer())

const paramsJsonSchema = S.object()
  .prop('par1', S.string())
  .prop('par2', S.integer())

const headersJsonSchema = S.object()
  .prop('x-foo', S.string().required())

// Note that there is no need to call `.valueOf()`!
const schema = {
  body: bodyJsonSchema,
  querystring: queryStringJsonSchema, // (or) query: queryStringJsonSchema
  params: paramsJsonSchema,
  headers: headersJsonSchema
}

fastify.post('/the/url', { schema }, handler)
```

### Wiederverwendung

Mit `fluent-json-schema` kannst du deine Schemas einfacher und programmatisch
bearbeiten und sie dank der Methode `addSchema()` anschließend wiederverwenden. Du kannst
auf zwei verschiedene Arten auf das Schema verweisen, die in der Dokumentation zu
[Validierung und
Serialisierung](../Reference/Validation-and-Serialization.md#adding-a-shared-schema)
im Detail beschrieben sind.

Hier einige Anwendungsbeispiele:

**`$ref-way`**: Verweis auf ein externes Schema.

```js
const addressSchema = S.object()
  .id('#address')
  .prop('line1').required()
  .prop('line2')
  .prop('country').required()
  .prop('city').required()
  .prop('zipcode').required()

const commonSchemas = S.object()
  .id('https://fastify/demo')
  .definition('addressSchema', addressSchema)
  .definition('otherSchema', otherSchema) // You can add any schemas you need

fastify.addSchema(commonSchemas)

const bodyJsonSchema = S.object()
  .prop('residence', S.ref('https://fastify/demo#address')).required()
  .prop('office', S.ref('https://fastify/demo#/definitions/addressSchema')).required()

const schema = { body: bodyJsonSchema }

fastify.post('/the/url', { schema }, handler)
```


**`replace-way`**: Verweis auf ein gemeinsames Schema, das vor dem Validierungsvorgang
ersetzt wird.

```js
const sharedAddressSchema = {
  $id: 'sharedAddress',
  type: 'object',
  required: ['line1', 'country', 'city', 'zipcode'],
  properties: {
    line1: { type: 'string' },
    line2: { type: 'string' },
    country: { type: 'string' },
    city: { type: 'string' },
    zipcode: { type: 'string' }
  }
}
fastify.addSchema(sharedAddressSchema)

const bodyJsonSchema = {
  type: 'object',
  properties: {
    vacation: 'sharedAddress#'
  }
}

const schema = { body: bodyJsonSchema }

fastify.post('/the/url', { schema }, handler)
```

> ℹ️ Hinweis:
> Du kannst den `$ref-way` und den `replace-way`
> bei der Verwendung von `fastify.addSchema` mischen.
