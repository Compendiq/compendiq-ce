# HMR-API

:::tip Hinweis
Dies ist die Client-HMR-API. Zur Behandlung von HMR-Updates in Plugins siehe [handleHotUpdate](./api-plugin#handlehotupdate).

Die manuelle HMR-API richtet sich in erster Linie an Framework- und Tooling-Autoren. Als Endanwender ist HMR in den framework-spezifischen Starter-Templates vermutlich bereits für dich erledigt.
:::

Vite stellt seine manuelle HMR-API über das spezielle Objekt `import.meta.hot` bereit:

```ts twoslash
import type { ModuleNamespace } from 'vite/types/hot.d.ts'
import type {
  CustomEventName,
  InferCustomEventPayload,
} from 'vite/types/customEvent.d.ts'

// ---cut---
interface ImportMeta {
  readonly hot?: ViteHotContext
}

interface ViteHotContext {
  readonly data: any

  accept(): void
  accept(cb: (mod: ModuleNamespace | undefined) => void): void
  accept(dep: string, cb: (mod: ModuleNamespace | undefined) => void): void
  accept(
    deps: readonly string[],
    cb: (mods: Array<ModuleNamespace | undefined>) => void,
  ): void

  dispose(cb: (data: any) => void): void
  prune(cb: (data: any) => void): void
  invalidate(message?: string): void

  on<T extends CustomEventName>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void
  off<T extends CustomEventName>(
    event: T,
    cb: (payload: InferCustomEventPayload<T>) => void,
  ): void
  send<T extends CustomEventName>(
    event: T,
    data?: InferCustomEventPayload<T>,
  ): void
}
```

## Erforderliche bedingte Absicherung

Achte zunächst darauf, jede Nutzung der HMR-API mit einem bedingten Block abzusichern, damit der Code in Produktion durch Tree-Shaking entfernt werden kann:

```js
if (import.meta.hot) {
  // HMR code
}
```

## IntelliSense für TypeScript

Vite stellt Typdefinitionen für `import.meta.hot` in [`vite/client.d.ts`](https://github.com/vitejs/vite/blob/main/packages/vite/client.d.ts) bereit. Du kannst "vite/client" in der `tsconfig.json` ergänzen, damit TypeScript die Typdefinitionen erkennt:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["vite/client"]
  }
}
```

## `hot.accept(cb)`

Damit sich ein Modul selbst akzeptiert, verwende `import.meta.hot.accept` mit einem Callback, der das aktualisierte Modul erhält:

```js twoslash
import 'vite/client'
// ---cut---
export const count = 1

