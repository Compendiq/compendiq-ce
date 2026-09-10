<h1 align="center">Fastify</h1>

# Der Anhalter-Guide zu Plugins
Zuallererst: `DON'T PANIC`!

Fastify wurde von Anfang an als äußerst modulares System gebaut. Wir haben eine
mächtige API entwickelt, mit der Sie Fastify durch das Anlegen eines Namensraums
Methoden und Hilfsfunktionen hinzufügen können. Wir haben ein System gebaut, das
ein Kapselungsmodell erzeugt, welches es Ihnen erlaubt, Ihre Anwendung jederzeit
in mehrere Microservices aufzuteilen, ohne die gesamte Anwendung refaktorieren zu
müssen.

**Inhaltsverzeichnis**
- [Der Anhalter-Guide zu Plugins](#the-hitchhikers-guide-to-plugins)
  - [Register](#register)
  - [Decorators](#decorators)
  - [Hooks](#hooks)
  - [Umgang mit Kapselung und
    Verteilung](#how-to-handle-encapsulation-and-distribution)
  - [ESM-Unterstützung](#esm-support)
  - [Fehler behandeln](#handle-errors)
  - [Eigene Fehler](#custom-errors)
  - [Warnungen ausgeben](#emit-warnings)
  - [Los geht's!](#lets-start)

## Register
<a id="register"></a>

Wie in JavaScript, wo alles ein Objekt ist, ist in Fastify alles ein Plugin.

Ihre Routes, Ihre Hilfsfunktionen und so weiter sind alle Plugins. Um ein neues
Plugin hinzuzufügen – egal welche Funktionalität es hat –, haben Sie in Fastify
eine schöne, einheitliche API: [`register`](../Reference/Plugins.md).
```js
fastify.register(
  require('./my-plugin'),
  { options }
)
```
`register` erzeugt einen neuen Fastify-Kontext, das heißt: Wenn Sie Änderungen an
der Fastify-Instanz vornehmen, wirken sich diese Änderungen nicht auf die
Vorfahren des Kontexts aus. Mit anderen Worten: Kapselung!

*Warum ist Kapselung wichtig?*

Nun, sagen wir, Sie gründen ein neues, disruptives Startup – was tun Sie? Sie
bauen einen API-Server mit all Ihren Sachen, alles am selben Ort, ein Monolith!

Okay, Sie wachsen sehr schnell und wollen Ihre Architektur ändern und
Microservices ausprobieren. Üblicherweise bedeutet das eine gewaltige Menge
Arbeit, wegen gegenseitiger Abhängigkeiten und fehlender Trennung der
Zuständigkeiten in der Codebasis.

Fastify hilft Ihnen dabei. Dank des Kapselungsmodells vermeidet es gegenseitige
Abhängigkeiten vollständig und hilft Ihnen, Ihren Code in zusammenhängende
Blöcke zu strukturieren.

*Kommen wir zurück dazu, wie man `register` korrekt verwendet.*

Wie Sie wahrscheinlich wissen, müssen die eingebundenen Plugins eine einzelne
Funktion mit der folgenden Signatur bereitstellen
```js
module.exports = function (fastify, options, done) {}
```
Dabei ist `fastify` die gekapselte Fastify-Instanz, `options` das Options-Objekt
und `done` die Funktion, die Sie aufrufen **müssen**, wenn Ihr Plugin bereit ist.

Fastifys Plugin-Modell ist vollständig reentrant und graphenbasiert, es kommt
problemlos mit asynchronem Code zurecht und erzwingt sowohl die Lade- als auch
die Schließreihenfolge der Plugins. *Wie?* Gute Frage – schauen Sie sich
[`avvio`](https://github.com/mcollina/avvio) an! Fastify beginnt mit dem Laden
des Plugins __nach__ dem Aufruf von `.listen()`, `.inject()` oder `.ready()`.

Innerhalb eines Plugins können Sie tun, was Sie wollen: Routes und
Hilfsfunktionen registrieren (das sehen wir uns gleich an) und verschachtelte
Registrierungen vornehmen – denken Sie nur daran, `done` aufzurufen, wenn alles
eingerichtet ist!
```js
module.exports = function (fastify, options, done) {
  fastify.get('/plugin', (request, reply) => {
    reply.send({ hello: 'world' })
  })

  done()
}
```

Nun wissen Sie also, wie man die `register`-API verwendet und wie sie
funktioniert – aber wie fügen wir Fastify neue Funktionalität hinzu und, noch
besser, wie teilen wir sie mit anderen Entwicklern?

## Decorators
<a id="decorators"></a>

Okay, sagen wir, Sie haben eine Hilfsfunktion geschrieben, die so gut ist, dass
Sie sie zusammen mit Ihrem gesamten Code verfügbar machen wollen. Wie würden Sie
das tun? Wahrscheinlich in etwa so:
```js
// your-awesome-utility.js
module.exports = function (a, b) {
  return a + b
}
```
```js
const util = require('./your-awesome-utility')
console.log(util('that is ', 'awesome'))
```
Nun importieren Sie Ihre Hilfsfunktion in jede Datei, in der Sie sie brauchen.
(Und vergessen Sie nicht, dass Sie sie wahrscheinlich auch in Ihren Tests
brauchen.)

Fastify bietet Ihnen einen eleganteren und bequemeren Weg dafür: *Decorators*.
Einen Decorator zu erstellen ist äußerst einfach, verwenden Sie einfach die
[`decorate`](../Reference/Decorators.md)-API:
```js
fastify.decorate('util', (a, b) => a + b)
```
Nun können Sie auf Ihre Hilfsfunktion einfach über `fastify.util` zugreifen,
wann immer Sie sie brauchen – sogar innerhalb Ihrer Tests.

Und hier beginnt die Magie; erinnern Sie sich, wie wir gerade über Kapselung
gesprochen haben? Nun, `register` und `decorate` gemeinsam zu verwenden
ermöglicht genau das; lassen Sie mich das mit einem Beispiel verdeutlichen:
```js
fastify.register((instance, opts, done) => {
  instance.decorate('util', (a, b) => a + b)
  console.log(instance.util('that is ', 'awesome'))

  done()
})

fastify.register((instance, opts, done) => {
  console.log(instance.util('that is ', 'awesome')) // This will throw an error

  done()
})
```
Im zweiten `register`-Aufruf wirft `instance.util` einen Fehler, weil `util` nur
innerhalb des ersten Register-Kontexts existiert.

Treten wir einen Moment zurück und schauen genauer hin: Jedes Mal, wenn Sie die
`register`-API verwenden, wird ein neuer Kontext erzeugt, der die oben genannten
unerfreulichen Situationen vermeidet.

Beachten Sie, dass die Kapselung für Vorfahren und Geschwister gilt, aber nicht
für Kinder.
```js
fastify.register((instance, opts, done) => {
  instance.decorate('util', (a, b) => a + b)
  console.log(instance.util('that is ', 'awesome'))

  instance.register((instance, opts, done) => {
    console.log(instance.util('that is ', 'awesome')) // This will not throw an error
    done()
  })

  done()
})

fastify.register((instance, opts, done) => {
  console.log(instance.util('that is ', 'awesome')) // This will throw an error

  done()
})
```
*Merksatz: Wenn Sie eine Hilfsfunktion brauchen, die in jedem Teil Ihrer
Anwendung verfügbar ist, achten Sie darauf, dass sie im Root-Scope Ihrer
Anwendung deklariert wird. Wenn das keine Option ist, können Sie die
Hilfsbibliothek `fastify-plugin` verwenden, wie [hier](#distribution)
beschrieben.*

`decorate` ist nicht die einzige API, mit der Sie die Serverfunktionalität
erweitern können; Sie können auch `decorateRequest` und `decorateReply`
verwenden.

*`decorateRequest` und `decorateReply`? Warum brauchen wir die, wenn wir doch
schon `decorate` haben?*

Gute Frage; wir haben sie hinzugefügt, um Fastify entwicklerfreundlicher zu
machen. Sehen wir uns ein Beispiel an:
```js
fastify.decorate('html', payload => {
  return generateHtml(payload)
})

fastify.get('/html', (request, reply) => {
  reply
    .type('text/html')
    .send(fastify.html({ hello: 'world' }))
})
```
Es funktioniert, aber es könnte viel besser sein!
```js
fastify.decorateReply('html', function (payload) {
  this.type('text/html') // This is the 'Reply' object
  this.send(generateHtml(payload))
})

fastify.get('/html', (request, reply) => {
  reply.html({ hello: 'world' })
})
```
Zur Erinnerung: Das Schlüsselwort `this` steht in *Arrow Functions* nicht zur
Verfügung. Wenn Sie also Funktionen an *`decorateReply`* und
*`decorateRequest`* als Hilfsfunktion übergeben, die zugleich Zugriff auf die
`request`- und `reply`-Instanz braucht, ist eine mit dem Schlüsselwort
`function` definierte Funktion nötig statt eines *Arrow-Function-Ausdrucks*.

Dasselbe können Sie für das `request`-Objekt tun:
```js
fastify.decorate('getBoolHeader', (req, name) => {
  return req.headers[name] ?? false // We return `false` if header is missing
})

fastify.addHook('preHandler', (request, reply, done) => {
  request.isHappy = fastify.getBoolHeader(request, 'happy')
  done()
})

fastify.get('/happiness', (request, reply) => {
  reply.send({ happy: request.isHappy })
})
```
Auch das funktioniert, aber es geht viel besser!
```js
fastify.decorateRequest('setBoolHeader', function (name) {
  this.isHappy = this.headers[name] ?? false
})

fastify.decorateRequest('isHappy', false) // This will be added to the Request object prototype, yay speed!

fastify.addHook('preHandler', (request, reply, done) => {
  request.setBoolHeader('happy')
  done()
})

fastify.get('/happiness', (request, reply) => {
  reply.send({ happy: request.isHappy })
})
```

Wir haben gesehen, wie man die Serverfunktionalität erweitert und mit dem
Kapselungssystem umgeht – aber was, wenn Sie eine Funktion hinzufügen müssen,
die immer dann ausgeführt werden soll, wenn der Server ein Ereignis
"[aussendet](../Reference/Lifecycle.md)"?

## Hooks
<a id="hooks"></a>

Sie haben gerade eine großartige Hilfsfunktion gebaut, müssen sie aber nun für
jeden Request ausführen; das ist, was Sie wahrscheinlich tun würden:
```js
fastify.decorate('util', (request, key, value) => { request[key] = value })

fastify.get('/plugin1', (request, reply) => {
  fastify.util(request, 'timestamp', new Date())
  reply.send(request)
})

fastify.get('/plugin2', (request, reply) => {
  fastify.util(request, 'timestamp', new Date())
  reply.send(request)
})
```
Ich denke, wir sind uns alle einig, dass das schrecklich ist. Wiederholter Code,
furchtbare Lesbarkeit, und es skaliert nicht.

Was können Sie also tun, um dieses ärgerliche Problem zu vermeiden? Ja, genau,
einen [Hook](../Reference/Hooks.md) verwenden!

```js
fastify.decorate('util', (request, key, value) => { request[key] = value })

fastify.addHook('preHandler', (request, reply, done) => {
  fastify.util(request, 'timestamp', new Date())
  done()
})

fastify.get('/plugin1', (request, reply) => {
  reply.send(request)
})

fastify.get('/plugin2', (request, reply) => {
  reply.send(request)
})
```
Jetzt läuft Ihre Hilfsfunktion bei jedem Request. Sie können so viele Hooks
registrieren, wie Sie brauchen.

Manchmal wollen Sie einen Hook, der nur für eine Teilmenge der Routes ausgeführt
werden soll – wie geht das? Genau, Kapselung!

```js
fastify.register((instance, opts, done) => {
  instance.decorate('util', (request, key, value) => { request[key] = value })

  instance.addHook('preHandler', (request, reply, done) => {
    instance.util(request, 'timestamp', new Date())
    done()
  })

  instance.get('/plugin1', (request, reply) => {
    reply.send(request)
  })

  done()
})

fastify.get('/plugin2', (request, reply) => {
  reply.send(request)
})
```
Jetzt läuft Ihr Hook nur für die erste Route!

Ein alternativer Ansatz ist die Verwendung des
[onRoute-Hooks](../Reference/Hooks.md#onroute), um Anwendungs-Routes dynamisch
aus dem Plugin heraus anzupassen. Jedes Mal, wenn eine neue Route registriert
wird, können Sie die Route-Optionen lesen und verändern. Zum Beispiel auf Basis
einer [Route-Config-Option](../Reference/Routes.md#routes-options):

```js
fastify.register((instance, opts, done) => {
  instance.decorate('util', (request, key, value) => { request[key] = value })

  function handler(request, reply, done) {
    instance.util(request, 'timestamp', new Date())
    done()
  }

  instance.addHook('onRoute', (routeOptions) => {
    if (routeOptions.config && routeOptions.config.useUtil === true) {
      // set or add our handler to the route preHandler hook
      if (!routeOptions.preHandler) {
        routeOptions.preHandler = [handler]
        return
      }
      if (Array.isArray(routeOptions.preHandler)) {
        routeOptions.preHandler.push(handler)
        return
      }
      routeOptions.preHandler = [routeOptions.preHandler, handler]
    }
  })

  instance.get('/plugin1', {config: {useUtil: true}}, (request, reply) => {
    reply.send(request)
  })

  instance.get('/plugin2', (request, reply) => {
    reply.send(request)
  })

  done()
})
```

Diese Variante wird äußerst nützlich, wenn Sie vorhaben, Ihr Plugin zu
verteilen, wie im nächsten Abschnitt beschrieben.

Wie Sie inzwischen wahrscheinlich bemerkt haben, sind `request` und `reply`
nicht die üblichen Node.js-Objekte *request* und *response*, sondern Fastifys
eigene Objekte.


## Umgang mit Kapselung und Verteilung
<a id="distribution"></a>

Perfekt, jetzt kennen Sie (fast) alle Werkzeuge, die Sie zum Erweitern von
Fastify verwenden können. Dennoch sind Sie vermutlich über ein großes Problem
gestolpert: Wie wird die Verteilung gehandhabt?

Der bevorzugte Weg, eine Hilfsfunktion zu verteilen, ist, Ihren gesamten Code in
ein `register` einzupacken. Damit kann Ihr Plugin asynchrones Bootstrapping
unterstützen *(da `decorate` eine synchrone API ist)*, zum Beispiel im Fall einer
Datenbankverbindung.

*Moment, was? Haben Sie mir nicht gesagt, dass `register` eine Kapselung erzeugt
und dass die Dinge, die ich darin erstelle, außerhalb nicht verfügbar sind?*

Ja, das habe ich gesagt. Was ich Ihnen aber nicht gesagt habe: Sie können
Fastify mit dem Modul
[`fastify-plugin`](https://github.com/fastify/fastify-plugin) anweisen, dieses
Verhalten zu unterlassen.
```js
const fp = require('fastify-plugin')
const dbClient = require('db-client')

function dbPlugin (fastify, opts, done) {
  dbClient.connect(opts.url, (err, conn) => {
    fastify.decorate('db', conn)
    done()
  })
}

module.exports = fp(dbPlugin)
```
Sie können `fastify-plugin` auch anweisen, die installierte Fastify-Version zu
prüfen, falls Sie eine bestimmte API benötigen.

Wie wir bereits erwähnt haben, beginnt Fastify mit dem Laden seiner Plugins
__nach__ dem Aufruf von `.listen()`, `.inject()` oder `.ready()` und somit
__nach__ deren Deklaration. Das bedeutet: Auch wenn das Plugin über
[`decorate`](../Reference/Decorators.md) Variablen in die externe
Fastify-Instanz einfügen kann, sind die dekorierten Variablen vor dem Aufruf von
`.listen()`, `.inject()` oder `.ready()` nicht zugänglich.

Falls Sie auf eine von einem vorangegangenen Plugin eingefügte Variable
angewiesen sind und diese im `options`-Argument von `register` übergeben wollen,
können Sie das tun, indem Sie eine Funktion statt eines Objekts verwenden:
```js
const fastify = require('fastify')()
const fp = require('fastify-plugin')
const dbClient = require('db-client')

function dbPlugin (fastify, opts, done) {
  dbClient.connect(opts.url, (err, conn) => {
    fastify.decorate('db', conn)
    done()
  })
}

fastify.register(fp(dbPlugin), { url: 'https://fastify.example' })
fastify.register(require('your-plugin'), parent => {
  return { connection: parent.db, otherOption: 'foo-bar' }
})
```
Im obigen Beispiel ist die Variable `parent` der als zweites Argument von
`register` übergebenen Funktion eine Kopie der **externen Fastify-Instanz**, an
der das Plugin registriert wurde. Das bedeutet, dass wir auf alle Variablen
zugreifen können, die von vorangegangenen Plugins in der Reihenfolge der
Deklaration eingefügt wurden.

## ESM-Unterstützung
<a id="esm-support"></a>

ESM wird ebenfalls ab [Node.js
`v13.3.0`](https://nodejs.org/api/esm.html) unterstützt! Exportieren Sie Ihr
Plugin einfach als ESM-Modul, und schon kann es losgehen!

```js
// plugin.mjs
async function plugin (fastify, opts) {
  fastify.get('/', async (req, reply) => {
    return { hello: 'world' }
  })
}

export default plugin
```

## Fehler behandeln
<a id="handle-errors"></a>

Eines Ihrer Plugins kann beim Start fehlschlagen. Vielleicht rechnen Sie damit
und haben eine eigene Logik, die in diesem Fall ausgelöst wird. Wie setzen Sie
das um? Die `after`-API ist, was Sie brauchen. `after` registriert schlicht
einen Callback, der direkt nach einem `register` ausgeführt wird, und kann bis
zu drei Parameter entgegennehmen.

Der Callback ändert sich je nach den Parametern, die Sie angeben:

1. Wird dem Callback kein Parameter übergeben und tritt ein Fehler auf, wird
   dieser Fehler an den nächsten Error-Handler weitergereicht.
1. Wird dem Callback ein Parameter übergeben, ist dieser Parameter das
   Fehlerobjekt.
1. Werden dem Callback zwei Parameter übergeben, ist der erste das Fehlerobjekt
   und der zweite der done-Callback.
1. Werden dem Callback drei Parameter übergeben, ist der erste das Fehlerobjekt,
   der zweite der Top-Level-Kontext – es sei denn, Sie haben sowohl server als
   auch override angegeben, in diesem Fall ist der Kontext das, was das Override
   zurückgibt – und der dritte der done-Callback.

Sehen wir uns an, wie man es verwendet:
```js
fastify
  .register(require('./database-connector'))
  .after(err => {
    if (err) throw err
  })
```

## Eigene Fehler
<a id="custom-errors"></a>

Wenn Ihr Plugin eigene Fehler bereitstellen muss, können Sie mit dem Modul
[`@fastify/error`](https://github.com/fastify/fastify-error) mühelos
einheitliche Fehlerobjekte über Ihre Codebasis und Plugins hinweg erzeugen.

```js
const createError = require('@fastify/error')
const CustomError = createError('ERROR_CODE', 'message')
console.log(new CustomError())
```

## Warnungen ausgeben
<a id="emit-warnings"></a>

Wenn Sie eine API als veraltet kennzeichnen oder den Anwender vor einem
bestimmten Anwendungsfall warnen wollen, können Sie das Modul
[`process-warning`](https://github.com/fastify/process-warning) verwenden.

```js
const warning = require('process-warning')()
warning.create('MyPluginWarning', 'MP_ERROR_CODE', 'message')
warning.emit('MP_ERROR_CODE')
```

## Los geht's!
<a id="start"></a>

Großartig, jetzt wissen Sie alles, was Sie über Fastify und sein Plugin-System
wissen müssen, um Ihr erstes Plugin zu bauen – und wenn Sie eines bauen, sagen
Sie uns bitte Bescheid! Wir fügen es dem Abschnitt
[*Ökosystem*](https://github.com/fastify/fastify#ecosystem) unserer
Dokumentation hinzu!

Wenn Sie einige Beispiele aus der Praxis sehen möchten, schauen Sie sich das an:
- [`@fastify/view`](https://github.com/fastify/point-of-view) Plugin-Unterstützung
  für Template-Rendering (*ejs, pug, handlebars*) in Fastify.
- [`@fastify/mongodb`](https://github.com/fastify/fastify-mongodb) Fastify-Plugin
  für MongoDB-Verbindungen; damit können Sie denselben MongoDB-Connection-Pool in
  jedem Teil Ihres Servers verwenden.
- [`@fastify/multipart`](https://github.com/fastify/fastify-multipart)
  Multipart-Unterstützung für Fastify
- [`@fastify/helmet`](https://github.com/fastify/fastify-helmet) Wichtige
  Security-Header für Fastify


*Haben Sie das Gefühl, dass hier etwas fehlt? Sagen Sie es uns! :)*
