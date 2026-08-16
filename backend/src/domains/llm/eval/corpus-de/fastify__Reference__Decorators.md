<h1 align="center">Fastify</h1>

## Decorators

Die Decorators-API passt zentrale Fastify-Objekte an, etwa die Server-Instanz
sowie sämtliche Request- und Reply-Objekte, die während des HTTP-Request-Lifecycles
verwendet werden. Sie kann Kernobjekten jede Art von Eigenschaft anhängen, z. B.
Funktionen, einfache Objekte oder native Typen.

Diese API ist *synchron*. Eine Dekoration asynchron zu definieren könnte dazu führen,
dass die Fastify-Instanz bootet, bevor die Dekoration abgeschlossen ist. Um eine
asynchrone Dekoration zu registrieren, verwenden Sie die `register`-API zusammen mit
`fastify-plugin`. Weitere Details finden Sie in der Dokumentation zu
[Plugins](./Plugins.md).

Das Dekorieren von Kernobjekten mit dieser API erlaubt es der zugrunde liegenden
JavaScript-Engine, die Verarbeitung von Server-, Request- und Reply-Objekten zu
optimieren. Erreicht wird das, indem die Form all dieser Objektinstanzen festgelegt
wird, bevor sie instanziiert und verwendet werden. Das folgende Beispiel ist etwa
nicht empfehlenswert, weil es die Form von Objekten während ihres Lebenszyklus ändert:

```js
// Bad example! Continue reading.

// Attach a user property to the incoming request before the request
// handler is invoked.
fastify.addHook('preHandler', function (req, reply, done) {
  req.user = 'Bob Dylan'
  done()
})

// Use the attached user property in the request handler.
fastify.get('/', function (req, reply) {
  reply.send(`Hello, ${req.user}`)
})
```

Das obige Beispiel verändert das Request-Objekt nach der Instanziierung, wodurch die
JavaScript-Engine den Zugriff deoptimiert. Die Verwendung der Decoration-API vermeidet
diese Deoptimierung:

```js
// Decorate request with a 'user' property
fastify.decorateRequest('user', '')

// Update our property
fastify.addHook('preHandler', (req, reply, done) => {
  req.user = 'Bob Dylan'
  done()
})
// And finally access it
fastify.get('/', (req, reply) => {
  reply.send(`Hello, ${req.user}!`)
})
```