if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    if (newModule) {
      // newModule is undefined when SyntaxError happened
      console.log('updated: count is now ', newModule.count)
    }
  })
}
```

Ein Modul, das Hot-Updates „akzeptiert“, gilt als **HMR-Grenze**.

```dot
digraph hmr_boundary {
  rankdir=RL
  ranksep=0.3
  node [shape=box style="rounded,filled" fontname="Arial" fontsize=11 margin="0.2,0.1" fontcolor="${#3c3c43|#ffffff}" color="${#c2c2c4|#3c3f44}"]
  edge [color="${#67676c|#98989f}" fontname="Arial" fontsize=10 fontcolor="${#67676c|#98989f}"]
  bgcolor="transparent"

  root [label="main.js" fillcolor="${#f6f6f7|#2e2e32}"]
  parent [label="App.vue" fillcolor="${#f6f6f7|#2e2e32}"]
  boundary [label="Component.vue\n(HMR boundary)\nhot.accept()" fillcolor="${#def5ed|#15312d}" color="${#18794e|#3dd68c}" penwidth=2]
  edited [label="utils.js\n(edited)" fillcolor="${#fcf4dc|#38301a}" color="${#915930|#f9b44e}" penwidth=2]

  boundary -> edited [label="imports" color="${#915930|#f9b44e}" style=bold]
  parent -> boundary [label="imports" style=dashed]
  root -> parent [label="imports" style=dashed]
}
```

Vites HMR tauscht das ursprünglich importierte Modul nicht tatsächlich aus: Wenn ein Modul an einer HMR-Grenze Imports aus einer Abhängigkeit re-exportiert, ist es dafür verantwortlich, diese Re-Exporte zu aktualisieren (und diese Exporte müssen `let` verwenden). Außerdem werden Importeure weiter oben in der Kette vom Grenzmodul aus nicht über die Änderung benachrichtigt. Diese vereinfachte HMR-Implementierung genügt für die meisten Dev-Anwendungsfälle und erlaubt es uns gleichzeitig, den teuren Aufwand für die Erzeugung von Proxy-Modulen zu vermeiden.

Vite verlangt, dass der Aufruf dieser Funktion im Quellcode als `import.meta.hot.accept(` erscheint (empfindlich gegenüber Leerzeichen), damit das Modul Updates akzeptiert. Das ist eine Anforderung der statischen Analyse, die Vite durchführt, um HMR-Unterstützung für ein Modul zu ermöglichen.

## `hot.accept(deps, cb)`

Ein Modul kann auch Updates von direkten Abhängigkeiten akzeptieren, ohne sich selbst neu zu laden:

```js twoslash
// @filename: /foo.d.ts
export declare const foo: () => void

// @filename: /example.js
import 'vite/client'
// ---cut---
import { foo } from './foo.js'

foo()

if (import.meta.hot) {
  import.meta.hot.accept('./foo.js', (newFoo) => {
    // the callback receives the updated './foo.js' module
    newFoo?.foo()
  })

  // Can also accept an array of dep modules:
  import.meta.hot.accept(
    ['./foo.js', './bar.js'],
    ([newFooModule, newBarModule]) => {
      // The callback receives an array where only the updated module is
      // non null. If the update was not successful (syntax error for ex.),
      // the array is empty
    },
  )
}
```

## `hot.dispose(cb)`

Ein sich selbst akzeptierendes Modul oder ein Modul, das erwartet, von anderen akzeptiert zu werden, kann `hot.dispose` verwenden, um dauerhafte Seiteneffekte aufzuräumen, die von seiner aktualisierten Kopie erzeugt wurden:

```js twoslash
import 'vite/client'
// ---cut---
function setupSideEffect() {}

setupSideEffect()

if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    // cleanup side effect
  })
}
```

## `hot.prune(cb)`

Registriert einen Callback, der aufgerufen wird, wenn das Modul auf der Seite nicht mehr importiert wird. Im Vergleich zu `hot.dispose` kann dies verwendet werden, wenn der Quellcode seine Seiteneffekte bei Updates selbst aufräumt und du nur aufräumen musst, wenn es von der Seite entfernt wird. Vite verwendet dies derzeit für `.css`-Importe.

```js twoslash
import 'vite/client'
// ---cut---
function setupOrReuseSideEffect() {}

setupOrReuseSideEffect()

if (import.meta.hot) {
  import.meta.hot.prune((data) => {
    // cleanup side effect
  })
}
```

## `hot.data`

Vite erzeugt ein `import.meta.hot.data`-Objekt pro Modulpfad. Das Objekt bleibt während HMR über aufeinanderfolgende Instanzen desselben Moduls hinweg erhalten. Mutationen, die während der Modulausführung oder über das an `hot.dispose` übergebene `data`-Argument vorgenommen werden, sind für die nächste Instanz des Moduls sichtbar.

Wird ein Modul entfernt (pruned), erhalten seine `hot.dispose`- und `hot.prune`-Callbacks das aktuelle Daten-Objekt. Vite löscht die Daten, nachdem diese Callbacks abgeschlossen sind. Wird das Modul später erneut importiert, erhält es ein neues, leeres Daten-Objekt.

Beachte, dass eine Neuzuweisung von `data` selbst nicht unterstützt wird. Stattdessen solltest du Eigenschaften des `data`-Objekts mutieren, damit von anderen Handlern hinzugefügte Informationen erhalten bleiben.

```js twoslash
import 'vite/client'
// ---cut---
// ok
import.meta.hot.data.someValue = 'hello'

