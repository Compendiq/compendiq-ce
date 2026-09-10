# Module mocken

## Ein Modul definieren

Bevor wir ein „Modul“ mocken, sollten wir definieren, was das ist. Im Kontext von Vitest ist ein „Modul“ eine Datei, die etwas exportiert. Mit [Plugins](https://vite.dev/guide/api-plugin.html) lässt sich jede Datei in ein JavaScript-Modul verwandeln. Das „Modulobjekt“ ist ein Namespace-Objekt, das dynamische Referenzen auf exportierte Bezeichner hält. Vereinfacht gesagt ist es ein Objekt mit den exportierten Methoden und Eigenschaften. In diesem Beispiel ist `example.js` ein Modul, das `answer` und `variable` exportiert:

```js [example.js]
export function answer() {
  // ...
  return 42
}

export const variable = 'example'
```

`exampleObject` ist hier ein Modulobjekt:

```js [example.test.js]
import * as exampleObject from './example.js'
```

`exampleObject` existiert immer, selbst wenn Sie das Beispiel über benannte Imports importiert haben:

```js [example.test.js]
import { answer, variable } from './example.js'
```

Sie können `exampleObject` nur außerhalb des Beispielmoduls selbst referenzieren, etwa in einem Test.

## Ein Modul mocken

Führen wir für diesen Leitfaden ein paar Definitionen ein.

- Ein **gemocktes Modul** ist ein Modul, das vollständig durch ein anderes ersetzt wurde.
- Ein **bespitzeltes Modul** (Spied Module) ist ein gemocktes Modul, dessen exportierte Methoden aber die ursprüngliche Implementierung behalten. Sie lassen sich zusätzlich nachverfolgen.
- Ein **gemockter Export** ist ein Modulexport, dessen Aufrufe nachverfolgt werden können.
- Ein **bespitzelter Export** ist ein gemockter Export.

Um ein Modul vollständig zu mocken, können Sie die [`vi.mock`-API](/api/vi#vi-mock) verwenden. Sie können ein neues Modul dynamisch definieren, indem Sie als zweites Argument eine Factory übergeben, die ein neues Modul zurückgibt:

```ts
import { vi } from 'vitest'

// The ./example.js module will be replaced with
// the result of a factory function, and the
// original ./example.js module will never be called
vi.mock(import('./example.js'), () => {
  return {
    answer() {
      // ...
      return 42
    },
    variable: 'mock',
  }
})
```

::: tip
Denken Sie daran, dass Sie `vi.mock` in einer [Setup-Datei](/config/setupfiles) aufrufen können, um den Modul-Mock automatisch in jeder Testdatei anzuwenden.
:::

::: tip
Beachten Sie die Verwendung des dynamischen Imports: `import('./example.ts')`. Vitest entfernt ihn, bevor der Code ausgeführt wird, aber er erlaubt TypeScript, den String korrekt zu validieren und die Methode `importOriginal` in Ihrer IDE oder CLI zu typisieren.
:::

Versucht Ihr Code, auf eine Methode zuzugreifen, die diese Factory nicht zurückgegeben hat, wirft Vitest einen Fehler mit einer hilfreichen Meldung. Beachten Sie, dass `answer` nicht gemockt ist, d. h. es kann nicht nachverfolgt werden. Um es nachverfolgbar zu machen, verwenden Sie stattdessen `vi.fn()`:

```ts
import { vi } from 'vitest'

vi.mock(import('./example.js'), () => {
  return {
    answer: vi.fn(),
    variable: 'mock',
  }
})
```

Die Factory-Methode nimmt eine Funktion `importOriginal` entgegen, die das ursprüngliche Modul ausführt und dessen Modulobjekt zurückgibt:

```ts
import { expect, vi } from 'vitest'
import { answer } from './example.js'

vi.mock(import('./example.js'), async (importOriginal) => {
  const originalModule = await importOriginal()
  return {
    answer: vi.fn(originalModule.answer),
    variable: 'mock',
  }
})

expect(answer()).toBe(42)

expect(answer).toHaveBeenCalled()
expect(answer).toHaveReturned(42)
```

::: warning
Beachten Sie, dass `importOriginal` asynchron ist und mit `await` abgewartet werden muss.
:::

Im obigen Beispiel haben wir das ursprüngliche `answer` an den `vi.fn()`-Aufruf übergeben, damit es weiterhin aufgerufen und gleichzeitig nachverfolgt werden kann.

Wenn Sie `importOriginal` brauchen, ziehen Sie in Betracht, den Export direkt über eine andere API zu bespitzeln: `vi.spyOn`. Statt das ganze Modul zu ersetzen, können Sie nur eine einzelne exportierte Methode bespitzeln. Dazu müssen Sie das Modul als Namespace-Objekt importieren:

```ts
import { expect, vi } from 'vitest'
import * as exampleObject from './example.js'

const spy = vi.spyOn(exampleObject, 'answer').mockReturnValue(0)

expect(exampleObject.answer()).toBe(0)
expect(exampleObject.answer).toHaveBeenCalled()
```

::: danger Unterstützung im Browser-Modus
Das funktioniert im [Browser-Modus](/guide/browser/) nicht, weil dort die native ESM-Unterstützung des Browsers zum Ausliefern der Module genutzt wird. Das Modul-Namespace-Objekt ist versiegelt und lässt sich nicht neu konfigurieren. Um diese Einschränkung zu umgehen, unterstützt Vitest die Option `{ spy: true }` in `vi.mock('./example.js')`. Damit wird automatisch jeder Export des Moduls bespitzelt, ohne ihn durch eine Attrappe zu ersetzen.

```ts
import { vi } from 'vitest'
import * as exampleObject from './example.js'

vi.mock('./example.js', { spy: true })

vi.mocked(exampleObject.answer).mockReturnValue(0)
```
:::

::: warning
Sie müssen das Modul nur in der Datei als Namespace-Objekt importieren, in der Sie das Hilfsmittel `vi.spyOn` verwenden. Wird `answer` in einer anderen Datei aufgerufen und dort als benannter Export importiert, kann Vitest es korrekt nachverfolgen, solange die aufrufende Funktion nach `vi.spyOn` aufgerufen wird:

```ts [source.js]
import { answer } from './example.js'

export function question() {
  if (answer() === 42) {
    return 'Ultimate Question of Life, the Universe, and Everything'
  }

  return 'Unknown Question'
}
```
:::

Beachten Sie, dass `vi.spyOn` nur Aufrufe bespitzelt, die nach dem Bespitzeln der Methode erfolgt sind. Wird die Funktion also beim Import auf oberster Ebene ausgeführt oder wurde sie vor dem Bespitzeln aufgerufen, kann `vi.spyOn` darüber nicht berichten.

Um ein beliebiges Modul automatisch zu mocken, bevor es importiert wird, können Sie `vi.mock` mit einem Pfad aufrufen:

```ts
import { vi } from 'vitest'

vi.mock(import('./example.js'))
```

Existiert die Datei `./__mocks__/example.js`, lädt Vitest stattdessen diese. Andernfalls lädt Vitest das ursprüngliche Modul und ersetzt rekursiv alles:

{#automocking-algorithm}

- Alle Arrays sind leer
- Alle primitiven Werte bleiben unverändert
- Alle Getter geben `undefined` zurück
- Alle Methoden geben `undefined` zurück
- Alle Objekte werden tief geklont
- Alle Instanzen von Klassen und ihre Prototypen werden geklont

Um dieses Verhalten zu deaktivieren, können Sie als zweites Argument `spy: true` übergeben:

```ts
import { vi } from 'vitest'

vi.mock(import('./example.js'), { spy: true })
```

Statt `undefined` zurückzugeben, rufen alle Methoden die ursprüngliche Implementierung auf, aber Sie können diese Aufrufe weiterhin nachverfolgen:

```ts
import { expect, vi } from 'vitest'
import { answer } from './example.js'

vi.mock(import('./example.js'), { spy: true })

// calls the original implementation
expect(answer()).toBe(42)
// vitest can still track the invocations
expect(answer).toHaveBeenCalled()
```

Eine schöne Eigenschaft gemockter Module ist, dass sie den Zustand zwischen der Instanz und ihrem Prototyp teilen. Betrachten Sie dieses Modul:

```ts [answer.js]
export class Answer {
  constructor(value) {
    this._value = value
  }

  value() {
    return this._value
  }
}
```

Indem wir es mocken, können wir jeden Aufruf von `.value()` nachverfolgen, sogar ohne Zugriff auf die Instanz selbst zu haben:

```ts [answer.test.js]
import { expect, test, vi } from 'vitest'
import { Answer } from './answer.js'

vi.mock(import('./answer.js'), { spy: true })

test('instance inherits the state', () => {
  // these invocations could be private inside another function
  // that you don't have access to in your test
  const answer1 = new Answer(42)
  const answer2 = new Answer(0)

  expect(answer1.value()).toBe(42)
  expect(answer1.value).toHaveBeenCalled()
  // note that different instances have their own states
  expect(answer2.value).not.toHaveBeenCalled()

  expect(answer2.value()).toBe(0)

  // but the prototype state accumulates all calls
  expect(Answer.prototype.value).toHaveBeenCalledTimes(2)
  expect(Answer.prototype.value).toHaveReturned(42)
  expect(Answer.prototype.value).toHaveReturned(0)
})
```

Das kann sehr nützlich sein, um Aufrufe an Instanzen nachzuverfolgen, die nie nach außen gegeben werden.

## Ein nicht existierendes Modul mocken

Vitest unterstützt das Mocken virtueller Module. Diese Module existieren nicht im Dateisystem, Ihr Code importiert sie aber. Das kann etwa vorkommen, wenn sich Ihre Entwicklungsumgebung von der Produktion unterscheidet. Ein häufiges Beispiel ist das Mocken von `vscode`-APIs in Ihren Unit-Tests.

Standardmäßig schlägt Vitest beim Transformieren von Dateien fehl, wenn es die Quelle des Imports nicht finden kann. Um das zu umgehen, müssen Sie es in Ihrer Konfiguration angeben. Sie können den Import entweder immer auf eine Datei umleiten oder Vite lediglich signalisieren, ihn zu ignorieren, und die `vi.mock`-Factory nutzen, um seine Exporte zu definieren.

Um den Import umzuleiten, verwenden Sie die Konfigurationsoption [`test.alias`](/config/alias):

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    alias: {
      vscode: resolve(import.meta.dirname, './mock/vscode.js'),
    },
  },
})
```

Um das Modul als stets auflösbar zu markieren, geben Sie im `resolveId`-Hook eines Plugins denselben String zurück:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [
    {
      name: 'virtual-vscode',
      resolveId(id) {
        if (id === 'vscode') {
          return 'vscode'
        }
      }
    }
  ]
})
```

