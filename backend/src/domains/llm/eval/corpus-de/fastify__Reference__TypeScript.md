<h1 align="center">Fastify</h1>

## TypeScript

Das Fastify-Framework ist in reinem JavaScript geschrieben, weshalb Typdefinitionen nicht ganz leicht zu pflegen sind; seit Version 2 und darüber hinaus haben Maintainer und Mitwirkende jedoch großen Aufwand betrieben, um die Typen zu verbessern.

Das Typsystem wurde in Fastify Version 3 geändert. Das neue Typsystem führt generische Constraints und Defaults ein sowie eine neue Möglichkeit, Schematypen wie Request-Body, Querystring und mehr zu definieren! Während das Team an einem besseren Zusammenspiel von Framework und Typdefinitionen arbeitet, sind manche Teile der API mitunter nicht oder falsch typisiert. Wir ermutigen dich, **beizutragen** und uns zu helfen, die Lücken zu schließen. Lies vor dem Start aber unbedingt unsere Datei [`CONTRIBUTING.md`](https://github.com/fastify/fastify/blob/main/CONTRIBUTING.md), damit alles reibungslos läuft!

> Die Dokumentation in diesem Abschnitt behandelt die Fastify-Typings

> Plugins können Typings enthalten oder auch nicht. Weitere Informationen siehe [Plugins](#plugins). Wir ermutigen Nutzer, Pull Requests zur Verbesserung der Typings-Unterstützung einzureichen.

🚨 Vergiss nicht, `@types/node` zu installieren

## Anhand von Beispielen lernen

Der beste Weg, das Typsystem von Fastify zu lernen, führt über Beispiele! Die folgenden vier Beispiele sollten die häufigsten Fälle der Fastify-Entwicklung abdecken. Nach den Beispielen folgt eine weitergehende, detailliertere Dokumentation des Typsystems.

### Erste Schritte

Dieses Beispiel bringt dich mit Fastify und TypeScript zum Laufen. Ergebnis ist ein leerer HTTP-Fastify-Server.

1. Erstelle ein neues npm-Projekt, installiere Fastify und installiere typescript & die Node.js-Typen als Peer-Dependencies:
  ```bash
  npm init -y
  npm i fastify
  npm i -D typescript @types/node
  ```
2. Füge die folgenden Zeilen im Abschnitt `"scripts"` der `package.json` hinzu:
  ```json
  {
    "scripts": {
      "build": "tsc -p tsconfig.json",
      "start": "node index.js"
    }
  }
  ```

3. Initialisiere eine TypeScript-Konfigurationsdatei:
  ```bash
  npx tsc --init
  ```
  oder verwende eine der [empfohlenen](https://github.com/tsconfig/bases#node-14-tsconfigjson).

> ℹ️ Hinweis:
> Setze die Eigenschaft `target` in der `tsconfig.json` auf `es2017` oder höher, um die Warnung
> [FastifyDeprecation](https://github.com/fastify/fastify/issues/3284) zu vermeiden.

4. Erstelle eine Datei `index.ts` – sie enthält den Server-Code
5. Füge deiner Datei den folgenden Codeblock hinzu:
   ```typescript
   import fastify from 'fastify'

   const server = fastify()

   server.get('/ping', async (request, reply) => {
     return 'pong\n'
   })

   server.listen({ port: 8080 }, (err, address) => {
     if (err) {
       console.error(err)
       process.exit(1)
     }
     console.log(`Server listening at ${address}`)
   })
   ```
6. Führe `npm run build` aus – damit wird `index.ts` zu `index.js` kompiliert, das mit Node.js ausgeführt werden kann. Falls dabei Fehler auftreten, öffne bitte ein Issue in [fastify/help](https://github.com/fastify/help/)
7. Führe `npm run start` aus, um den Fastify-Server zu starten
8. In deiner Konsole solltest du `Server listening at http://127.0.0.1:8080` sehen
9. Probiere deinen Server mit `curl localhost:8080/ping` aus, er sollte `pong` zurückgeben 🏓

🎉 Du hast nun einen funktionierenden TypeScript-Fastify-Server! Dieses Beispiel zeigt die Einfachheit des Typsystems. Standardmäßig geht das Typsystem davon aus, dass du einen `http`-Server verwendest. Die späteren Beispiele zeigen, wie du komplexere Server wie `https` und `http2` erstellst, wie du Route-Schemas angibst und mehr!

> Weitere Beispiele zur Initialisierung von Fastify mit TypeScript (etwa zum Aktivieren von HTTP2) findest du im detaillierten API-Abschnitt [hier][Fastify]

### Generics verwenden

Das Typsystem stützt sich stark auf generische Eigenschaften, um die möglichst genaue Entwicklungserfahrung zu bieten. Manche mögen den Mehraufwand etwas mühsam finden, aber der Kompromiss lohnt sich! Dieses Beispiel taucht in die Umsetzung generischer Typen für Route-Schemas und die dynamischen Eigenschaften des `request`-Objekts auf Route-Ebene ein.

1. Wenn du das vorherige Beispiel nicht abgeschlossen hast, folge den Schritten 1–4, um alles einzurichten.
2. Definiere in `index.ts` drei Interfaces `IQuerystring`, `IHeaders` und `IReply`:
   ```typescript
   interface IQuerystring {
     username: string;
     password: string;
   }

   interface IHeaders {
     'h-Custom': string;
   }

   interface IReply {
     200: { success: boolean };
     302: { url: string };
     '4xx': { error: string };
   }
   ```
3. Definiere mit diesen drei Interfaces eine neue API-Route und übergib sie als Generics. Die Kurzform-Route-Methoden (also `.get`) akzeptieren ein generisches Objekt `RouteGenericInterface` mit fünf benannten Eigenschaften: `Body`, `Querystring`, `Params`, `Headers` und `Reply`. Die Interfaces `Body`, `Querystring`, `Params` und `Headers` werden über die Route-Methode an die `request`-Instanz im Route-Handler weitergereicht und das Interface `Reply` an die `reply`-Instanz.
   ```typescript
   server.get<{
     Querystring: IQuerystring,
     Headers: IHeaders,
     Reply: IReply
   }>('/auth', async (request, reply) => {
     const { username, password } = request.query
     const customerHeader = request.headers['h-Custom']
     // do something with request data

     // chaining .statusCode/.code calls with .send allows type narrowing. For example:
     // this works
     reply.code(200).send({ success: true });
     // but this gives a type error
     reply.code(200).send('uh-oh');
     // it even works for wildcards
     reply.code(404).send({ error: 'Not found' });
     return { success: true }
   })
   ```

4. Baue und starte den Server-Code mit `npm run build` und `npm run start`
5. Frage die API ab
   ```bash
   curl localhost:8080/auth?username=admin&password=Password123!
   ```
   Und sie sollte `logged in!` zurückgeben
6. Aber warte, da ist noch mehr! Die generischen Interfaces stehen auch in Hook-Methoden auf Route-Ebene zur Verfügung. Ergänze die vorherige Route um einen `preValidation`-Hook:
   ```typescript
   server.get<{
     Querystring: IQuerystring,
     Headers: IHeaders,
     Reply: IReply
   }>('/auth', {
     preValidation: (request, reply, done) => {
       const { username, password } = request.query
       done(username !== 'admin' ? new Error('Must be admin') : undefined) // only validate `admin` account
     }
   }, async (request, reply) => {
     const customerHeader = request.headers['h-Custom']
     // do something with request data
     return { success: true }
   })
   ```
7. Baue, starte und frage mit der Querystring-Option `username` auf einem anderen Wert als `admin` ab. Die API sollte nun einen HTTP-500-Fehler zurückgeben: `{"statusCode":500,"error":"Internal Server Error","message":"Must be admin"}`

🎉 Gute Arbeit, nun kannst du für jede Route Interfaces definieren und hast streng typisierte Request- und Reply-Instanzen. Andere Teile des Fastify-Typsystems stützen sich auf generische Eigenschaften. Sieh dir unbedingt die detaillierte Dokumentation des Typsystems weiter unten an, um mehr über das Verfügbare zu erfahren.

### JSON Schema

Um deine Requests und Responses zu validieren, kannst du JSON-Schema-Dateien verwenden. Falls du es noch nicht wusstest: Schemas für deine Fastify-Routes zu definieren kann deren Durchsatz erhöhen! Weitere Informationen findest du in der Dokumentation zu [Validation and Serialization](./Validation-and-Serialization.md).

Außerdem hat es den Vorteil, dass du den definierten Typ innerhalb deiner Handler verwenden kannst (einschließlich Pre-Validation usw.).

Hier einige Möglichkeiten, wie du das erreichst.

#### Fastify Type Provider

Fastify bietet zwei Pakete, die `json-schema-to-ts` und `typebox` umschließen:

- [`@fastify/type-provider-json-schema-to-ts`](https://github.com/fastify/fastify-type-provider-json-schema-to-ts)
- [`@fastify/type-provider-typebox`](https://github.com/fastify/fastify-type-provider-typebox)

Und einen `zod`-Wrapper von dritter Seite namens [`fastify-type-provider-zod`](https://github.com/turkerdev/fastify-type-provider-zod)

Sie vereinfachen die Einrichtung der Schema-Validierung; mehr dazu liest du auf der Seite [Type Providers](./Type-Providers.md).

Nachfolgend wird gezeigt, wie du die Schema-Validierung mit den Paketen `typebox`, `json-schema-to-typescript` und `json-schema-to-ts` ohne Type Provider einrichtest.

#### TypeBox

Eine nützliche Bibliothek, um Typen und ein Schema in einem Zug zu erstellen, ist [TypeBox](https://www.npmjs.com/package/typebox). Mit TypeBox definierst du dein Schema in deinem Code und verwendest es direkt als Typ oder Schema, je nach Bedarf.

Wenn du es zur Validierung eines Payloads in einer Fastify-Route verwenden möchtest, kannst du das so tun:

1. Installiere `typebox` in deinem Projekt.

    ```bash
    npm i typebox
    ```

2. Definiere das benötigte Schema mit `Type` und erstelle den zugehörigen Typ mit `Static`.

    ```typescript
    import { Static, Type } from 'typebox'

    export const User = Type.Object({
      name: Type.String(),
      mail: Type.Optional(Type.String({ format: 'email' })),
    })

    export type UserType = Static<typeof User>
    ```

3. Verwende den definierten Typ und das Schema bei der Definition deiner Route

    ```typescript
    import Fastify from 'fastify'
    // ...

    const fastify = Fastify()

    fastify.post<{ Body: UserType, Reply: UserType }>(
      '/',
      {
        schema: {
          body: User,
          response: {
            200: User
          },
        },
      },
      (request, reply) => {
        // The `name` and `mail` types are automatically inferred
        const { name, mail } = request.body;
        reply.status(200).send({ name, mail });
      }
    )
    ```

#### json-schema-to-typescript

Im letzten Beispiel haben wir Typebox verwendet, um die Typen und Schemas für unsere Route zu definieren. Viele Nutzer verwenden bereits JSON Schemas, um diese Eigenschaften zu definieren, und glücklicherweise gibt es eine Möglichkeit, bestehende JSON Schemas in TypeScript-Interfaces zu überführen!

1. Wenn du das Beispiel „Erste Schritte“ nicht abgeschlossen hast, gehe zurück und folge zuerst den Schritten 1–4.
2. Installiere das Modul `json-schema-to-typescript`:

   ```bash
   npm i -D json-schema-to-typescript
   ```

3. Erstelle einen neuen Ordner namens `schemas` und füge darin zwei Dateien `headers.json` und `querystring.json` hinzu. Kopiere die folgenden Schema-Definitionen in die jeweiligen Dateien:

   ```json
   {
     "title": "Headers Schema",
     "type": "object",
     "properties": {
       "h-Custom": { "type": "string" }
     },
     "additionalProperties": false,
     "required": ["h-Custom"]
   }
   ```

   ```json
   {
     "title": "Querystring Schema",
     "type": "object",
     "properties": {
       "username": { "type": "string" },
       "password": { "type": "string" }
     },
     "additionalProperties": false,
     "required": ["username", "password"]
   }
   ```

4. Füge der package.json ein Skript `compile-schemas` hinzu:

```json
   {
     "scripts": {
       "compile-schemas": "json2ts -i schemas -o types"
     }
   }
```

   `json2ts` ist ein CLI-Werkzeug, das in `json-schema-to-typescript` enthalten ist. `schemas` ist der Eingabepfad und `types` der Ausgabepfad.
5. Führe `npm run compile-schemas` aus. Im Verzeichnis `types` sollten zwei neue Dateien erstellt worden sein.
6. Aktualisiere `index.ts` auf den folgenden Code:

```typescript
   import fastify from 'fastify'

   // import json schemas as normal
   import QuerystringSchema from './schemas/querystring.json'
   import HeadersSchema from './schemas/headers.json'

   // import the generated interfaces
   import { QuerystringSchema as QuerystringSchemaInterface } from './types/querystring'
   import { HeadersSchema as HeadersSchemaInterface } from './types/headers'

   const server = fastify()

   server.get<{
     Querystring: QuerystringSchemaInterface,
     Headers: HeadersSchemaInterface
   }>('/auth', {
     schema: {
       querystring: QuerystringSchema,
       headers: HeadersSchema
     },
     preValidation: (request, reply, done) => {
       const { username, password } = request.query
       done(username !== 'admin' ? new Error('Must be admin') : undefined)
     }
     //  or if using async
     //  preValidation: async (request, reply) => {
     //    const { username, password } = request.query
     //    if (username !== "admin") throw new Error("Must be admin");
     //  }
   }, async (request, reply) => {
     const customerHeader = request.headers['h-Custom']
     // do something with request data
     return `logged in!`
   })

   server.route<{
     Querystring: QuerystringSchemaInterface,
     Headers: HeadersSchemaInterface
   }>({
     method: 'GET',
     url: '/auth2',
     schema: {
       querystring: QuerystringSchema,
       headers: HeadersSchema
     },
     preHandler: (request, reply, done) => {
       const { username, password } = request.query
       const customerHeader = request.headers['h-Custom']
       done()
     },
     handler: (request, reply) => {
       const { username, password } = request.query
       const customerHeader = request.headers['h-Custom']
       reply.status(200).send({username});
     }
   })

   server.listen({ port: 8080 }, (err, address) => {
     if (err) {
       console.error(err)
       process.exit(0)
     }
     console.log(`Server listening at ${address}`)
   })
   ```
   Achte besonders auf die Importe am Anfang dieser Datei. Es mag redundant wirken, aber du musst sowohl die Schema-Dateien als auch die generierten Interfaces importieren.

Großartige Arbeit! Nun kannst du sowohl JSON Schemas als auch TypeScript-Definitionen nutzen.

#### json-schema-to-ts

Wenn du keine Typen aus deinen Schemas generieren, sie aber direkt aus deinem Code verwenden möchtest, kannst du das Paket [json-schema-to-ts](https://www.npmjs.com/package/json-schema-to-ts) nutzen.

Du kannst es als Dev-Dependency installieren.

```bash
npm i -D json-schema-to-ts
```

In deinem Code kannst du dein Schema wie ein normales Objekt definieren. Achte aber darauf, es *const* zu machen, wie in der Dokumentation des Moduls erklärt.

```typescript
const todo = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    done: { type: 'boolean' },
  },
  required: ['name'],
} as const; // don't forget to use const !
```

Mit dem bereitgestellten Typ `FromSchema` kannst du aus deinem Schema einen Typ bauen und ihn in deinem Handler verwenden.

```typescript
import { FromSchema } from "json-schema-to-ts";
fastify.post<{ Body: FromSchema<typeof todo> }>(
  '/todo',
  {
    schema: {
      body: todo,
      response: {
        201: {
          type: 'string',
        },
      },
    }
  },
  async (request, reply): Promise<void> => {

    /*
    request.body has type
    {
      [x: string]: unknown;
      description?: string;
      done?: boolean;
      name: string;
    }
    */

    request.body.name // will not throw type error
    request.body.notthere // will throw type error

    reply.status(201).send();
  },
);
```

### Plugins

Eines der auffälligsten Merkmale von Fastify ist sein umfangreiches Plugin-Ökosystem. Plugin-Typen werden vollständig unterstützt und nutzen das Muster [Declaration Merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html). Dieses Beispiel gliedert sich in drei Teile: ein TypeScript-Fastify-Plugin erstellen, Typdefinitionen für ein Fastify-Plugin erstellen und ein Fastify-Plugin in einem TypeScript-Projekt verwenden.

#### Ein TypeScript-Fastify-Plugin erstellen

1. Initialisiere ein neues npm-Projekt und installiere die erforderlichen Abhängigkeiten
   ```bash
   npm init -y
   npm i fastify fastify-plugin
   npm i -D typescript @types/node
   ```
2. Füge ein `build`-Skript im Abschnitt `"scripts"` und `'index.d.ts'` im Abschnitt `"types"` der Datei `package.json` hinzu:
   ```json
   {
     "types": "index.d.ts",
     "scripts": {
       "build": "tsc -p tsconfig.json"
     }
   }
   ```
3. Initialisiere eine TypeScript-Konfigurationsdatei:
   ```bash
   npx typescript --init
   ```
   Sobald die Datei erzeugt ist, aktiviere die Option `"declaration"` im Objekt `"compilerOptions"`.
   ```json
   {
     "compilerOptions": {
       "declaration": true
     }
   }
   ```
4. Erstelle eine Datei `index.ts` – sie enthält den Plugin-Code
5. Füge `index.ts` den folgenden Code hinzu
   ```typescript
   import { FastifyPluginCallback, FastifyPluginAsync } from 'fastify'
   import fp from 'fastify-plugin'

   // using declaration merging, add your plugin props to the appropriate fastify interfaces
   // if prop type is defined here, the value will be typechecked when you call decorate{,Request,Reply}
   declare module 'fastify' {
     interface FastifyRequest {
       myPluginProp: string
     }
     interface FastifyReply {
       myPluginProp: number
     }
   }

   // define options
   export interface MyPluginOptions {
     myPluginOption: string
   }

   // define plugin using callbacks
   const myPluginCallback: FastifyPluginCallback<MyPluginOptions> = (fastify, options, done) => {
     fastify.decorateRequest('myPluginProp', 'super_secret_value')
     fastify.decorateReply('myPluginProp', options.myPluginOption)

     done()
   }

   // define plugin using promises
   const myPluginAsync: FastifyPluginAsync<MyPluginOptions> = async (fastify, options) => {
     fastify.decorateRequest('myPluginProp', 'super_secret_value')
     fastify.decorateReply('myPluginProp', options.myPluginOption)
   }

   // export plugin using fastify-plugin
   export default fp(myPluginCallback)
   // or
   // export default fp(myPluginAsync)
   ```
6. Führe `npm run build` aus, um den Plugin-Code zu kompilieren und sowohl eine JavaScript-Quelldatei als auch eine Typdefinitionsdatei zu erzeugen.
7. Mit dem nun fertigen Plugin kannst du es [auf npm veröffentlichen] oder lokal verwenden.
   > Du _musst_ dein Plugin nicht auf npm veröffentlichen, um es zu verwenden. Du kannst es in ein
   > Fastify-Projekt aufnehmen und wie jedes andere Stück Code referenzieren! Als
   > TypeScript-Nutzer solltest du sicherstellen, dass die Deklarations-Erweiterung an einer Stelle
   > liegt, die bei der Kompilierung deines Projekts eingeschlossen wird, damit der
   > TypeScript-Interpreter sie verarbeiten kann.

#### Typdefinitionen für ein Fastify-Plugin erstellen

Diese Plugin-Anleitung gilt für Fastify-Plugins, die in JavaScript geschrieben sind. Die in diesem Beispiel beschriebenen Schritte dienen dazu, TypeScript-Unterstützung für Nutzer deines Plugins hinzuzufügen.

1. Initialisiere ein neues npm-Projekt und installiere die erforderlichen Abhängigkeiten
   ```bash
   npm init -y
   npm i fastify-plugin
   ```
2. Erstelle zwei Dateien `index.js` und `index.d.ts`
3. Passe die package.json so an, dass diese Dateien unter den Eigenschaften `main` und `types` stehen (der Name muss nicht zwingend `index` sein, es wird aber empfohlen, dass die Dateien denselben Namen tragen):
   ```json
   {
     "main": "index.js",
     "types": "index.d.ts"
   }
   ```
4. Öffne `index.js` und füge den folgenden Code hinzu:
   ```javascript
   // fastify-plugin is highly recommended for any plugin you write
   const fp = require('fastify-plugin')

   function myPlugin (instance, options, done) {

     // decorate the fastify instance with a custom function called myPluginFunc
     instance.decorate('myPluginFunc', (input) => {
       return input.toUpperCase()
     })

     done()
   }

   module.exports = fp(myPlugin, {
     name: 'my-plugin' // this is used by fastify-plugin to derive the property name
   })
   ```
5. Öffne `index.d.ts` und füge den folgenden Code hinzu:
   ```typescript
   import { FastifyPluginCallback } from 'fastify'

   interface PluginOptions {
     //...
   }

   // Optionally, you can add any additional exports.
   // Here we are exporting the decorator we added.
   export interface myPluginFunc {
     (input: string): string
   }

   // Most importantly, use declaration merging to add the custom property to the Fastify type system
   declare module 'fastify' {
     interface FastifyInstance {
       myPluginFunc: myPluginFunc
     }
   }

   // fastify-plugin automatically adds named export, so be sure to add also this type
   // the variable name is derived from `options.name` property if `module.exports.myPlugin` is missing
   export const myPlugin: FastifyPluginCallback<PluginOptions>

   // fastify-plugin automatically adds `.default` property to the exported plugin. See the note below
   export default myPlugin
   ```

__Hinweis__: [fastify-plugin](https://github.com/fastify/fastify-plugin) v2.3.0 und neuer fügt dem exportierten Plugin automatisch eine `.default`-Eigenschaft und einen benannten Export hinzu. Achte darauf, in deinen Typings sowohl `export default` als auch `export const myPlugin` anzugeben, um die beste Developer Experience zu bieten. Ein vollständiges Beispiel findest du bei [@fastify/swagger](https://github.com/fastify/fastify-swagger/blob/main/index.d.ts).

Mit diesen fertigen Dateien ist das Plugin nun bereit, von jedem TypeScript-Projekt genutzt zu werden!

Das Plugin-System von Fastify erlaubt es Entwicklern, die Fastify-Instanz sowie die Request-/Reply-Instanzen zu dekorieren. Weitere Informationen findest du in diesem Blogbeitrag zu [Declaration Merging and Generic Inheritance](https://dev.to/ethanarrowood/is-declaration-merging-and-generic-inheritance-at-the-same-time-impossible-53cp).

#### Ein Plugin verwenden

Ein Fastify-Plugin in TypeScript zu verwenden ist genauso einfach wie in JavaScript. Importiere das Plugin mit `import/from` und du bist startklar – mit einer Ausnahme, die Nutzer kennen sollten.

Fastify-Plugins verwenden Declaration Merging, um bestehende Fastify-Typ-Interfaces zu verändern (Details siehe die beiden vorherigen Beispiele). Declaration Merging ist nicht besonders _clever_: Wenn die Plugin-Typdefinition eines Plugins im Sichtbereich des TypeScript-Interpreters liegt, werden die Plugin-Typen **unabhängig davon** eingebunden, ob das Plugin verwendet wird oder nicht. Das ist eine unglückliche Einschränkung von TypeScript und derzeit nicht vermeidbar.

Es gibt jedoch einige Vorschläge, um diese Erfahrung zu verbessern:
- Stelle sicher, dass die Regel `no-unused-vars` in [ESLint](https://eslint.org/docs/latest/rules/no-unused-vars) aktiviert ist und alle importierten Plugins tatsächlich geladen werden.
- Verwende ein Modul wie [depcheck](https://www.npmjs.com/package/depcheck) oder [npm-check](https://www.npmjs.com/package/npm-check), um zu prüfen, dass Plugin-Abhängigkeiten irgendwo in deinem Projekt verwendet werden.

Beachte, dass die Verwendung von `require` die Typdefinitionen nicht korrekt lädt und Typfehler verursachen kann. TypeScript kann nur die Typen erkennen, die direkt in den Code importiert werden, das heißt, du kannst require inline verwenden, mit einem import oben. Zum Beispiel:

```typescript
import 'plugin' // here will trigger the type augmentation.

fastify.register(require('plugin'))
```

```typescript
import plugin from 'plugin' //  here will trigger the type augmentation.

fastify.register(plugin)
```

Oder sogar eine explizite Konfiguration in der tsconfig
```jsonc
{
  "types": ["plugin"] // we force TypeScript to import the types
}
```

#### `getDecorator<T>`

Fastifys Methode `getDecorator<T>` ruft Decorators mit erhöhter Typsicherheit ab.

Die Methode `getDecorator<T>` unterstützt generische Typparameter für erhöhte Typsicherheit:

```typescript
// Type-safe decorator retrieval
const usersRepository = fastify.getDecorator<IUsersRepository>('usersRepository')
const session = request.getDecorator<ISession>('session')
const sendSuccess = reply.getDecorator<SendSuccessFn>('sendSuccess')
```

**Alternative zur Modul-Erweiterung**

Decorators werden typischerweise über Modul-Erweiterung (Module Augmentation) typisiert:

```typescript
declare module 'fastify' {
  interface FastifyInstance {
    usersRepository: IUsersRepository
  }
  interface FastifyRequest {
    session: ISession
  }
  interface FastifyReply {
    sendSuccess: SendSuccessFn
  }
}
```

Dieser Ansatz verändert die Fastify-Instanz global, was in Multi-Server-Setups oder bei Plugin-Kapselung zu Konflikten und inkonsistentem Verhalten führen kann.

Die Verwendung von `getDecorator<T>` erlaubt es, den Gültigkeitsbereich der Typen einzugrenzen:

```typescript
serverOne.register(async function (fastify) {
  const usersRepository = fastify.getDecorator<PostgreUsersRepository>(
    'usersRepository'
  )

  fastify.decorateRequest('session', null)
  fastify.addHook('onRequest', async (req, reply) => {
    req.setDecorator('session', { user: 'Jean' })
  })

  fastify.get('/me', (request, reply) => {
    const session = request.getDecorator<ISession>('session')
    reply.send(session)
  })
})

serverTwo.register(async function (fastify) {
  const usersRepository = fastify.getDecorator<SqlLiteUsersRepository>(
    'usersRepository'
  )

  fastify.decorateReply('sendSuccess', function (data) {
    return this.send({ success: true })
  })

  fastify.get('/success', async (request, reply) => {
    const sendSuccess = reply.getDecorator<SendSuccessFn>('sendSuccess')
    await sendSuccess()
  })
})
```

**Inferenz gebundener Funktionen**

Um Zeit zu sparen, ist es üblich, Funktionstypen zu inferieren, statt sie manuell zu schreiben:

```typescript
function sendSuccess (this: FastifyReply) {
  return this.send({ success: true })
}

export type SendSuccess = typeof sendSuccess
```

`getDecorator` gibt Funktionen jedoch mit bereits **gebundenem** `this`-Kontext zurück, das heißt, der `this`-Parameter verschwindet aus der Funktionssignatur.

Um ihn korrekt zu typisieren, verwende das Hilfsmittel `OmitThisParameter`:

```typescript
function sendSuccess (this: FastifyReply) {
  return this.send({ success: true })
}

type BoundSendSuccess = OmitThisParameter<typeof sendSuccess>

fastify.decorateReply('sendSuccess', sendSuccess)
fastify.get('/success', async (request, reply) => {
  const sendSuccess = reply.getDecorator<BoundSendSuccess>('sendSuccess')
  await sendSuccess()
})
```

#### `setDecorator<T>`

Fastifys Methode `setDecorator<T>` bietet erhöhte Typsicherheit beim Aktualisieren von Request-Decorators.

Die Methode `setDecorator<T>` bietet erhöhte Typsicherheit beim Aktualisieren von Request-Decorators:

```typescript
fastify.decorateRequest('user', '')
fastify.addHook('preHandler', async (req, reply) => {
  // Type-safe decorator setting
  req.setDecorator<string>('user', 'Bob Dylan')
})
```

**Vorteile für die Typsicherheit**

Wenn das Interface `FastifyRequest` den Decorator nicht deklariert, sind typischerweise Typzusicherungen nötig:

```typescript
fastify.addHook('preHandler', async (req, reply) => {
  (req as typeof req & { user: string }).user = 'Bob Dylan'
})
```

Die Methode `setDecorator<T>` macht explizite Typzusicherungen überflüssig und bietet gleichzeitig Typsicherheit:

```typescript
fastify.addHook('preHandler', async (req, reply) => {
  req.setDecorator<string>('user', 'Bob Dylan')
})
```

## Code-Vervollständigung in reinem JavaScript

Reines JavaScript kann die veröffentlichten Typen zur Code-Vervollständigung nutzen (z. B. [Intellisense](https://code.visualstudio.com/docs/editing/intellisense)), indem es der [TypeScript-JSDoc-Referenz](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html) folgt.

Zum Beispiel:

```js
/**  @type {import('fastify').FastifyPluginAsync<{ optionA: boolean, optionB: string }>} */
module.exports = async function (fastify, { optionA, optionB }) {
  fastify.get('/look', () => 'at me');
}
```

## Dokumentation des API-Typsystems

Dieser Abschnitt ist eine detaillierte Aufstellung aller Typen, die dir in Fastify zur Verfügung stehen.

Alle `http`-, `https`- und `http2`-Typen werden aus `@types/node` abgeleitet

[Generics](#generics) sind über ihren Standardwert sowie ihre Constraint-Werte dokumentiert. Weitere Informationen zu TypeScript-Generics findest du in diesen Artikeln.
- [Generic Parameter
  Default](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-3.html#generic-parameter-defaults)
- [Generic Constraints](https://www.typescriptlang.org/docs/handbook/2/generics.html#generic-constraints)


#### Wie man importiert

Die Fastify-API wird durch die Methode `fastify()` angetrieben. In JavaScript würdest du sie mit `const fastify = require('fastify')` importieren. In TypeScript wird stattdessen die Syntax `import/from` empfohlen, damit Typen aufgelöst werden können. Es gibt einige unterstützte Importmethoden im Fastify-Typsystem.

1. `import fastify from 'fastify'`
   - Typen werden aufgelöst, sind aber nicht über Punktnotation zugänglich
   - Beispiel:
     ```typescript
     import fastify from 'fastify'

     const f = fastify()
     f.listen({ port: 8080 }, () => { console.log('running') })
     ```
   - Zugriff auf Typen per Destrukturierung:
     ```typescript
     import fastify, { FastifyInstance } from 'fastify'

     const f: FastifyInstance = fastify()
     f.listen({ port: 8080 }, () => { console.log('running') })
     ```
   - Destrukturierung funktioniert auch für die Haupt-API-Methode:
     ```typescript
     import { fastify, FastifyInstance } from 'fastify'

     const f: FastifyInstance = fastify()
     f.listen({ port: 8080 }, () => { console.log('running') })
     ```
2. `import * as Fastify from 'fastify'`
   - Typen werden aufgelöst und sind über Punktnotation zugänglich
   - Der Aufruf der Haupt-API-Methode von Fastify erfordert eine leicht abweichende Syntax (siehe Beispiel)
   - Beispiel:
     ```typescript
     import * as Fastify from 'fastify'

     const f: Fastify.FastifyInstance = Fastify.fastify()
     f.listen({ port: 8080 }, () => { console.log('running') })
     ```
3. `const fastify = require('fastify')`
   - Diese Syntax ist gültig und importiert fastify wie erwartet; Typen werden jedoch **nicht** aufgelöst
   - Beispiel:
     ```typescript
     const fastify = require('fastify')

     const f = fastify()
     f.listen({ port: 8080 }, () => { console.log('running') })
     ```
   - Destrukturierung wird unterstützt und löst Typen korrekt auf
     ```typescript
     const { fastify } = require('fastify')

     const f = fastify()
     f.listen({ port: 8080 }, () => { console.log('running') })
     ```

#### Generics

Viele Typdefinitionen teilen sich dieselben generischen Parameter; sie sind alle in diesem Abschnitt detailliert dokumentiert.

Die meisten Definitionen hängen von den `@types/node`-Modulen `http`, `https` und `http2` ab

##### RawServer
Zugrunde liegender Node.js-Servertyp

Standard: `http.Server`

Constraints: `http.Server`, `https.Server`, `http2.Http2Server`,
`http2.Http2SecureServer`

Erzwingt generische Parameter: [`RawRequest`][RawRequestGeneric],
[`RawReply`][RawReplyGeneric]

##### RawRequest
Zugrunde liegender Node.js-Request-Typ

Standard: [`RawRequestDefaultExpression`][RawRequestDefaultExpression]

Constraints: `http.IncomingMessage`, `http2.Http2ServerRequest`

Erzwungen durch: [`RawServer`][RawServerGeneric]

##### RawReply
Zugrunde liegender Node.js-Response-Typ

Standard: [`RawReplyDefaultExpression`][RawReplyDefaultExpression]

Constraints: `http.ServerResponse`, `http2.Http2ServerResponse`

Erzwungen durch: [`RawServer`][RawServerGeneric]

##### Logger
Logging-Werkzeug von Fastify

Standard: [`FastifyLoggerOptions`][FastifyLoggerOptions]

Erzwungen durch: [`RawServer`][RawServerGeneric]

##### RawBody
Ein generischer Parameter für die Content-Type-Parser-Methoden.

Constraints: `string | Buffer`

---

#### Fastify

##### fastify< [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [Logger][LoggerGeneric]>(opts?: [FastifyServerOptions][FastifyServerOptions]): [FastifyInstance][FastifyInstance]
[src](https://github.com/fastify/fastify/blob/main/fastify.d.ts#L19)

Die Haupt-API-Methode von Fastify. Standardmäßig erzeugt sie einen HTTP-Server. Über diskriminierende Unions und Überladungen leitet das Typsystem automatisch ab, welcher Servertyp (http, https oder http2) erzeugt wird, rein anhand der an die Methode übergebenen Optionen (weitere Informationen siehe die Beispiele unten). Es unterstützt außerdem ein umfangreiches generisches Typsystem, mit dem der Nutzer die zugrunde liegenden Node.js-Objekte Server, Request und Reply erweitern kann. Zusätzlich existiert das Generic `Logger` für eigene Log-Typen. Weitere Informationen siehe die Beispiele und die Aufschlüsselung der Generics unten.

###### Beispiel 1: Standard-HTTP-Server

Das Generic `Server` muss nicht angegeben werden, da das Typsystem standardmäßig HTTP annimmt.
```typescript
import fastify from 'fastify'

const server = fastify()
```
Eine ausführlichere Anleitung für einen HTTP-Server findest du im Beispiel „Anhand von Beispielen lernen“ – [Erste Schritte](#getting-started).

###### Beispiel 2: HTTPS-Server

1. Erstelle die folgenden Importe aus `@types/node` und `fastify`
   ```typescript
   import fs from 'node:fs'
   import path from 'node:path'
   import fastify from 'fastify'
   ```
2. Führe die folgenden Schritte aus, bevor du einen Fastify-HTTPS-Server einrichtest, um die Dateien `key.pem` und `cert.pem` zu erzeugen:
```sh
openssl genrsa -out key.pem
openssl req -new -key key.pem -out csr.pem
openssl x509 -req -days 9999 -in csr.pem -signkey key.pem -out cert.pem
rm csr.pem
```
3. Instanziiere einen Fastify-HTTPS-Server und füge eine Route hinzu:
   ```typescript
   const server = fastify({
     https: {
       key: fs.readFileSync(path.join(__dirname, 'key.pem')),
       cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
     }
   })

   server.get('/', async function (request, reply) {
     return { hello: 'world' }
   })

   server.listen({ port: 8080 }, (err, address) => {
     if (err) {
       console.error(err)
       process.exit(0)
     }
     console.log(`Server listening at ${address}`)
   })
   ```
4. Bauen und starten! Teste deinen Server mit folgender Abfrage: `curl -k https://localhost:8080`

###### Beispiel 3: HTTP2-Server

Es gibt zwei Arten von HTTP2-Servertypen, unsicher und sicher. Beide erfordern, dass die Eigenschaft `http2` im `options`-Objekt auf `true` gesetzt wird. Die Eigenschaft `https` dient dazu, einen sicheren HTTP2-Server zu erzeugen; lässt man die Eigenschaft `https` weg, entsteht ein unsicherer HTTP2-Server.

```typescript
const insecureServer = fastify({ http2: true })
const secureServer = fastify({
  http2: true,
  https: {} // use the `key.pem` and `cert.pem` files from the https section
})
```

Weitere Details zur Verwendung von HTTP2 findest du auf der Fastify-Dokumentationsseite [HTTP2](./HTTP2.md).

###### Beispiel 4: Erweiterter HTTP-Server

Du kannst nicht nur den Servertyp angeben, sondern auch die Request- und Reply-Typen. Damit lassen sich besondere Eigenschaften, Methoden und mehr festlegen! Wird der eigene Typ bei der Server-Instanziierung angegeben, steht er in allen weiteren Instanzen dieses Typs zur Verfügung.
```typescript
import fastify from 'fastify'
import http from 'node:http'

interface customRequest extends http.IncomingMessage {
  mySpecialProp: string
}

const server = fastify<http.Server, customRequest>()

server.get('/', async (request, reply) => {
  const someValue = request.raw.mySpecialProp // TS knows this is a string, because of the `customRequest` interface
  return someValue.toUpperCase()
})
```

###### Beispiel 5: Logger-Typen angeben

Fastify verwendet unter der Haube die Logging-Bibliothek [Pino](https://getpino.io/#/). Seit `pino@7` können alle ihre Eigenschaften über das Feld `logger` beim Erzeugen der Fastify-Instanz konfiguriert werden. Falls von dir benötigte Eigenschaften nicht bereitgestellt werden, öffne bitte ein Issue bei [`Pino`](https://github.com/pinojs/pino/issues) oder übergib Fastify als vorübergehende Lösung über dasselbe Feld eine vorkonfigurierte externe Pino-Instanz (oder einen anderen kompatiblen Logger). Damit lassen sich auch eigene Serializer erstellen; weitere Informationen siehe die Dokumentation zu [Logging](Logging.md).

```typescript
import fastify from 'fastify'

const server = fastify({
  logger: {
    level: 'info',
    redact: ['x-userinfo'],
    messageKey: 'message'
  }
})

server.get('/', async (request, reply) => {
  server.log.info('log message')
  return 'another message'
})
```

---

##### fastify.HTTPMethods
[src](https://github.com/fastify/fastify/blob/main/types/utils.d.ts#L8)

Union-Typ aus: `'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT' |
'OPTIONS'`

##### fastify.RawServerBase
[src](https://github.com/fastify/fastify/blob/main/types/utils.d.ts#L13)

Abhängig von den `@types/node`-Modulen `http`, `https`, `http2`

Union-Typ aus: `http.Server | https.Server | http2.Http2Server |
http2.Http2SecureServer`

##### fastify.RawServerDefault
[src](https://github.com/fastify/fastify/blob/main/types/utils.d.ts#L18)

Abhängig vom `@types/node`-Modul `http`

Typ-Alias für `http.Server`

---

##### fastify.FastifyServerOptions< [RawServer][RawServerGeneric], [Logger][LoggerGeneric]>

[src](https://github.com/fastify/fastify/blob/main/fastify.d.ts#L29)

Ein Interface mit Eigenschaften, die bei der Instanziierung des Fastify-Servers verwendet werden. Es wird in der Hauptmethode [`fastify()`][Fastify] verwendet. Die generischen Parameter `RawServer` und `Logger` werden über diese Methode weitergereicht.

Beispiele für die Instanziierung eines Fastify-Servers mit TypeScript findest du im Abschnitt zur Typdefinition der Hauptmethode [fastify][Fastify].

##### fastify.FastifyInstance< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RequestGeneric][FastifyRequestGenericInterface], [Logger][LoggerGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/instance.d.ts#L16)

Interface, das das Fastify-Server-Objekt repräsentiert. Es ist die von der Methode [`fastify()`][Fastify] zurückgegebene Server-Instanz. Dieser Typ ist ein Interface, sodass er per [Declaration Merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html) erweitert werden kann, wenn dein Code die Methode `decorate` verwendet.

Durch die Weitergabe der Generics erben alle an der Instanz hängenden Methoden die generischen Eigenschaften aus der Instanziierung. Das bedeutet: Durch Angabe der Server-, Request- oder Reply-Typen wissen alle Methoden, wie diese Objekte zu typisieren sind.

Ausführliche Anleitungen findest du im Hauptabschnitt [Anhand von Beispielen lernen](#learn-by-example) oder in den einfacheren Beispielen zur Methode [fastify][Fastify] für weitere Details zu diesem Interface.

---

#### Request

##### fastify.FastifyRequest< [RequestGeneric][FastifyRequestGenericInterface], [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric]>
[src](https://github.com/fastify/fastify/blob/main/types/request.d.ts#L15)

Dieses Interface enthält Eigenschaften des Fastify-Request-Objekts. Die hier hinzugefügten Eigenschaften sind unabhängig davon, welche Art von Request-Objekt vorliegt (http vs. http2), und unabhängig davon, welche Route-Ebene bedient wird; der Aufruf von `request.body` innerhalb eines GET-Requests wirft daher keinen Fehler (viel Glück beim Senden eines GET-Requests mit Body 😉).

Wenn du dem Objekt `FastifyRequest` eigene Eigenschaften hinzufügen musst (etwa bei Verwendung der Methode [`decorateRequest`][DecorateRequest]), musst du Declaration Merging auf diesem Interface verwenden.

Ein einfaches Beispiel findest du im Abschnitt [`FastifyRequest`][FastifyRequest]. Ein ausführlicheres Beispiel findest du im Abschnitt „Anhand von Beispielen lernen“: [Plugins](#plugins)

###### Beispiel
```typescript
import fastify from 'fastify'

const server = fastify()

server.decorateRequest('someProp', 'hello!')

server.get('/', async (request, reply) => {
  const { someProp } = request // need to use declaration merging to add this prop to the request interface
  return someProp
})

// this declaration must be in scope of the typescript interpreter to work
declare module 'fastify' {
  interface FastifyRequest { // you must reference the interface and not the type
    someProp: string
  }
}

// Or you can type your request using
type CustomRequest = FastifyRequest<{
  Body: { test: boolean };
}>

server.get('/typedRequest', async (request: CustomRequest, reply: FastifyReply) => {
  return request.body.test
})
```

##### fastify.RequestGenericInterface
[src](https://github.com/fastify/fastify/blob/main/types/request.d.ts#L4)

Fastify-Request-Objekte haben vier dynamische Eigenschaften: `body`, `params`, `query` und `headers`. Ihre jeweiligen Typen lassen sich über dieses Interface zuweisen. Es ist ein Interface mit benannten Eigenschaften, sodass Entwickler die Eigenschaften ignorieren können, die sie nicht angeben möchten. Alle ausgelassenen Eigenschaften sind standardmäßig `unknown`. Die entsprechenden Eigenschaftsnamen lauten: `Body`, `Querystring`, `Params`, `Headers`.

```typescript
import fastify, { RequestGenericInterface } from 'fastify'

const server = fastify()

interface requestGeneric extends RequestGenericInterface {
  Querystring: {
    name: string
  }
}

server.get<requestGeneric>('/', async (request, reply) => {
  const { name } = request.query // the name prop now exists on the query prop
  return name.toUpperCase()
})
```

Wenn du ein detailliertes Beispiel zur Verwendung dieses Interfaces sehen möchtest, sieh dir den Abschnitt „Anhand von Beispielen lernen“ an: [JSON Schema](#json-schema).

##### fastify.RawRequestDefaultExpression\<[RawServer][RawServerGeneric]\>
[src](https://github.com/fastify/fastify/blob/main/types/utils.d.ts#L23)

Abhängig von den `@types/node`-Modulen `http`, `https`, `http2`

Der generische Parameter `RawServer` ist standardmäßig [`RawServerDefault`][RawServerDefault]

Wenn `RawServer` vom Typ `http.Server` oder `https.Server` ist, gibt dieser Ausdruck `http.IncomingMessage` zurück, andernfalls `http2.Http2ServerRequest`.

```typescript
import http from 'node:http'
import http2 from 'node:http2'
import { RawRequestDefaultExpression } from 'fastify'

RawRequestDefaultExpression<http.Server> // -> http.IncomingMessage
RawRequestDefaultExpression<http2.Http2Server> // -> http2.Http2ServerRequest
```

---

#### Reply

##### fastify.FastifyReply<[RequestGeneric][FastifyRequestGenericInterface], [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [ContextConfig][ContextConfigGeneric]>
[src](https://github.com/fastify/fastify/blob/main/types/reply.d.ts#L32)

Dieses Interface enthält die eigenen Eigenschaften, die Fastify dem Standard-Node.js-Reply-Objekt hinzufügt. Die hier hinzugefügten Eigenschaften sind unabhängig davon, welche Art von Reply-Objekt vorliegt (http vs. http2).

Wenn du dem FastifyReply-Objekt eigene Eigenschaften hinzufügen musst (etwa bei Verwendung der Methode `decorateReply`), musst du Declaration Merging auf diesem Interface verwenden.

Ein einfaches Beispiel findest du im Abschnitt [`FastifyReply`][FastifyReply]. Ein ausführlicheres Beispiel findest du im Abschnitt „Anhand von Beispielen lernen“: [Plugins](#plugins)

###### Beispiel
```typescript
import fastify from 'fastify'

const server = fastify()

server.decorateReply('someProp', 'world')

server.get('/', async (request, reply) => {
  const { someProp } = reply // need to use declaration merging to add this prop to the reply interface
  return someProp
})

// this declaration must be in scope of the typescript interpreter to work
declare module 'fastify' {
  interface FastifyReply { // you must reference the interface and not the type
    someProp: string
  }
}
```

##### fastify.RawReplyDefaultExpression< [RawServer][RawServerGeneric]>
[src](https://github.com/fastify/fastify/blob/main/types/utils.d.ts#L27)

Abhängig von den `@types/node`-Modulen `http`, `https`, `http2`

Der generische Parameter `RawServer` ist standardmäßig [`RawServerDefault`][RawServerDefault]

Wenn `RawServer` vom Typ `http.Server` oder `https.Server` ist, gibt dieser Ausdruck `http.ServerResponse` zurück, andernfalls `http2.Http2ServerResponse`.

```typescript
import http from 'node:http'
import http2 from 'node:http2'
import { RawReplyDefaultExpression } from 'fastify'

RawReplyDefaultExpression<http.Server> // -> http.ServerResponse
RawReplyDefaultExpression<http2.Http2Server> // -> http2.Http2ServerResponse
```

---

#### Plugin

Fastify erlaubt es Nutzern, seine Funktionalität mit Plugins zu erweitern. Ein Plugin kann eine Menge von Routes sein, ein Server-Decorator oder was auch immer. Um Plugins zu aktivieren, verwende die Methode [`fastify.register()`][FastifyRegister].

Beim Erstellen von Plugins für Fastify wird empfohlen, das Modul `fastify-plugin` zu verwenden. Zusätzlich gibt es im Abschnitt „Anhand von Beispielen lernen“ unter [Plugins](#plugins) eine Anleitung zum Erstellen von Plugins mit TypeScript und Fastify.

##### fastify.FastifyPluginCallback< [Options][FastifyPluginOptions]>
[src](https://github.com/fastify/fastify/blob/main/types/plugin.d.ts#L9)

Definition der Interface-Methode, die innerhalb der Methode [`fastify.register()`][FastifyRegister] verwendet wird.

##### fastify.FastifyPluginAsync< [Options][FastifyPluginOptions]>
[src](https://github.com/fastify/fastify/blob/main/types/plugin.d.ts#L20)

Definition der Interface-Methode, die innerhalb der Methode [`fastify.register()`][FastifyRegister] verwendet wird.

##### fastify.FastifyPlugin< [Options][FastifyPluginOptions]>
[src](https://github.com/fastify/fastify/blob/main/types/plugin.d.ts#L29)

Definition der Interface-Methode, die innerhalb der Methode [`fastify.register()`][FastifyRegister] verwendet wird. In der Dokumentation zugunsten von `FastifyPluginCallback` und `FastifyPluginAsync` als deprecated markiert, da das allgemeine `FastifyPlugin` Typen für async-Funktionen nicht korrekt inferiert.

##### fastify.FastifyPluginOptions
[src](https://github.com/fastify/fastify/blob/main/types/plugin.d.ts#L31)

Ein lose typisiertes Objekt, das den Parameter `options` von [`fastify.register()`][FastifyRegister] auf ein Objekt einschränkt. Definiere beim Erstellen eines Plugins dessen Optionen als Erweiterung dieses Interfaces (`interface MyPluginOptions extends FastifyPluginOptions`), damit sie an die register-Methode übergeben werden können.

---

#### Register

##### fastify.FastifyRegister(plugin: [FastifyPluginCallback][FastifyPluginCallback], opts: [FastifyRegisterOptions][FastifyRegisterOptions])
[src](https://github.com/fastify/fastify/blob/main/types/register.d.ts#L9)
##### fastify.FastifyRegister(plugin: [FastifyPluginAsync][FastifyPluginAsync], opts: [FastifyRegisterOptions][FastifyRegisterOptions])
[src](https://github.com/fastify/fastify/blob/main/types/register.d.ts#L9)
##### fastify.FastifyRegister(plugin: [FastifyPlugin][FastifyPlugin], opts: [FastifyRegisterOptions][FastifyRegisterOptions])
[src](https://github.com/fastify/fastify/blob/main/types/register.d.ts#L9)

Dieses Typ-Interface gibt den Typ für die Methode [`fastify.register()`](./Server.md#register) an. Das Typ-Interface liefert eine Funktionssignatur mit einem zugrunde liegenden Generic `Options`, das standardmäßig [FastifyPluginOptions][FastifyPluginOptions] ist. Es inferiert dieses Generic beim Aufruf der Funktion aus dem Parameter FastifyPlugin, sodass das zugrunde liegende Generic nicht angegeben werden muss. Der Parameter options ist die Schnittmenge der Plugin-Optionen und zweier zusätzlicher optionaler Eigenschaften: `prefix: string` und `logLevel`: [LogLevel][LogLevel]. `FastifyPlugin` ist deprecated, verwende stattdessen `FastifyPluginCallback` und `FastifyPluginAsync`.

Unten ein Beispiel für die Options-Inferenz in Aktion:

```typescript
const server = fastify()

const plugin: FastifyPluginCallback<{
  option1: string;
  option2: boolean;
}> = function (instance, opts, done) { }

server().register(plugin, {}) // Error - options object is missing required properties
server().register(plugin, { option1: '', option2: true }) // OK - options object contains required properties
```

Ausführlichere Beispiele zum Erstellen von TypeScript-Plugins in Fastify findest du im Abschnitt „Anhand von Beispielen lernen“, [Plugins](#plugins).

##### fastify.FastifyRegisterOptions
[src](https://github.com/fastify/fastify/blob/main/types/register.d.ts#L16)

Dieser Typ ist die Schnittmenge des Generics `Options` und eines nicht exportierten Interfaces `RegisterOptions`, das zwei optionale Eigenschaften angibt: `prefix: string` und `logLevel`: [LogLevel][LogLevel]. Dieser Typ kann auch als Funktion angegeben werden, die die zuvor beschriebene Schnittmenge zurückgibt.

---

#### Logger

Weitere Details zur Angabe eines eigenen Loggers findest du im Beispiel [Logger-Typen angeben](#example-5-specifying-logger-types).

##### fastify.FastifyLoggerOptions< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/logger.d.ts#L17)

Eine Interface-Definition für den internen Fastify-Logger. Sie bildet den Logger von [Pino.js](https://getpino.io/#/) nach. Ist er über die Server-Optionen aktiviert, verwende ihn gemäß der allgemeinen [Logger](./Logging.md)-Dokumentation.

##### fastify.FastifyLogFn

[src](https://github.com/fastify/fastify/blob/main/types/logger.d.ts#L7)

Ein überladenes Funktions-Interface, das die zwei Arten implementiert, wie Fastify Log-Methoden aufruft. Dieses Interface wird an alle zugehörigen Log-Level-Eigenschaften des FastifyLoggerOptions-Objekts übergeben.

##### fastify.LogLevel

[src](https://github.com/fastify/fastify/blob/main/types/logger.d.ts#L12)

Union-Typ aus: `'info' | 'error' | 'debug' | 'fatal' | 'warn' | 'trace'`

---

#### Context

Die Typdefinition für den Kontext ähnelt den anderen hochdynamischen Teilen des Typsystems. Der Route-Kontext steht in der Route-Handler-Methode zur Verfügung.

##### fastify.FastifyRequestContext

[src](https://github.com/fastify/fastify/blob/main/types/context.d.ts#L11)

Ein Interface mit einer einzigen erforderlichen Eigenschaft `config`, die standardmäßig auf `unknown` gesetzt ist. Sie kann entweder über ein Generic oder eine Überladung angegeben werden.

Diese Typdefinition ist möglicherweise unvollständig. Wenn du sie verwendest und genauere Angaben dazu machen kannst, wie sie sich verbessern lässt, ermutigen wir dich nachdrücklich, ein Issue im Haupt-Repository [fastify/fastify](https://github.com/fastify/fastify) zu öffnen. Vielen Dank im Voraus!

##### fastify.FastifyReplyContext

[src](https://github.com/fastify/fastify/blob/main/types/context.d.ts#L11)

Ein Interface mit einer einzigen erforderlichen Eigenschaft `config`, die standardmäßig auf `unknown` gesetzt ist. Sie kann entweder über ein Generic oder eine Überladung angegeben werden.

Diese Typdefinition ist möglicherweise unvollständig. Wenn du sie verwendest und genauere Angaben dazu machen kannst, wie sie sich verbessern lässt, ermutigen wir dich nachdrücklich, ein Issue im Haupt-Repository [fastify/fastify](https://github.com/fastify/fastify) zu öffnen. Vielen Dank im Voraus!

---

#### Routing

Eines der Kernprinzipien von Fastify sind seine Routing-Fähigkeiten. Die meisten der in diesem Abschnitt definierten Typen werden unter der Haube von den Methoden `.route` und `.get/.post/.etc` der Fastify-Instanz verwendet.

##### fastify.RouteHandlerMethod< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/route.d.ts#L105)

Eine Typdeklaration für die Route-Handler-Methoden. Sie hat zwei Argumente, `request` und `reply`, die durch `FastifyRequest` bzw. `FastifyReply` typisiert sind. Die generischen Parameter werden an diese Argumente durchgereicht. Die Methode gibt für synchrone bzw. asynchrone Handler entweder `void` oder `Promise<any>` zurück.

##### fastify.RouteOptions< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/route.d.ts#L78)

Ein Interface, das RouteShorthandOptions erweitert und die folgenden drei erforderlichen Eigenschaften ergänzt:
1. `method`, das einer einzelnen [HTTPMethod][HTTPMethods] oder einer Liste von [HTTPMethods][HTTPMethods] entspricht
2. `url`, ein String für die Route
3. `handler`, die Route-Handler-Methode, weitere Details siehe [RouteHandlerMethod][]

##### fastify.RouteShorthandMethod< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/route.d.ts#12)

Ein überladenes Funktions-Interface für drei Arten von Kurzform-Route-Methoden, die zusammen mit den Methoden `.get/.post/.etc` verwendet werden.

##### fastify.RouteShorthandOptions< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/route.d.ts#55)

Ein Interface, das alle Basisoptionen für eine Route abdeckt. Jede Eigenschaft dieses Interfaces ist optional, und es dient als Basis für die Interfaces RouteOptions und RouteShorthandOptionsWithHandler.

##### fastify.RouteShorthandOptionsWithHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/route.d.ts#93)

Dieses Interface fügt dem Interface RouteShorthandOptions eine einzige erforderliche Eigenschaft `handler` vom Typ RouteHandlerMethod hinzu

---

#### Parser

##### RawBody

Ein generischer Typ, der entweder ein `string` oder ein `Buffer` ist

##### fastify.FastifyBodyParser< [RawBody][RawBodyGeneric], [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/content-type-parser.d.ts#L7)

Eine Funktionstyp-Definition zur Angabe einer Body-Parser-Methode. Verwende das Generic `RawBody`, um den Typ des zu parsenden Bodys anzugeben.

##### fastify.FastifyContentTypeParser< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/content-type-parser.d.ts#L17)

Eine Funktionstyp-Definition zur Angabe einer Body-Parser-Methode. Der Inhalt wird über das Generic `RawRequest` typisiert.

##### fastify.AddContentTypeParser< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric]>

[src](https://github.com/fastify/fastify/blob/main/types/content-type-parser.d.ts#L46)

Eine überladene Interface-Funktionsdefinition für die Methode `addContentTypeParser`. Wird `parseAs` im Parameter `opts` übergeben, verwendet die Definition [FastifyBodyParser][] für den Parameter `parser`; andernfalls verwendet sie [FastifyContentTypeParser][].

##### fastify.hasContentTypeParser

[src](https://github.com/fastify/fastify/blob/main/types/content-type-parser.d.ts#L63)

Eine Methode, um zu prüfen, ob ein Typ-Parser für einen bestimmten Content-Type existiert

---

#### Fehler

##### fastify.FastifyError

[src](https://github.com/fastify/fastify/blob/main/fastify.d.ts#L179)

FastifyError ist ein eigenes Fehlerobjekt, das Statuscode und Validierungsergebnisse enthält.

Es erweitert den Node.js-Typ `Error` und ergänzt zwei zusätzliche, optionale Eigenschaften: `statusCode: number` und `validation: ValidationResult[]`.

##### fastify.ValidationResult

[src](https://github.com/fastify/fastify/blob/main/fastify.d.ts#L184)

Die Route-Validierung stützt sich intern auf Ajv, einen hochperformanten JSON-Schema-Validator.

Dieses Interface wird an eine Instanz von FastifyError übergeben.

---

#### Hooks

##### fastify.onRequestHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], done: (err?: [FastifyError][FastifyError]) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L17)

`onRequest` ist der erste Hook, der im Request-Lebenszyklus ausgeführt wird. Es gab keinen vorherigen Hook, der nächste Hook ist `preParsing`.

Hinweis: Im `onRequest`-Hook ist request.body immer null, weil das Parsen des Bodys vor dem `preHandler`-Hook geschieht.

##### fastify.preParsingHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], done: (err?: [FastifyError][FastifyError]) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L35)

`preParsing` ist der zweite Hook, der im Request-Lebenszyklus ausgeführt wird. Der vorherige Hook war `onRequest`, der nächste Hook ist `preValidation`.

Hinweis: Im `preParsing`-Hook ist request.body immer null, weil das Parsen des Bodys vor dem `preValidation`-Hook geschieht.

Hinweis: Du solltest dem zurückgegebenen Stream außerdem die Eigenschaft `receivedEncodedLength` hinzufügen. Diese Eigenschaft dient dazu, das Request-Payload korrekt mit dem Wert des `Content-Length`-Headers abzugleichen. Idealerweise sollte diese Eigenschaft bei jedem empfangenen Chunk aktualisiert werden.

##### fastify.preValidationHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], done: (err?: [FastifyError][FastifyError]) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L53)

`preValidation` ist der dritte Hook, der im Request-Lebenszyklus ausgeführt wird. Der vorherige Hook war `preParsing`, der nächste Hook ist `preHandler`.

##### fastify.preHandlerHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], done: (err?: [FastifyError][FastifyError]) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L70)

`preHandler` ist der vierte Hook, der im Request-Lebenszyklus ausgeführt wird. Der vorherige Hook war `preValidation`, der nächste Hook ist `preSerialization`.

##### fastify.preSerializationHookHandler< PreSerializationPayload, [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], payload: PreSerializationPayload, done: (err: [FastifyError][FastifyError] | null, res?: unknown) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L94)

`preSerialization` ist der fünfte Hook, der im Request-Lebenszyklus ausgeführt wird. Der vorherige Hook war `preHandler`, der nächste Hook ist `onSend`.

> ℹ️ Hinweis:
> Der Hook wird NICHT aufgerufen, wenn das Payload ein String, ein Buffer,
> ein Stream oder null ist.

##### fastify.onSendHookHandler< OnSendPayload, [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], payload: OnSendPayload, done: (err: [FastifyError][FastifyError] | null, res?: unknown) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L114)

Mit dem `onSend`-Hook kannst du das Payload ändern. Es ist der sechste Hook, der im Request-Lebenszyklus ausgeführt wird. Der vorherige Hook war `preSerialization`, der nächste Hook ist `onResponse`.

> ℹ️ Hinweis:
>  Wenn du das Payload änderst, darfst du es nur in einen String,
> einen Buffer, einen Stream oder null ändern.

##### fastify.onResponseHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], done: (err?: [FastifyError][FastifyError]) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L134)

`onResponse` ist der siebte und letzte Hook im Lebenszyklus der Request-Hooks. Der vorherige Hook war `onSend`, es gibt keinen nächsten Hook.

Der onResponse-Hook wird ausgeführt, nachdem eine Response gesendet wurde, du kannst dem Client also keine weiteren Daten mehr senden. Er kann jedoch nützlich sein, um Daten an externe Dienste zu senden, etwa um Statistiken zu sammeln.

##### fastify.onErrorHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(request: [FastifyRequest][FastifyRequest], reply: [FastifyReply][FastifyReply], error: [FastifyError][FastifyError], done: () => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L154)

Dieser Hook ist nützlich, wenn du eigenes Fehler-Logging betreiben oder im Fehlerfall einen bestimmten Header setzen musst.

Er ist nicht dazu gedacht, den Fehler zu ändern, und der Aufruf von reply.send wirft eine Exception.

Dieser Hook wird vor dem customErrorHandler ausgeführt.

Hinweis: Anders als bei den übrigen Hooks wird das Übergeben eines Fehlers an die done-Funktion nicht unterstützt.

##### fastify.onRouteHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [RequestGeneric][FastifyRequestGenericInterface], [ContextConfig][ContextConfigGeneric]>(opts: [RouteOptions][RouteOptions] & \{ path: string; prefix: string }): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L174)

Wird ausgelöst, wenn eine neue Route registriert wird. Den Listenern wird ein routeOptions-Objekt als einziger Parameter übergeben. Das Interface ist synchron, und deshalb bekommt der Listener keinen Callback übergeben

##### fastify.onRegisterHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [Logger][LoggerGeneric]>(instance: [FastifyInstance][FastifyInstance], done: (err?: [FastifyError][FastifyError]) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L191)

Wird ausgelöst, wenn ein neues Plugin registriert und ein neuer Kapselungskontext erzeugt wird. Der Hook wird vor dem registrierten Code ausgeführt.

Dieser Hook kann nützlich sein, wenn du ein Plugin entwickelst, das wissen muss, wann ein Plugin-Kontext gebildet wird, und du in genau diesem Kontext arbeiten möchtest.

> ℹ️ Hinweis:
> Dieser Hook wird nicht aufgerufen, wenn ein Plugin in fastify-plugin eingepackt ist.

##### fastify.onCloseHookHandler< [RawServer][RawServerGeneric], [RawRequest][RawRequestGeneric], [RawReply][RawReplyGeneric], [Logger][LoggerGeneric]>(instance: [FastifyInstance][FastifyInstance], done: (err?: [FastifyError][FastifyError]) => void): Promise\<unknown\> | void

[src](https://github.com/fastify/fastify/blob/main/types/hooks.d.ts#L206)

Wird ausgelöst, wenn fastify.close() aufgerufen wird, um den Server zu stoppen. Er ist nützlich, wenn Plugins ein „Shutdown“-Event benötigen, zum Beispiel um eine offene Verbindung zu einer Datenbank zu schließen.


<!-- Links -->

[Fastify]:
    #fastifyrawserver-rawrequest-rawreply-loggeropts-fastifyserveroptions-fastifyinstance
[RawServerGeneric]: #rawserver
[RawRequestGeneric]: #rawrequest
[RawReplyGeneric]: #rawreply
[LoggerGeneric]: #logger
[RawBodyGeneric]: #rawbody
[HTTPMethods]: #fastifyhttpmethods
[RawServerBase]: #fastifyrawserverbase
[RawServerDefault]: #fastifyrawserverdefault
[FastifyRequest]: #fastifyfastifyrequestrawserver-rawrequest-requestgeneric
[FastifyRequestGenericInterface]: #fastifyrequestgenericinterface
[RawRequestDefaultExpression]: #fastifyrawrequestdefaultexpressionrawserver
[FastifyReply]: #fastifyfastifyreplyrawserver-rawreply-contextconfig
[RawReplyDefaultExpression]: #fastifyrawreplydefaultexpression
[FastifyServerOptions]: #fastifyfastifyserveroptions-rawserver-logger
[FastifyInstance]: #fastifyfastifyinstance
[FastifyLoggerOptions]: #fastifyfastifyloggeroptions
[ContextConfigGeneric]: #ContextConfigGeneric
[FastifyPlugin]:
    #fastifyfastifypluginoptions-rawserver-rawrequest-requestgeneric
[FastifyPluginCallback]: #fastifyfastifyplugincallbackoptions
[FastifyPluginAsync]: #fastifyfastifypluginasyncoptions
[FastifyPluginOptions]: #fastifyfastifypluginoptions
[FastifyRegister]:
    #fastifyfastifyregisterrawserver-rawrequest-requestgenericplugin-fastifyplugin-opts-fastifyregisteroptions
[FastifyRegisterOptions]: #fastifyfastifytregisteroptions
[LogLevel]: #fastifyloglevel
[FastifyError]: #fastifyfastifyerror
[RouteOptions]:
    #fastifyrouteoptionsrawserver-rawrequest-rawreply-requestgeneric-contextconfig