// not supported
import.meta.hot.data = { someValue: 'hello' }
```

## `hot.decline()`

Dies ist derzeit ein No-op und existiert aus Gründen der Abwärtskompatibilität. Das könnte sich in Zukunft ändern, falls es eine neue Verwendung dafür gibt. Um anzuzeigen, dass ein Modul nicht hot-aktualisierbar ist, verwende `hot.invalidate()`.

## `hot.invalidate(message?: string)`

Ein sich selbst akzeptierendes Modul kann zur Laufzeit feststellen, dass es ein HMR-Update nicht verarbeiten kann, sodass das Update zwangsweise an die Importeure weitergegeben werden muss. Durch den Aufruf von `import.meta.hot.invalidate()` invalidiert der HMR-Server die Importeure des Aufrufers, so als hätte sich der Aufrufer nicht selbst akzeptiert. Dabei wird sowohl in der Browser-Konsole als auch im Terminal eine Meldung protokolliert. Du kannst eine Nachricht übergeben, um Kontext dazu zu geben, warum die Invalidierung erfolgt ist.

Beachte, dass du `import.meta.hot.accept` immer aufrufen solltest, selbst wenn du unmittelbar danach `invalidate` aufrufen willst, andernfalls hört der HMR-Client nicht auf künftige Änderungen am sich selbst akzeptierenden Modul. Um deine Absicht klar zu kommunizieren, empfehlen wir, `invalidate` innerhalb des `accept`-Callbacks aufzurufen, etwa so:

```js twoslash
import 'vite/client'
// ---cut---
import.meta.hot.accept((module) => {
  // You may use the new module instance to decide whether to invalidate.
  if (cannotHandleUpdate(module)) {
    import.meta.hot.invalidate()
  }
})
```

## `hot.on(event, cb)`

Auf ein HMR-Event hören.

Die folgenden HMR-Events werden von Vite automatisch ausgelöst:

- `'vite:beforeUpdate'` wenn ein Update gleich angewendet wird (z. B. ein Modul wird ersetzt)
- `'vite:afterUpdate'` wenn ein Update gerade angewendet wurde (z. B. ein Modul wurde ersetzt)
- `'vite:beforeFullReload'` wenn ein vollständiger Reload bevorsteht
- `'vite:beforePrune'` wenn nicht mehr benötigte Module gleich entfernt werden
- `'vite:invalidate'` wenn ein Modul mit `import.meta.hot.invalidate()` invalidiert wird
- `'vite:error'` wenn ein Fehler auftritt (z. B. Syntaxfehler)
- `'vite:ws:disconnect'` wenn die WebSocket-Verbindung verloren geht
- `'vite:ws:connect'` wenn die WebSocket-Verbindung (wieder-)hergestellt wird

Eigene HMR-Events können auch von Plugins gesendet werden. Weitere Details siehe [handleHotUpdate](./api-plugin#handlehotupdate).

## `hot.off(event, cb)`

Entfernt einen Callback aus den Event-Listenern.

## `hot.send(event, data)`

Sendet eigene Events zurück an Vites Dev-Server.

Wird dies vor dem Verbindungsaufbau aufgerufen, werden die Daten gepuffert und gesendet, sobald die Verbindung steht.

Weitere Details, darunter ein Abschnitt zur [Typisierung eigener Events](/guide/api-plugin.html#typescript-for-custom-events), findest du unter [Client-Server-Kommunikation](/guide/api-plugin.html#client-server-communication).

## Weiterführende Lektüre

Wenn du mehr darüber erfahren möchtest, wie die HMR-API verwendet wird und wie sie unter der Haube funktioniert, sieh dir diese Ressourcen an:

- [Hot Module Replacement is Easy](https://bjornlu.com/blog/hot-module-replacement-is-easy)