Halten Sie die anfängliche Form eines dekorierten Feldes nahe an seinem künftigen
dynamischen Wert. Initialisieren Sie einen Decorator für Strings mit `''` und für
Objekte oder Funktionen mit `null`. Das funktioniert nur mit Werttypen; Referenztypen
werfen beim Start von Fastify einen Fehler. Weitere Informationen finden Sie unter
[decorateRequest](#decorate-request) und in [JavaScript engine fundamentals: Shapes
and Inline Caches](https://mathiasbynens.be/notes/shapes-ics).

### Verwendung
<a id="usage"></a>

#### `decorate(name, value, [dependencies])`
<a id="decorate"></a>

Diese Methode passt die Fastify-[Server](./Server.md)-Instanz an.

Um beispielsweise eine neue Methode an die Server-Instanz anzuhängen:

```js
fastify.decorate('utility', function () {
  // Something very useful
})
```

Auch Werte, die keine Funktionen sind, lassen sich an die Server-Instanz anhängen:

```js
fastify.decorate('conf', {
  db: 'some.db',
  port: 3000
})
```

Um auf dekorierte Eigenschaften zuzugreifen, verwenden Sie den Namen, der der
Decoration-API übergeben wurde:

```js
fastify.utility()

console.log(fastify.conf.db)
```

Der dekorierte [Fastify-Server](./Server.md) ist in [Route](./Routes.md)-Handlern an
`this` gebunden:

```js
fastify.decorate('db', new DbConnection())

fastify.get('/', async function (request, reply) {
  // using return
  return { hello: await this.db.query('world') }

  // or
  // using reply.send()
  reply.send({ hello: await this.db.query('world') })
  await reply
})
```

Der Parameter `dependencies` ist eine optionale Liste von Decorators, auf die sich der
gerade definierte Decorator stützt. Diese Liste enthält die Namen anderer Decorators.
Im folgenden Beispiel hängt der Decorator „utility“ von den Decorators „greet“ und
„hi“ ab:

```js
async function greetDecorator (fastify, opts) {
  fastify.decorate('greet', () => {
    return 'greet message'
  })
}

async function hiDecorator (fastify, opts) {
  fastify.decorate('hi', () => {
    return 'hi message'
  })
}

async function utilityDecorator (fastify, opts) {
  fastify.decorate('utility', () => {
    return `${fastify.greet()} | ${fastify.hi()}`
  })
}

fastify.register(fastifyPlugin(greetDecorator, { name: 'greet' }))
fastify.register(fastifyPlugin(hiDecorator, { name: 'hi' }))
fastify.register(fastifyPlugin(utilityDecorator, { dependencies: ['greet', 'hi'] }))

fastify.get('/', function (req, reply) {
  // Response: {"hello":"greet message | hi message"}
  reply.send({ hello: fastify.utility() })
})

fastify.listen({ port: 3000 }, (err, address) => {
  if (err) throw err
})
```

Die Verwendung einer Arrow Function bricht die Bindung von `this` an die
`FastifyInstance`.

Ist eine Abhängigkeit nicht erfüllt, wirft die Methode `decorate` eine Exception.
Die Abhängigkeitsprüfung findet vor dem Booten der Server-Instanz statt, nicht zur
Laufzeit.

#### `decorateReply(name, value, [dependencies])`
<a id="decorate-reply"></a>

Diese API fügt dem zentralen `Reply`-Objekt neue Methoden/Eigenschaften hinzu:

```js
fastify.decorateReply('utility', function () {
  // Something very useful
})
```

Die Verwendung einer Arrow Function bricht die Bindung von `this` an die
Fastify-`Reply`-Instanz.

Die Verwendung von `decorateReply` wirft einen Fehler, wenn sie mit einem Referenztyp
erfolgt:

```js
// Don't do this
fastify.decorateReply('foo', { bar: 'fizz'})
```
In diesem Beispiel würde die Objektreferenz von allen Requests geteilt, und
**jede Mutation würde alle Requests betreffen, was potenziell Sicherheitslücken
oder Speicherlecks erzeugt**. Fastify unterbindet das.

Um über Requests hinweg saubere Kapselung zu erreichen, konfigurieren Sie für jeden
eingehenden Request im [`'onRequest'`-Hook](./Hooks.md#onrequest) einen neuen Wert.

```js
const fp = require('fastify-plugin')

async function myPlugin (app) {
  app.decorateReply('foo')
  app.addHook('onRequest', async (req, reply) => {
    reply.foo = { bar: 42 }
  })
}

module.exports = fp(myPlugin)
```

Informationen zum Parameter `dependencies` finden Sie unter [`decorate`](#decorate).

#### `decorateRequest(name, value, [dependencies])`
<a id="decorate-request"></a>

Wie bei [`decorateReply`](#decorate-reply) fügt diese API dem zentralen
`Request`-Objekt neue Methoden/Eigenschaften hinzu:

```js
fastify.decorateRequest('utility', function () {
  // something very useful
})
```

Die Verwendung einer Arrow Function bricht die Bindung von `this` an die
Fastify-`Request`-Instanz.

Die Verwendung von `decorateRequest` gibt einen Fehler aus, wenn sie mit einem
Referenztyp erfolgt:

```js
// Don't do this
fastify.decorateRequest('foo', { bar: 'fizz'})
```
In diesem Beispiel würde die Objektreferenz von allen Requests geteilt, und
**jede Mutation würde alle Requests betreffen, was potenziell Sicherheitslücken
oder Speicherlecks erzeugt**. Fastify unterbindet das.

Um über Requests hinweg saubere Kapselung zu erreichen, konfigurieren Sie für jeden
eingehenden Request im [`'onRequest'`-Hook](./Hooks.md#onrequest) einen neuen Wert.

Beispiel:

```js
const fp = require('fastify-plugin')

async function myPlugin (app) {
  app.decorateRequest('foo')
  app.addHook('onRequest', async (req, reply) => {
    req.foo = { bar: 42 }
  })
}

module.exports = fp(myPlugin)
```

Die Hook-Lösung ist flexibler und erlaubt komplexere Initialisierung, weil sich im
`onRequest`-Hook mehr Logik unterbringen lässt.

Ein weiterer Ansatz ist das Getter/Setter-Muster, das jedoch 2 Decorators erfordert:

```js
fastify.decorateRequest('my_decorator_holder') // define the holder
fastify.decorateRequest('user', {
  getter () {
    this.my_decorator_holder ??= {} // initialize the holder
    return this.my_decorator_holder
  }
})

fastify.get('/', async function (req, reply) {
  req.user.access = 'granted'
  // other code
})
```

Damit ist sichergestellt, dass die Eigenschaft `user` für jeden Request stets
eindeutig ist.

Informationen zum Parameter `dependencies` finden Sie unter [`decorate`](#decorate).

#### `hasDecorator(name)`
<a id="has-decorator"></a>

Wird verwendet, um die Existenz einer Dekoration der Server-Instanz zu prüfen:

```js
fastify.hasDecorator('utility')
```

#### hasRequestDecorator
<a id="has-request-decorator"></a>

Wird verwendet, um die Existenz einer Request-Dekoration zu prüfen:

```js
fastify.hasRequestDecorator('utility')
```

#### hasReplyDecorator
<a id="has-reply-decorator"></a>

Wird verwendet, um die Existenz einer Reply-Dekoration zu prüfen:

```js
fastify.hasReplyDecorator('utility')
```

### Decorators und Kapselung
<a id="decorators-encapsulation"></a>

Einen Decorator (mit `decorate`, `decorateRequest` oder `decorateReply`) mehr als
einmal mit demselben Namen im selben **gekapselten** Kontext zu definieren, wirft
eine Exception. Das Folgende wirft zum Beispiel:

```js
const server = require('fastify')()

server.decorateReply('view', function (template, args) {
  // Amazing view rendering engine
})

server.get('/', (req, reply) => {
  reply.view('/index.html', { hello: 'world' })
})

// Somewhere else in our codebase, we define another
// view decorator. This throws.
server.decorateReply('view', function (template, args) {
  // Another rendering engine
})

server.listen({ port: 3000 })
```


Dies hingegen nicht:

```js
const server = require('fastify')()

server.decorateReply('view', function (template, args) {
  // Amazing view rendering engine.
})

server.register(async function (server, opts) {
  // We add a view decorator to the current encapsulated
  // plugin. This will not throw as outside of this encapsulated
  // plugin view is the old one, while inside it is the new one.
  server.decorateReply('view', function (template, args) {
    // Another rendering engine
  })

  server.get('/', (req, reply) => {
    reply.view('/index.page', { hello: 'world' })
  })
}, { prefix: '/bar' })

server.listen({ port: 3000 })
```

### Getter und Setter
<a id="getters-setters"></a>

Decorators akzeptieren spezielle „Getter/Setter“-Objekte mit einer `getter`- und einer
optionalen `setter`-Funktion. Damit lassen sich Eigenschaften über Decorators
definieren, zum Beispiel:

```js
fastify.decorate('foo', {
  getter () {
    return 'a getter'
  }
})
```

Definiert die Eigenschaft `foo` auf der Fastify-Instanz:

```js
console.log(fastify.foo) // 'a getter'
```

#### `getDecorator(name)`
<a id="get-decorator"></a>

Wird verwendet, um einen bestehenden Decorator von der Fastify-Instanz, von `Request`
oder von `Reply` abzurufen.
Ist der Decorator nicht definiert, wird ein `FST_ERR_DEC_UNDECLARED`-Fehler geworfen.

```js
// Get a decorator from the Fastify instance
const utility = fastify.getDecorator('utility')

// Get a decorator from the request object
const user = request.getDecorator('user')

// Get a decorator from the reply object
const helper = reply.getDecorator('helper')
```

Die Methode `getDecorator` ist nützlich zur Validierung von Abhängigkeiten – mit ihr
lässt sich zur Registrierungszeit prüfen, ob erforderliche Decorators vorhanden sind.
Fehlt einer, schlägt der Start fehl, wodurch sichergestellt ist, dass die
Abhängigkeiten während des Request-Lifecycles verfügbar sind.

```js
fastify.register(async function (fastify) {
  // Verify the decorator exists before using it
  const usersRepository = fastify.getDecorator('usersRepository')

  fastify.get('/users', async function (request, reply) {
    return usersRepository.findAll()
  })
})
```

> ℹ️ Hinweis:
> Für TypeScript-Nutzende unterstützt `getDecorator` generische Typparameter.
> Beispiele für fortgeschrittene Typisierung finden Sie in der
> [TypeScript-Dokumentation](./TypeScript.md).

#### `setDecorator(name, value)`
<a id="set-decorator"></a>

Wird verwendet, um den Wert eines `Request`-Decorators sicher zu aktualisieren.
Existiert der Decorator nicht, wird ein `FST_ERR_DEC_UNDECLARED`-Fehler geworfen.

```js
fastify.decorateRequest('user', null)

fastify.addHook('preHandler', async (req, reply) => {
  // Safely set the decorator value
  req.setDecorator('user', 'Bob Dylan')
})
```

Die Methode `setDecorator` bietet Laufzeitsicherheit, indem sie sicherstellt, dass der
Decorator existiert, bevor sein Wert gesetzt wird, und so Fehler durch Tippfehler in
Decorator-Namen verhindert.

```js
fastify.decorateRequest('account', null)
fastify.addHook('preHandler', async (req, reply) => {
  // This will throw FST_ERR_DEC_UNDECLARED due to typo in decorator name
  req.setDecorator('acount', { id: 123 })
})
```

> ℹ️ Hinweis:
> Für TypeScript-Nutzende finden Sie in der
> [TypeScript-Dokumentation](./TypeScript.md) Beispiele für fortgeschrittene
> Typisierung mit `setDecorator<T>`.