Nun können Sie `vi.mock` in Ihren Tests wie gewohnt verwenden:

```ts
import { vi } from 'vitest'

vi.mock(import('vscode'), () => {
  return {
    window: {
      createOutputChannel: vi.fn(),
    }
  }
})
```

## Wie es funktioniert

Vitest implementiert je nach Umgebung unterschiedliche Mechanismen zum Mocken von Modulen. Das Einzige, was sie gemeinsam haben, ist der Plugin-Transformer. Erkennt Vitest, dass eine Datei ein `vi.mock` enthält, wandelt es jeden statischen Import in einen dynamischen um und verschiebt den `vi.mock`-Aufruf an den Anfang der Datei. Dadurch kann Vitest den Mock registrieren, bevor der Import stattfindet, ohne die ESM-Regel des Import-Hoistings zu verletzen.

::: code-group
```ts [example.js]
import { answer } from './answer.js'

vi.mock(import('./answer.js'))

console.log(answer)
```
```ts [example.transformed.js]
vi.mock('./answer.js')

const __vitest_module_0__ = await __handle_mock__(
  () => import('./answer.js')
)
// to keep the live binding, we have to access
// the export on the module namespace
console.log(__vitest_module_0__.answer())
```
:::

Der Wrapper `__handle_mock__` stellt lediglich sicher, dass der Mock aufgelöst ist, bevor der Import angestoßen wird; er verändert das Modul in keiner Weise.

