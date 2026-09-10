<h1 align="center">Fastify</h1>

## Validierung und Serialisierung
Fastify verfolgt einen schemabasierten Ansatz. Wir empfehlen, [JSON Schema](https://json-schema.org/) zu verwenden, um Routes zu validieren und Ausgaben zu serialisieren. Fastify kompiliert das Schema in eine hochperformante Funktion.

Eine Validierung wird nur versucht, wenn der Content-Type `application/json` ist, es sei denn, das Body-Schema verwendet die Eigenschaft [`content`](#body-content-type-validation), um die Validierung pro Content-Type festzulegen. Wenn das Body-Schema ein `content`-Feld definiert, muss es alle möglichen Content-Types aufzählen, die die Anwendung mit dem zugehörigen Handler verarbeiten soll.

Alle Beispiele verwenden die Spezifikation [JSON Schema Draft 7](https://json-schema.org/draft-07).

> ⚠ Warnung:
> Behandle Schema-Definitionen wie Anwendungscode. Die Funktionen zur Validierung und Serialisierung verwenden `new Function()`, was bei nutzerseitig bereitgestellten Schemas unsicher ist. Details siehe
> [Ajv](https://www.npmjs.com/package/ajv) und
> [fast-json-stringify](https://www.npmjs.com/package/fast-json-stringify).
>
> Fastify unterstützt zwar die
> [`$async`-Funktion von Ajv](https://ajv.js.org/guide/async-validation.html),
> sie sollte aber nicht für die initiale Validierung verwendet werden. Datenbankzugriffe während der
> Validierung können zu Denial-of-Service-Angriffen führen. Verwende
> [Fastifys Hooks](./Hooks.md) wie `preHandler` für `async`-Aufgaben nach der Validierung.
>
> Bei Verwendung eigener Validatoren mit asynchronen `preValidation`-Hooks
> **müssen** Validatoren `{error}`-Objekte zurückgeben, statt Fehler zu werfen.
> Fehler aus eigenen Validatoren zu werfen führt zu unbehandelten Promise-Rejections,
> die die Anwendung in Kombination mit asynchronen Hooks zum Absturz bringen. Das korrekte
> Muster zeigen die [Beispiele für eigene Validatoren](#using-other-validation-libraries) weiter unten.

### Kernkonzepte
Validierung und Serialisierung werden von zwei anpassbaren Abhängigkeiten übernommen:
- [Ajv v8](https://www.npmjs.com/package/ajv) für die Request-Validierung
- [fast-json-stringify](https://www.npmjs.com/package/fast-json-stringify) für die
  Serialisierung des Response-Bodys

Diese Abhängigkeiten teilen sich ausschließlich die JSON-Schemas, die der Fastify-Instanz über `.addSchema(schema)` hinzugefügt wurden.

#### Ein geteiltes Schema hinzufügen
<a id="shared-schema"></a>

Die API `addSchema` erlaubt es, der Fastify-Instanz mehrere Schemas hinzuzufügen, um sie in der gesamten Anwendung wiederzuverwenden. Diese API ist gekapselt.

Geteilte Schemas können mit dem JSON-Schema-Keyword [**`$ref`**](https://datatracker.ietf.org/doc/html/draft-handrews-json-schema-01#section-8) wiederverwendet werden. Hier eine Übersicht, wie Referenzen funktionieren:

+ `myField: { $ref: '#foo' }` sucht nach `$id: '#foo'` im aktuellen Schema
+ `myField: { $ref: '#/definitions/foo' }` sucht nach `definitions.foo` im
  aktuellen Schema
+ `myField: { $ref: 'http://url.com/sh.json#' }` sucht nach einem geteilten Schema
  mit `$id: 'http://url.com/sh.json'`
+ `myField: { $ref: 'http://url.com/sh.json#/definitions/foo' }` sucht nach einem
  geteilten Schema mit `$id: 'http://url.com/sh.json'` und verwendet `definitions.foo`
+ `myField: { $ref: 'http://url.com/sh.json#foo' }` sucht nach einem geteilten Schema
  mit `$id: 'http://url.com/sh.json'` und sucht darin nach `$id: '#foo'`

**Einfache Verwendung:**

```js
fastify.addSchema({
  $id: 'http://fastify.example/',
  type: 'object',
  properties: {
    hello: { type: 'string' }
  }
})

fastify.post('/', {
  handler () {},
  schema: {
    body: {
      type: 'array',
      items: { $ref: 'http://fastify.example#/properties/hello' }
    }
  }
})
```

**`$ref` als Root-Referenz:**

```js
fastify.addSchema({
  $id: 'commonSchema',
  type: 'object',
  properties: {
    hello: { type: 'string' }
  }
})

fastify.post('/', {
  handler () {},
  schema: {
    body: { $ref: 'commonSchema#' },
    headers: { $ref: 'commonSchema#' }
  }
})
```

#### Die geteilten Schemas abrufen
<a id="get-shared-schema"></a>

Wenn Validator und Serializer angepasst sind, ist `.addSchema` nicht nützlich, da Fastify sie nicht mehr steuert. Um auf Schemas zuzugreifen, die der Fastify-Instanz hinzugefügt wurden, verwende `.getSchemas()`:

```js
fastify.addSchema({
  $id: 'schemaId',
  type: 'object',
  properties: {
    hello: { type: 'string' }
  }
})

const mySchemas = fastify.getSchemas()
const mySchema = fastify.getSchema('schemaId')
```

Die Funktion `getSchemas` ist gekapselt und gibt die geteilten Schemas zurück, die im gewählten Scope verfügbar sind:

```js
fastify.addSchema({ $id: 'one', my: 'hello' })
// will return only `one` schema
fastify.get('/', (request, reply) => { reply.send(fastify.getSchemas()) })

fastify.register((instance, opts, done) => {
  instance.addSchema({ $id: 'two', my: 'ciao' })
  // will return `one` and `two` schemas
  instance.get('/sub', (request, reply) => { reply.send(instance.getSchemas()) })

  instance.register((subinstance, opts, done) => {
    subinstance.addSchema({ $id: 'three', my: 'hola' })
    // will return `one`, `two` and `three`
    subinstance.get('/deep', (request, reply) => { reply.send(subinstance.getSchemas()) })
    done()
  })
  done()
})
```


### Validierung
Die Route-Validierung stützt sich auf [Ajv v8](https://www.npmjs.com/package/ajv), einen hochperformanten JSON-Schema-Validator. Um Eingaben zu validieren, füge dem Route-Schema die erforderlichen Felder hinzu.

Unterstützte Validierungen sind:
- `body`: validiert den Request-Body für die Methoden POST, PUT oder PATCH.
- `querystring` oder `query`: validiert den Querystring.
- `params`: validiert die Route-Parameter.
- `headers`: validiert die Request-Header.

Validierungen können ein vollständiges JSON-Schema-Objekt mit dem `type` `'object'` und einem `'properties'`-Objekt mit den Parametern sein oder eine einfachere Variante, die die Parameter auf oberster Ebene auflistet.

> ℹ Zur Verwendung des aktuellen Ajv (v8) siehe den Abschnitt
> [`schemaController`](./Server.md#schema-controller).

Beispiel:
```js
const bodyJsonSchema = {
  type: 'object',
  required: ['requiredKey'],
  properties: {
    someKey: { type: 'string' },
    someOtherKey: { type: 'number' },
    requiredKey: {
      type: 'array',
      maxItems: 3,
      items: { type: 'integer' }
    },
    nullableKey: { type: ['number', 'null'] }, // or { type: 'number', nullable: true }
    multipleTypesKey: { type: ['boolean', 'number'] },
    multipleRestrictedTypesKey: {
      oneOf: [
        { type: 'string', maxLength: 5 },
        { type: 'number', minimum: 10 }
      ]
    },
    enumKey: {
      type: 'string',
      enum: ['John', 'Foo']
    },
    notTypeKey: {
      not: { type: 'array' }
    }
  }
}

const queryStringJsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    excitement: { type: 'integer' }
  }
}

const paramsJsonSchema = {
  type: 'object',
  properties: {
    par1: { type: 'string' },
    par2: { type: 'number' }
  }
}

const headersJsonSchema = {
  type: 'object',
  properties: {
    'x-foo': { type: 'string' }
  },
  required: ['x-foo']
}

const schema = {
  body: bodyJsonSchema,
  querystring: queryStringJsonSchema,
  params: paramsJsonSchema,
  headers: headersJsonSchema
}

fastify.post('/the/url', { schema }, handler)
```

#### Body-Validierung nach Content-Type
<a id="body-content-type-validation"></a>

Für das `body`-Schema ist es zusätzlich möglich, das Schema pro Content-Type zu unterscheiden, indem die Schemas innerhalb der Eigenschaft `content` verschachtelt werden. Die Schema-Validierung wird anhand des `Content-Type`-Headers im Request angewendet.

```js
fastify.post('/the/url', {
  schema: {
    body: {
      content: {
        'application/json': {
          schema: { type: 'object' }
        },
        'text/plain': {
          schema: { type: 'string' }
        }
        // Other content types will not be validated
      }
    }
  }
}, handler)
```

> ⚠ Warnung:
> Bei Verwendung [eigener Content-Type-Parser](./ContentTypeParser.md) wird der geparste
> Body **nur** validiert, wenn der Content-Type des Requests zu einem Schlüssel in der
> `content`-Map des Schemas passt.
>
> Die Schema-Auswahl erfolgt über eine exakte Übereinstimmung mit dem
> [Essence-MIME-Type](https://mimesniff.spec.whatwg.org/#mime-type-miscellaneous) des Requests
> (zum Beispiel `application/json`). Wenn ein Parser mit einem regulären
> Ausdruck registriert ist (zum Beispiel `/^application\/.*json$/`), kann der Parser
> mehr Content-Types akzeptieren, als die `content`-Map abdeckt. Requests in dieser Lücke werden
> geparst, aber **nicht validiert**.
>
> Stelle sicher, dass jeder vom Parser akzeptierte Content-Type einen entsprechenden Schlüssel in
> der `content`-Map hat, oder verwende ein allgemeines Body-Schema ohne `content`, wenn
> eine strikte Unterscheidung pro Content-Type nicht erforderlich ist.
>
> ```js
> // Add a custom parser for YAML
> fastify.addContentTypeParser('application/yaml', { parseAs: 'string' }, (req, body, done) => {
>   done(null, YAML.parse(body))
> })
>
> fastify.post('/the/url', {
>   schema: {
>     body: {
>       content: {
>         'application/json': {
>           schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
>         },
>         // Without this entry, application/yaml requests will NOT be validated
>         'application/yaml': {
>           schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
>         }
>       }
>     }
>   }
> }, handler)
> ```

Beachte, dass Ajv versucht, Werte in die im Schema-Keyword `type` angegebenen Typen zu [überführen](https://ajv.js.org/coercion.html), sowohl um die Validierung zu bestehen als auch um die korrekt typisierten Daten anschließend zu verwenden.

> ⚠ Wichtig:
> Fastify verwendet eine eigene [AJV-Konfiguration][1], etwa `coerceTypes: 'array'`.
> Bewerte deren Verhalten und prüfe, ob es den Anforderungen des Projekts entspricht.

[1]: https://github.com/fastify/ajv-compiler?tab=readme-ov-file#ajv-configuration

Die Ajv-Standardkonfiguration in Fastify unterstützt die Typüberführung von Array-Parametern im `querystring`. Beispiel:

```js
const opts = {
  schema: {
    querystring: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          default: []
        },
      },
    }
  }
}

fastify.get('/', opts, (request, reply) => {
  reply.send({ params: request.query }) // echo the querystring
})

fastify.listen({ port: 3000 }, (err) => {
  if (err) throw err
})
```

```sh
curl -X GET "http://localhost:3000/?ids=1

{"params":{"ids":["1"]}}
```

Für jeden Parametertyp (body, querystring, params, headers) kann ein eigener Schema-Validator angegeben werden.

Der folgende Code deaktiviert zum Beispiel die Typüberführung nur für die `body`-Parameter und ändert damit die Ajv-Standardoptionen:

```js
const schemaCompilers = {
  body: new Ajv({
    removeAdditional: false,
    coerceTypes: false,
    allErrors: true
  }),
  params: new Ajv({
    removeAdditional: false,
    coerceTypes: true,
    allErrors: true
  }),
  querystring: new Ajv({
    removeAdditional: false,
    coerceTypes: true,
    allErrors: true
  }),
  headers: new Ajv({
    removeAdditional: false,
    coerceTypes: true,
    allErrors: true
  })
}

server.setValidatorCompiler(req => {
    if (!req.httpPart) {
      throw new Error('Missing httpPart')
    }
    const compiler = schemaCompilers[req.httpPart]
    if (!compiler) {
      throw new Error(`Missing compiler for ${req.httpPart}`)
    }
    return compiler.compile(req.schema)
})
```

Wenn die Typüberführung aktiviert ist, kann die Verwendung von `anyOf` mit nullable primitiven Typen zu unerwarteten Ergebnissen führen. Zum Beispiel kann ein Wert von `0` oder `false` zu `null` überführt werden, weil Ajv `anyOf`-Schemas der Reihe nach auswertet und während des Abgleichs Typüberführung anwendet. Das bedeutet, dass der Zweig `{ "type": "null" }` vor dem beabsichtigten Typ zutreffen kann:

```json
{
  "anyOf": [
    { "type": "null" },
    { "type": "number" }
  ]
}
```

Um das zu vermeiden, verwende bei primitiven Typen das Keyword `nullable` statt `anyOf`:

```json
{
  "type": "number",
  "nullable": true
}
```

Weitere Informationen siehe [Ajv Coercion](https://ajv.js.org/coercion.html).

#### Ajv-Plugins
<a id="ajv-plugins"></a>

Für die Verwendung mit der standardmäßigen `ajv`-Instanz kann eine Liste von Plugins bereitgestellt werden. Stelle sicher, dass das Plugin **mit der in Fastify enthaltenen Ajv-Version kompatibel** ist.

> Das Format der Plugins findest du unter [`ajv options`](./Server.md#ajv).

```js
const fastify = require('fastify')({
  ajv: {
    plugins: [
      require('ajv-merge-patch')
    ]
  }
})

fastify.post('/', {
  handler (req, reply) { reply.send({ ok: 1 }) },
  schema: {
    body: {
      $patch: {
        source: {
          type: 'object',
          properties: {
            q: {
              type: 'string'
            }
          }
        },
        with: [
          {
            op: 'add',
            path: '/properties/q',
            value: { type: 'number' }
          }
        ]
      }
    }
  }
})

fastify.post('/foo', {
  handler (req, reply) { reply.send({ ok: 1 }) },
  schema: {
    body: {
      $merge: {
        source: {
          type: 'object',
          properties: {
            q: {
              type: 'string'
            }
          }
        },
        with: {
          required: ['q']
        }
      }
    }
  }
})
```

#### Validator-Compiler
<a id="schema-validator"></a>

Der `validatorCompiler` ist eine Funktion, die eine Funktion zurückgibt, um Body, URL-Parameter, Header und Querystring zu validieren. Der standardmäßige `validatorCompiler` gibt eine Funktion zurück, die das Validierungs-Interface von [ajv](https://ajv.js.org/) implementiert. Fastify verwendet ihn intern, um die Validierung zu beschleunigen.

Fastifys [Basiskonfiguration für ajv](https://github.com/fastify/ajv-compiler#ajv-configuration) lautet:

```js
{
  coerceTypes: 'array', // change data type of data to match type keyword
  useDefaults: true, // replace missing properties and items with the values from corresponding default keyword
  removeAdditional: true, // remove additional properties if additionalProperties is set to false, see: https://ajv.js.org/guide/modifying-data.html#removing-additional-properties
  uriResolver: require('fast-uri'),
  addUsedSchema: false,
  // Explicitly set allErrors to `false`.
  // When set to `true`, a DoS attack is possible.
  allErrors: false
}
```

Ändere die Basiskonfiguration, indem du der Fastify-Factory [`ajv.customOptions`](./Server.md#factory-ajv) übergibst.

Um weitere Konfigurationsoptionen zu ändern oder zu setzen, erstelle eine eigene Instanz und überschreibe die bestehende:

```js
const fastify = require('fastify')()
const Ajv = require('ajv')
const ajv = new Ajv({
  removeAdditional: 'all',
  useDefaults: true,
  coerceTypes: 'array',
  // any other options
  // ...
})
fastify.setValidatorCompiler(({ schema, method, url, httpPart }) => {
  return ajv.compile(schema)
})
```

> ℹ️ Hinweis:
> Wenn du eine eigene Validator-Instanz verwendest, füge Schemas dem Validator hinzu
> statt Fastify. Fastifys Methode `addSchema` erkennt den eigenen
> Validator nicht.

##### Andere Validierungsbibliotheken verwenden
<a id="using-other-validation-libraries"></a>

Die Funktion `setValidatorCompiler` erlaubt es, `ajv` durch andere JavaScript-Validierungsbibliotheken wie [joi](https://github.com/hapijs/joi/) oder [yup](https://github.com/jquense/yup/) oder eine eigene zu ersetzen:

```js
const Joi = require('joi')

fastify.setValidatorCompiler(({ schema }) => {
  return (data) => {
    try {
      const { error, value } = schema.validate(data)
      if (error) {
        return { error } // Return the error, do not throw it
      }
      return { value }
    } catch (e) {
      return { error: e } // Catch any unexpected errors too
    }
  }
})

fastify.post('/the/url', {
  schema: {
    body: Joi.object().keys({
      hello: Joi.string().required()
    }).required()
  }
}, handler)
```

```js
const yup = require('yup')
// Validation options to match ajv's baseline options used in Fastify
const yupOptions = {
  strict: false,
  abortEarly: false, // return all errors
  stripUnknown: true, // remove additional properties
  recursive: true
}

fastify.post('/the/url', {
  schema: {
    body: yup.object({
      age: yup.number().integer().required(),
      sub: yup.object().shape({
        name: yup.string().required()
      }).required()
    })
  },
  validatorCompiler: ({ schema, method, url, httpPart }) => {
    return function (data) {
      // with option strict = false, yup `validateSync` function returns the
      // coerced value if validation was successful, or throws if validation failed
      try {
        const result = schema.validateSync(data, yupOptions)
        return { value: result }
      } catch (e) {
        return { error: e }
      }
    }
  }
}, handler)
```

Fastify unterstützt über `setValidatorCompiler` verschiedene JSON-Schema-Validatoren. Community-Plugins, die alternative JSON-Schema-Validatoren integrieren, sind auf der Seite [Ecosystem](https://fastify.dev/docs/latest/Guides/Ecosystem/) aufgeführt.

##### Best Practices für eigene Validatoren

Wenn du eigene Validatoren implementierst, halte dich an diese Muster, um Kompatibilität mit allen Fastify-Funktionen sicherzustellen:

**Gib immer Objekte zurück, wirf niemals:**
```js
return { value: validatedData }  // On success
return { error: validationError } // On failure
```

**Verwende try-catch zur Absicherung:**
```js
fastify.setValidatorCompiler(({ schema }) => {
  return (data) => {
    try {
      // Validation logic here
      const result = schema.validate(data)
      if (result.error) {
        return { error: result.error }
      }
      return { value: result.value }
    } catch (e) {
      // Catch any unexpected errors
      return { error: e }
    }
  }
})
```

Dieses Muster stellt sicher, dass Validatoren sowohl mit synchronen als auch mit asynchronen `preValidation`-Hooks korrekt funktionieren, und verhindert unbehandelte Promise-Rejections, die eine Anwendung zum Absturz bringen können.

##### Eigenschaft .statusCode

Alle Validierungsfehler haben eine Eigenschaft `.statusCode` mit dem Wert `400`, sodass der Standard-Error-Handler den Response-Statuscode auf `400` setzt.

```js
fastify.setErrorHandler(function (error, request, reply) {
  request.log.error(error, `This error has status code ${error.statusCode}`)
  reply.status(error.statusCode).send(error)
})
```

##### Validierungsmeldungen mit anderen Validierungsbibliotheken

Fastifys Validierungsfehlermeldungen sind eng an die standardmäßige Validierungs-Engine gekoppelt: Von `ajv` zurückgegebene Fehler durchlaufen letztlich die Funktion `schemaErrorFormatter`, die verständliche Fehlermeldungen erzeugt. Die Funktion `schemaErrorFormatter` ist jedoch mit Blick auf `ajv` geschrieben. Das kann bei Verwendung anderer Validierungsbibliotheken zu merkwürdigen oder unvollständigen Fehlermeldungen führen.

Um dieses Problem zu umgehen, gibt es im Wesentlichen zwei Möglichkeiten:

1. Stelle sicher, dass die Validierungsfunktion (vom eigenen `schemaCompiler` zurückgegeben)
   Fehler in derselben Struktur und demselben Format wie `ajv` zurückgibt.
2. Verwende einen eigenen `errorHandler`, um eigene Validierungsfehler abzufangen und zu formatieren.

Fastify fügt allen Validierungsfehlern zwei Eigenschaften hinzu, die beim Schreiben eines eigenen `errorHandler` helfen:

* `validation`: der Inhalt der Eigenschaft `error` des Objekts, das von der
  Validierungsfunktion (vom eigenen `schemaCompiler` zurückgegeben) geliefert wird
* `validationContext`: der Kontext (body, params, query, headers), in dem der
  Validierungsfehler aufgetreten ist

Ein konstruiertes Beispiel für einen solchen eigenen `errorHandler`, der Validierungsfehler behandelt, ist unten gezeigt:

```js
const errorHandler = (error, request, reply) => {
  const statusCode = error.statusCode
  let response

  const { validation, validationContext } = error

  // check if we have a validation error
  if (validation) {
    response = {
      // validationContext will be 'body', 'params', 'headers', or 'query'
      message: `A validation error occurred when validating the ${validationContext}...`,
      // this is the result of the validation library...
      errors: validation
    }
  } else {
    response = {
      message: 'An error occurred...'
    }
  }

  // any additional work here, eg. log error
  // ...

  reply.status(statusCode).send(response)
}
```

### Serialisierung
<a id="serialization"></a>

Fastify verwendet [fast-json-stringify](https://www.npmjs.com/package/fast-json-stringify), um Daten als JSON zu senden, wenn in den Route-Optionen ein Ausgabeschema angegeben ist. Ein Ausgabeschema kann den Durchsatz drastisch erhöhen und hilft, die versehentliche Offenlegung sensibler Informationen zu verhindern.

Beispiel:
```js
const schema = {
  response: {
    200: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        otherValue: { type: 'boolean' }
      }
    }
  }
}

fastify.post('/the/url', { schema }, handler)
```

Das Response-Schema richtet sich nach dem Statuscode. Um dasselbe Schema für mehrere Statuscodes zu verwenden, nutze `'2xx'` oder `default`, zum Beispiel:
```js
const schema = {
  response: {
    default: {
      type: 'object',
      properties: {
        error: {
          type: 'boolean',
          default: true
        }
      }
    },
    '2xx': {
      type: 'object',
      properties: {
        value: { type: 'string' },
        otherValue: { type: 'boolean' }
      }
    },
    201: {
      // the contract syntax
      value: { type: 'string' }
    }
  }
}

fastify.post('/the/url', { schema }, handler)
```
Für unterschiedliche Content-Types kann ein spezifisches Response-Schema definiert werden. Zum Beispiel:
```js
const schema = {
  response: {
    200: {
      description: 'Response schema that support different content types'
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              image: { type: 'string' },
              address: { type: 'string' }
            }
          }
        },
        'application/vnd.v1+json': {
          schema: {
            type: 'array',
            items: { $ref: 'test' }
          }
        }
      }
    },
    '3xx': {
      content: {
        'application/vnd.v2+json': {
          schema: {
            type: 'object',
            properties: {
              fullName: { type: 'string' },
              phone: { type: 'string' }
            }
          }
        }
      }
    },
    default: {
      content: {
        // */* is match-all content-type
        '*/*': {
          schema: {
            type: 'object',
            properties: {
              desc: { type: 'string' }
            }
          }
        }
      }
    }
  }
}

fastify.post('/url', { schema }, handler)
```

#### Serializer-Compiler
<a id="schema-serializer"></a>

Der `serializerCompiler` gibt eine Funktion zurück, die aus einem Eingabeobjekt einen String liefern muss. Wenn du ein Response-JSON-Schema definierst, ändere die standardmäßige Serialisierungsmethode, indem du eine Funktion zum Serialisieren jeder Route bereitstellst.

```js
fastify.setSerializerCompiler(({ schema, method, url, httpStatus, contentType }) => {
  return data => JSON.stringify(data)
})

fastify.get('/user', {
  handler (req, reply) {
    reply.send({ id: 1, name: 'Foo', image: 'BIG IMAGE' })
  },
  schema: {
    response: {
      '2xx': {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' }
        }
      }
    }
  }
})
```

*Um in einem bestimmten Teil des Codes einen eigenen Serializer zu setzen, verwende [`reply.serializer(...)`](./Reply.md#serializerfunc).*

### Fehlerbehandlung
Wenn die Schema-Validierung für einen Request fehlschlägt, gibt Fastify automatisch eine Response mit Status 400 zurück, die das Ergebnis des Validators im Payload enthält. Wenn zum Beispiel das folgende Schema für eine Route verwendet wird:

```js
const schema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string' }
    },
    required: ['name']
  }
}
```

Wenn der Request das Schema nicht erfüllt, gibt die Route eine Response mit folgendem Payload zurück:

```js
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body should have required property 'name'"
}
```

> ⚠ Sicherheitshinweis: Standardmäßig sind Details zu Validierungsfehlern aus dem Schema
> im Response-Payload enthalten. Wenn deine Organisation verlangt, diese Fehlermeldungen zu
> bereinigen oder anzupassen (z. B. um interne Schema-Details nicht offenzulegen),
> konfiguriere über
> [`setErrorHandler()`](./Server.md#seterrorhandler) einen eigenen Error-Handler.

Um Fehler innerhalb der Route zu behandeln, gib die Option `attachValidation` an. Tritt ein Validierungsfehler auf, enthält die Eigenschaft `validationError` des Requests dasselbe `Error`-Objekt, das Fastify von sich aus gesendet hätte, sodass keine Meldung aus dem rohen Validierungsergebnis neu aufgebaut werden muss:

- `message` ist die formatierte Meldung, identisch mit der im obigen Response-Payload
  (zum Beispiel `body must have required property 'name'`). Sie wird von
  [`schemaErrorFormatter`](#schemaerrorformatter) erzeugt, sodass sich auch ein eigener
  Formatter hier niederschlägt.
- `validation` ist das rohe Validierungsergebnis, wie vom Validator zurückgegeben.
- `validationContext` ist der Teil des Requests, dessen Validierung fehlgeschlagen ist
  (`body`, `params`, `querystring` oder `headers`).
- `code` ist `FST_ERR_VALIDATION` und `statusCode` ist `400`.

```js
const fastify = Fastify()

fastify.post('/', { schema, attachValidation: true }, function (req, reply) {
  if (req.validationError) {
    // `req.validationError.message` is the formatted message
    // `req.validationError.validation` contains the raw validation result
    reply.code(400).send(req.validationError)
  }
})
```

#### `schemaErrorFormatter`

Um Fehler zu formatieren, gib beim Instanziieren von Fastify eine synchrone Funktion, die einen Fehler zurückgibt, als Option `schemaErrorFormatter` an. Der Kontext der Funktion ist die Fastify-Server-Instanz.

`errors` ist ein Array von Fastify-Schema-Fehlern `FastifySchemaValidationError`. `dataVar` ist der aktuell validierte Teil des Schemas (params, body, querystring, headers).

```js
const fastify = Fastify({
  schemaErrorFormatter: (errors, dataVar) => {
    // ... my formatting logic
    return new Error(myErrorMessage)
  }
})

// or
fastify.setSchemaErrorFormatter(function (errors, dataVar) {
  this.log.error({ err: errors }, 'Validation failed')
  // ... my formatting logic
  return new Error(myErrorMessage)
})
```

Verwende [setErrorHandler](./Server.md#seterrorhandler), um eine eigene Response für Validierungsfehler zu definieren, etwa:

```js
fastify.setErrorHandler(function (error, request, reply) {
  if (error.validation) {
     reply.status(422).send(new Error('validation failed'))
  }
})
```

Für eigene Fehler-Responses im Schema siehe [`ajv-errors`](https://github.com/ajv-validator/ajv-errors). Sieh dir die [Beispielverwendung](https://github.com/fastify/example/blob/HEAD/validation-messages/custom-errors-messages.js) an.

> Fastify v5 verwendet AJV v8 und benötigt eine kompatible `ajv-errors`-Version.
> Fastify v3 benötigt `ajv-errors@1.0.1`, das AJV v6 unterstützt.
> Die von jedem Fastify-Release verwendete AJV-Version findest du in der [Versionstabelle des AJV-Compilers](https://github.com/fastify/ajv-compiler/#versions).

Unten ein Beispiel dafür, wie man durch Angabe eigener AJV-Optionen **eigene Fehlermeldungen für jede Eigenschaft** eines Schemas hinzufügt. Inline-Kommentare im Schema beschreiben, wie es zu konfigurieren ist, um für jeden Fall eine andere Fehlermeldung anzuzeigen:

```js
const fastify = Fastify({
  ajv: {
    customOptions: {
      jsonPointers: true,
      // ⚠ Warning: Enabling this option may lead to this security issue https://www.cvedetails.com/cve/CVE-2020-8192/
      allErrors: true
    },
    plugins: [
      require('ajv-errors')
    ]
  }
})

const schema = {
  body: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        errorMessage: {
          type: 'Bad name'
        }
      },
      age: {
        type: 'number',
        errorMessage: {
          type: 'Bad age', // specify custom message for
          min: 'Too young' // all constraints except required
        }
      }
    },
    required: ['name', 'age'],
    errorMessage: {
      required: {
        name: 'Why no name!', // specify error message for when the
        age: 'Why no age!' // property is missing from input
      }
    }
  }
}

fastify.post('/', { schema, }, (request, reply) => {
  reply.send({
    hello: 'world'
  })
})
```

Um lokalisierte Fehlermeldungen zurückzugeben, siehe [ajv-i18n](https://github.com/ajv-validator/ajv-i18n).

```js
const localize = require('ajv-i18n')

const fastify = Fastify()

const schema = {
  body: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
      },
      age: {
        type: 'number',
      }
    },
    required: ['name', 'age'],
  }
}

fastify.setErrorHandler(function (error, request, reply) {
  if (error.validation) {
    localize.ru(error.validation)
    reply.status(400).send(error.validation)
    return
  }
  reply.send(error)
})
```

### JSON-Schema-Unterstützung

JSON Schema bietet Hilfsmittel, um Schemas zu optimieren. In Kombination mit Fastifys geteilten Schemas lassen sich alle Schemas leicht wiederverwenden.

| Anwendungsfall                    | Validator | Serializer |
|-----------------------------------|-----------|------------|
| `$ref` auf `$id`                   | ️️✔️ | ✔️ |
| `$ref` auf `/definitions`          | ✔️ | ✔️ |
| `$ref` auf `$id` eines geteilten Schemas          | ✔️ | ✔️ |
| `$ref` auf `/definitions` eines geteilten Schemas | ✔️ | ✔️ |

#### Beispiele

##### Verwendung von `$ref` auf `$id` im selben JSON-Schema

```js
const refToId = {
  type: 'object',
  definitions: {
    foo: {
      $id: '#address',
      type: 'object',
      properties: {
        city: { type: 'string' }
      }
    }
  },
  properties: {
    home: { $ref: '#address' },
    work: { $ref: '#address' }
  }
}
```


##### Verwendung von `$ref` auf `/definitions` im selben JSON-Schema
```js
const refToDefinitions = {
  type: 'object',
  definitions: {
    foo: {
      $id: '#address',
      type: 'object',
      properties: {
        city: { type: 'string' }
      }
    }
  },
  properties: {
    home: { $ref: '#/definitions/foo' },
    work: { $ref: '#/definitions/foo' }
  }
}
```

##### Verwendung von `$ref` auf die `$id` eines geteilten Schemas als externes Schema
```js
fastify.addSchema({
  $id: 'http://foo/common.json',
  type: 'object',
  definitions: {
    foo: {
      $id: '#address',
      type: 'object',
      properties: {
        city: { type: 'string' }
      }
    }
  }
})

const refToSharedSchemaId = {
  type: 'object',
  properties: {
    home: { $ref: 'http://foo/common.json#address' },
    work: { $ref: 'http://foo/common.json#address' }
  }
}
```

##### Verwendung von `$ref` auf die `/definitions` eines geteilten Schemas als externes Schema
```js
fastify.addSchema({
  $id: 'http://foo/shared.json',
  type: 'object',
  definitions: {
    foo: {
      type: 'object',
      properties: {
        city: { type: 'string' }
      }
    }
  }
})

const refToSharedSchemaDefinitions = {
  type: 'object',
  properties: {
    home: { $ref: 'http://foo/shared.json#/definitions/foo' },
    work: { $ref: 'http://foo/shared.json#/definitions/foo' }
  }
}
```

### Ressourcen
<a id="resources"></a>

- [JSON Schema](https://json-schema.org/)
- [Understanding JSON
  Schema](https://json-schema.org/understanding-json-schema/about)
- [Dokumentation zu
  fast-json-stringify](https://github.com/fastify/fast-json-stringify)
- [Ajv-Dokumentation](https://github.com/ajv-validator/ajv/blob/master/README.md)
- [Ajv i18n](https://github.com/ajv-validator/ajv-i18n)
- [Ajv custom errors](https://github.com/ajv-validator/ajv-errors)
- Eigene Fehlerbehandlung mit Kernmethoden und Ausgabe der Fehler in eine Datei –
  [Beispiel](https://github.com/fastify/example/tree/main/validation-messages)
