<h1 align="center">Fastify</h1>

## Plugins
Fastify kann mit Plugins erweitert werden, die eine Menge von Routes, ein
Server-[Decorator](./Decorators.md) oder andere Funktionalität sein können.
Verwenden Sie die `register`-API, um ein oder mehrere Plugins hinzuzufügen.

Standardmäßig erzeugt `register` einen *neuen Scope*, das heißt Änderungen an der
Fastify-Instanz (per `decorate`) wirken sich nicht auf die Vorfahren des
aktuellen Kontexts aus, sondern nur auf dessen Nachfahren. Diese Eigenschaft
ermöglicht *Kapselung* und *Vererbung* von Plugins, erzeugt einen *gerichteten
azyklischen Graphen* (DAG) und vermeidet Probleme mit gegenseitigen
Abhängigkeiten.

Der Guide [Getting Started](../Guides/Getting-Started.md#your-first-plugin)
enthält ein Beispiel für die Verwendung dieser API:
```js
fastify.register(plugin, [options])
```

### Plugin-Optionen
<a id="plugin-options"></a>

Der optionale Parameter `options` von `fastify.register` unterstützt eine
vordefinierte Menge von Optionen, die Fastify selbst verwendet – außer wenn das
Plugin mit [fastify-plugin](https://github.com/fastify/fastify-plugin) umhüllt
wurde. Dieses Options-Objekt wird beim Aufruf zusätzlich an das Plugin
übergeben, unabhängig davon, ob das Plugin umhüllt wurde oder nicht. Die aktuell
unterstützte Liste Fastify-spezifischer Optionen lautet:

+ [`logLevel`](./Routes.md#custom-log-level)
+ [`logSerializers`](./Routes.md#custom-log-serializer)
+ [`prefix`](#route-prefixing-option)

Diese Optionen werden ignoriert, wenn sie zusammen mit fastify-plugin verwendet
werden.

Um Kollisionen zu vermeiden, sollte ein Plugin seine Optionen in einen eigenen
Namensraum legen. Ein Plugin `foo` könnte zum Beispiel so registriert werden:

```js
fastify.register(require('fastify-foo'), {
  prefix: '/foo',
  foo: {
    fooOption1: 'value',
    fooOption2: 'value'
  }
})
```

Wenn Kollisionen kein Thema sind, kann das Plugin das Options-Objekt unverändert
entgegennehmen:

```js
fastify.register(require('fastify-foo'), {
  prefix: '/foo',
  fooOption1: 'value',
  fooOption2: 'value'
})
```

Der Parameter `options` kann auch eine `Function` sein, die bei der Registrierung
des Plugins ausgewertet wird und über das erste Argument Zugriff auf die
Fastify-Instanz bietet:

```js
const fp = require('fastify-plugin')

fastify.register(fp((fastify, opts, done) => {
  fastify.decorate('foo_bar', { hello: 'world' })

  done()
}))

// The opts argument of fastify-foo will be { hello: 'world' }
fastify.register(require('fastify-foo'), parent => parent.foo_bar)
```

Die an die Funktion übergebene Fastify-Instanz ist der aktuellste Stand der
**externen Fastify-Instanz**, auf der das Plugin deklariert wurde. Dadurch kann
auf Variablen zugegriffen werden, die vorangegangene Plugins per
[`decorate`](./Decorators.md) gemäß der **Registrierungsreihenfolge** eingefügt
haben. Das ist nützlich, wenn ein Plugin von Änderungen abhängt, die ein
vorangegangenes Plugin an der Fastify-Instanz vorgenommen hat, etwa bei der
Nutzung einer bestehenden Datenbankverbindung.

Beachten Sie, dass die an die Funktion übergebene Fastify-Instanz dieselbe ist,
die auch in das Plugin übergeben wird – eine Kopie der externen Fastify-Instanz
und keine Referenz. Jede Verwendung dieser Instanz verhält sich genauso, als
würde sie innerhalb der Plugin-Funktion aufgerufen. Wird zum Beispiel `decorate`
aufgerufen, sind die dekorierten Variablen innerhalb der Plugin-Funktion
verfügbar, sofern sie nicht mit
[`fastify-plugin`](https://github.com/fastify/fastify-plugin) umhüllt wurde.

#### Option Route-Prefixing
<a id="route-prefixing-option"></a>

Wird eine Option mit dem Schlüssel `prefix` und einem `string`-Wert übergeben,
verwendet Fastify sie als Präfix für alle Routes innerhalb des Registers. Mehr
Informationen finden Sie [hier](./Routes.md#route-prefixing).

Beachten Sie, dass diese Option nicht funktioniert, wenn Routes mit
[`fastify-plugin`](https://github.com/fastify/fastify-plugin) umhüllt sind (siehe
den [Workaround](./Routes.md#fastify-plugin)).

#### Fehlerbehandlung
<a id="error-handling"></a>

Die Fehlerbehandlung übernimmt [avvio](https://github.com/mcollina/avvio#error-handling).

Als Faustregel gilt: Behandeln Sie Fehler im nächsten `after`- oder
`ready`-Block, andernfalls werden sie im `listen`-Callback abgefangen.

```js
fastify.register(require('my-plugin'))

// `after` will be executed once
// the previous declared `register` has finished
fastify.after(err => console.log(err))

// `ready` will be executed once all the registers declared
// have finished their execution
fastify.ready(err => console.log(err))

// `listen` is a special ready,
// so it behaves in the same way
fastify.listen({ port: 3000 }, (err, address) => {
  if (err) console.log(err)
})
```

### async/await
<a id="async-await"></a>

*async/await* wird von `after`, `ready` und `listen` unterstützt; außerdem ist
`fastify` ein Thenable.

```js
await fastify.register(require('my-plugin'))

await fastify.after()

await fastify.ready()

await fastify.listen({ port: 3000 })
```
Die Verwendung von `await` beim Registrieren eines Plugins lädt das Plugin und
seine Abhängigkeiten und "finalisiert" damit den Kapselungsprozess. Jegliche
Mutationen am Plugin, nachdem es und seine Abhängigkeiten geladen wurden, wirken
sich nicht mehr auf die übergeordnete Instanz aus.

#### ESM-Unterstützung
<a id="esm-support"></a>

ESM wird ab [Node.js `v13.3.0`](https://nodejs.org/api/esm.html) unterstützt.

```js
// main.mjs
import Fastify from 'fastify'
const fastify = Fastify()

fastify.register(import('./plugin.mjs'))

fastify.listen({ port: 3000 }, console.log)


// plugin.mjs
async function plugin (fastify, opts) {
  fastify.get('/', async (req, reply) => {
    return { hello: 'world' }
  })
}

export default plugin
```

### Ein Plugin erstellen
<a id="create-plugin"></a>

Ein Plugin zu erstellen ist einfach. Erstellen Sie eine Funktion, die drei
Parameter entgegennimmt: die `fastify`-Instanz, ein `options`-Objekt und den
`done`-Callback. Alternativ verwenden Sie eine `async`-Funktion und lassen den
`done`-Callback weg.

Beispiel:
```js
module.exports = function callbackPlugin (fastify, opts, done) {
  fastify.decorate('utility', function () {})

  fastify.get('/', handler)

  done()
}

// Or using async
module.exports = async function asyncPlugin (fastify, opts) {
  fastify.decorate('utility', function () {})

  fastify.get('/', handler)
}
```

`register` kann auch innerhalb eines anderen `register` verwendet werden:
```js
module.exports = function (fastify, opts, done) {
  fastify.decorate('utility', function () {})

  fastify.get('/', handler)

  fastify.register(require('./other-plugin'))

  done()
}
```

Denken Sie daran: `register` erzeugt immer einen neuen Fastify-Scope. Wenn das
nicht gewünscht ist, lesen Sie den folgenden Abschnitt.

### Den Scope steuern
<a id="handle-scope"></a>

Wird `register` nur verwendet, um die Serverfunktionalität mit
[`decorate`](./Decorators.md) zu erweitern, sagen Sie Fastify, dass kein neuer
Scope erzeugt werden soll. Andernfalls sind die Änderungen im übergeordneten
Scope nicht zugänglich.

Es gibt zwei Möglichkeiten, das Erzeugen eines neuen Kontexts zu vermeiden:
- Das Modul [`fastify-plugin`](https://github.com/fastify/fastify-plugin) verwenden
- Die versteckte Eigenschaft `'skip-override'` verwenden

Die Verwendung des Moduls `fastify-plugin` wird empfohlen, da es dieses Problem
löst und es erlaubt, einen Versionsbereich von Fastify anzugeben, den das Plugin
unterstützt:
```js
const fp = require('fastify-plugin')

module.exports = fp(function (fastify, opts, done) {
  fastify.decorate('utility', function () {})
  done()
}, '0.x')
```
Lesen Sie die Dokumentation von
[`fastify-plugin`](https://github.com/fastify/fastify-plugin), um mehr über die
Verwendung dieses Moduls zu erfahren.

Wenn Sie `fastify-plugin` nicht verwenden, kann die versteckte Eigenschaft
`'skip-override'` eingesetzt werden, was jedoch nicht empfohlen wird. Künftige
Änderungen an der Fastify-API nachzuziehen liegt dann in Ihrer Verantwortung,
während `fastify-plugin` Abwärtskompatibilität sicherstellt.
```js
function yourPlugin (fastify, opts, done) {
  fastify.decorate('utility', function () {})
  done()
}
yourPlugin[Symbol.for('skip-override')] = true
module.exports = yourPlugin
```