Die Plugins zum Mocken von Modulen finden Sie im [Paket `@vitest/mocker`](https://github.com/vitest-dev/vitest/tree/main/packages/mocker).

### JSDOM, happy-dom, Node

Wenn Sie Ihre Tests in einer emulierten Umgebung ausführen, erzeugt Vitest einen [Module Runner](https://vite.dev/guide/api-environment-runtimes.html#modulerunner), der Vite-Code konsumieren kann. Der Module Runner ist so entworfen, dass Vitest sich in die Modulauswertung einklinken und sie durch den Mock ersetzen kann, sofern einer registriert wurde. Das bedeutet, dass Vitest Ihren Code in einer ESM-ähnlichen Umgebung ausführt, den nativen ESM-Mechanismus aber nicht direkt nutzt. Dadurch kann der Test-Runner die Regeln zur Unveränderlichkeit von ES-Modulen beugen, sodass Nutzer `vi.spyOn` auf einem scheinbaren ES-Modul aufrufen können.

Ist der Module Runner [deaktiviert](/config/experimental#experimental-vitemodulerunner) und der [Node-Loader](/config/experimental#experimental-nodeloader) nicht explizit deaktiviert, registriert Vitest einen [Loader-Hook](https://nodejs.org/api/module.html#customization-hooks), der ursprüngliche Module in gemockte umwandelt. In diesem Modus können Nutzer `vi.spyOn` nicht auf einem ES-Modul aufrufen, weil Vitest einen nativen Loader-Mechanismus mit all seinen Leitplanken verwendet. Zusätzlich muss Vitest in jedes gemockte Modul eine `mock`-Query injizieren, die im Stacktrace sichtbar ist.

### Browser-Modus

Im Browser-Modus verwendet Vitest natives ESM. Das bedeutet, dass wir das Modul nicht so einfach ersetzen können. Stattdessen fängt Vitest die Fetch-Anfrage ab (über Playwrights `page.route` oder eine Vite-Plugin-API bei `preview` oder `webdriverio`) und liefert transformierten Code aus, wenn das Modul gemockt wurde.

Wird das Modul beispielsweise automatisch gemockt, kann Vitest die statischen Exporte parsen und ein Platzhaltermodul erzeugen:

::: code-group
```ts [answer.js]
export function answer() {
  return 42
}
```
```ts [answer.transformed.js]
function answer() {
  return 42
}

const __private_module__ = {
  [Symbol.toStringTag]: 'Module',
  answer: vi.fn(answer),
}

export const answer = __private_module__.answer
```
:::

Das Beispiel ist der Kürze halber vereinfacht, das Konzept bleibt aber gleich. Wir können eine Variable `__private_module__` in das Modul injizieren, um die gemockten Werte zu halten. Hat der Nutzer `vi.mock` mit `spy: true` aufgerufen, reichen wir den ursprünglichen Wert durch; andernfalls erzeugen wir einen einfachen `vi.fn()`-Mock.

Hat der Nutzer eine eigene Factory definiert, wird das Injizieren des Codes schwieriger, aber nicht unmöglich. Wird die gemockte Datei ausgeliefert, lösen wir die Factory zunächst im Browser auf, geben die Schlüssel dann an den Server zurück und erzeugen damit ein Platzhaltermodul:

```ts
const resolvedFactoryKeys = await resolveBrowserFactory(url)
const mockedModule = `
const __private_module__ = getFactoryReturnValue(${url})
${resolvedFactoryKeys.map(key => `export const ${key} = __private_module__["${key}"]`).join('\n')}
`
```

Dieses Modul kann nun an den Browser zurückgeliefert werden. Sie können den Code beim Ausführen der Tests in den Devtools inspizieren.

## Fallstricke beim Mocken von Modulen

Beachten Sie, dass es nicht möglich ist, Aufrufe von Methoden zu mocken, die innerhalb anderer Methoden derselben Datei aufgerufen werden. In diesem Code etwa:

```ts [foobar.js]
export function foo() {
  return 'foo'
}

export function foobar() {
  return `${foo()}bar`
}
```

lässt sich die Methode `foo` von außen nicht mocken, weil sie direkt referenziert wird. Dieser Code hat also keine Wirkung auf den `foo`-Aufruf innerhalb von `foobar` (wohl aber auf den `foo`-Aufruf in anderen Modulen):

```ts [foobar.test.ts]
import { vi } from 'vitest'
import * as mod from './foobar.js'

// this will only affect "foo" outside of the original module
vi.spyOn(mod, 'foo')
vi.mock(import('./foobar.js'), async (importOriginal) => {
  return {
    ...await importOriginal(),
    // this will only affect "foo" outside of the original module
    foo: () => 'mocked'
  }
})
```

Sie können dieses Verhalten bestätigen, indem Sie die Implementierung direkt an die Methode `foobar` übergeben:

```ts [foobar.test.js]
import * as mod from './foobar.js'

vi.spyOn(mod, 'foo')

// exported foo references mocked method
mod.foobar(mod.foo)
```

```ts [foobar.js]
export function foo() {
  return 'foo'
}

export function foobar(injectedFoo) {
  return injectedFoo === foo // false
}
```

Das ist das beabsichtigte Verhalten, und wir planen nicht, einen Workaround zu implementieren. Ziehen Sie in Betracht, Ihren Code in mehrere Dateien aufzuteilen, oder nutzen Sie Techniken wie [Dependency Injection](https://en.wikipedia.org/wiki/Dependency_injection). Wir sind der Ansicht, dass es nicht Aufgabe des Test-Runners ist, die Anwendung testbar zu machen, sondern Aufgabe der Anwendungsarchitektur.
