# Vi

Vitest stellt über seinen `vi`-Helfer Hilfsfunktionen bereit, die Ihnen die Arbeit erleichtern. Sie können global darauf zugreifen (wenn die [globals-Konfiguration](/config/globals) aktiviert ist) oder ihn direkt aus `vitest` importieren:

```js
import { vi } from 'vitest'
```

## Module mocken

Dieser Abschnitt beschreibt die API, die Sie beim [Mocken eines Moduls](/guide/mocking/modules) verwenden können. Beachten Sie, dass Vitest das Mocken von Modulen, die per `require()` importiert wurden, nicht unterstützt.

### vi.mock

```ts
interface MockOptions {
  spy?: boolean
}

interface MockFactory<T> {
  (importOriginal: () => T): unknown
}

function mock(
  path: string,
  factory?: MockOptions | MockFactory<unknown>
): void
function mock<T>(
  module: Promise<T>,
  factory?: MockOptions | MockFactory<T>
): void
```

Ersetzt alle importierten Module aus dem angegebenen `path` durch ein anderes Modul. Sie können innerhalb eines Pfades konfigurierte Vite-Aliase verwenden. Der Aufruf von `vi.mock` wird gehoistet, es spielt also keine Rolle, wo Sie ihn schreiben. Er wird immer vor allen Importen ausgeführt. Wenn Sie Variablen außerhalb seines Scopes referenzieren müssen, können Sie sie innerhalb von [`vi.hoisted`](#vi-hoisted) definieren und in `vi.mock` referenzieren.

Es wird empfohlen, `vi.mock` bzw. `vi.hoisted` nur innerhalb von Testdateien zu verwenden. Ist Vites [Module Runner](/config/experimental#experimental-vitemodulerunner) deaktiviert, werden sie nicht gehoistet. Das ist eine Performance-Optimierung, um das Einlesen unnötiger Dateien zu vermeiden.

::: warning
`vi.mock` funktioniert nur für Module, die mit dem Schlüsselwort `import` importiert wurden. Mit `require` funktioniert es nicht.

Um `vi.mock` hoisten zu können, analysiert Vitest Ihre Dateien statisch. Das bedeutet, dass ein `vi`, das nicht direkt aus dem Paket `vitest` importiert wurde (zum Beispiel aus einer Hilfsdatei), nicht verwendet werden kann. Verwenden Sie `vi.mock` mit einem aus `vitest` importierten `vi` oder aktivieren Sie die Konfigurationsoption [`globals`](/config/globals).

Vitest mockt keine Module, die innerhalb einer [Setup-Datei](/config/setupfiles) importiert wurden, weil sie zu dem Zeitpunkt, zu dem eine Testdatei läuft, bereits gecacht sind. Sie können [`vi.resetModules()`](#vi-resetmodules) innerhalb von [`vi.hoisted`](#vi-hoisted) aufrufen, um alle Modul-Caches zu leeren, bevor eine Testdatei läuft.
:::

Ist die Funktion `factory` definiert, geben alle Importe deren Ergebnis zurück. Vitest ruft die Factory nur einmal auf und cacht die Ergebnisse für alle nachfolgenden Importe, bis [`vi.unmock`](#vi-unmock) oder [`vi.doUnmock`](#vi-dounmock) aufgerufen wird.

Anders als in `jest` kann die Factory asynchron sein. Sie können [`vi.importActual`](#vi-importactual) oder einen Helfer verwenden, der der Factory als erstes Argument übergeben wird, und so das ursprüngliche Modul darin erhalten.

Sie können statt einer Factory-Funktion auch ein Objekt mit einer `spy`-Eigenschaft übergeben. Ist `spy` gleich `true`, automockt Vitest das Modul wie gewohnt, überschreibt aber die Implementierung der Exporte nicht. Das ist nützlich, wenn Sie nur prüfen wollen, dass die exportierte Methode von einer anderen Methode korrekt aufgerufen wurde.

```ts
import { calculator } from './src/calculator.ts'

vi.mock('./src/calculator.ts', { spy: true })

// calls the original implementation,
// but allows asserting the behaviour later
const result = calculator(1, 2)

expect(result).toBe(3)
expect(calculator).toHaveBeenCalledWith(1, 2)
expect(calculator).toHaveReturnedWith(3)
```

Vitest unterstützt in den Methoden `vi.mock` und `vi.doMock` für bessere IDE-Unterstützung auch ein Modul-Promise anstelle einer Zeichenkette. Wird die Datei verschoben, wird der Pfad aktualisiert, und `importOriginal` erbt den Typ automatisch. Diese Signatur erzwingt außerdem, dass der Rückgabetyp der Factory mit dem ursprünglichen Modul kompatibel ist (wobei Exporte optional bleiben).

```ts twoslash
// @filename: ./path/to/module.js
export declare function total(...numbers: number[]): number
// @filename: test.js
import { vi } from 'vitest'
// ---cut---
vi.mock(import('./path/to/module.js'), async (importOriginal) => {
  const mod = await importOriginal() // type is inferred
  //    ^?
  return {
    ...mod,
    // replace some exports
    total: vi.fn(),
  }
})
```

Unter der Haube arbeitet Vitest weiterhin mit einer Zeichenkette und nicht mit einem Modulobjekt.

Wenn Sie jedoch TypeScript mit in `tsconfig.json` konfigurierten `paths`-Aliasen verwenden, kann der Compiler die Importtypen nicht korrekt auflösen.
Damit es funktioniert, ersetzen Sie alle aliasierten Importe durch die entsprechenden relativen Pfade.
Verwenden Sie z. B. `import('./path/to/module.js')` statt `import('@/module')`.

::: warning
`vi.mock` wird an den **Anfang der Datei** gehoistet (mit anderen Worten: _verschoben_). Das bedeutet: Wo immer Sie es schreiben (ob innerhalb von `beforeEach` oder `test`), es wird tatsächlich davor aufgerufen.

Das bedeutet außerdem, dass Sie innerhalb der Factory keine Variablen verwenden können, die außerhalb der Factory definiert sind.

Wenn Sie Variablen innerhalb der Factory brauchen, versuchen Sie es mit [`vi.doMock`](#vi-domock). Es funktioniert genauso, wird aber nicht gehoistet. Beachten Sie, dass es nur nachfolgende Importe mockt.

Sie können auch Variablen referenzieren, die per Methode `vi.hoisted` definiert wurden, sofern diese vor `vi.mock` deklariert wurde:

```ts
import { namedExport } from './path/to/module.js'

const mocks = vi.hoisted(() => {
  return {
    namedExport: vi.fn(),
  }
})

vi.mock('./path/to/module.js', () => {
  return {
    namedExport: mocks.namedExport,
  }
})

vi.mocked(namedExport).mockReturnValue(100)

expect(namedExport()).toBe(100)
expect(namedExport).toBe(mocks.namedExport)
```
:::

::: warning
Wenn Sie ein Modul mit Default-Export mocken, müssen Sie im Objekt der zurückgegebenen Factory-Funktion einen `default`-Schlüssel bereitstellen. Das ist eine ES-Modul-spezifische Besonderheit; die `jest`-Dokumentation kann daher abweichen, da `jest` CommonJS-Module verwendet. Zum Beispiel:

```ts
vi.mock('./path/to/module.js', () => {
  return {
    default: { myDefaultKey: vi.fn() },
    namedExport: vi.fn(),
    // etc...
  }
})
```
:::

Gibt es neben einer Datei, die Sie mocken, einen Ordner `__mocks__` und ist keine Factory angegeben, versucht Vitest, im Unterordner `__mocks__` eine Datei mit demselben Namen zu finden und sie als tatsächliches Modul zu verwenden. Wenn Sie eine Abhängigkeit mocken, versucht Vitest, einen `__mocks__`-Ordner im [Wurzelverzeichnis](/config/root) des Projekts zu finden (Standard ist `process.cwd()`). Sie können Vitest über die Konfigurationsoption [`deps.moduleDirectories`](/config/deps#deps-moduledirectories) mitteilen, wo sich die Abhängigkeiten befinden.

Angenommen, Sie haben diese Dateistruktur:

```
- __mocks__
  - axios.js
- src
  __mocks__
    - increment.js
  - increment.js
- tests
  - increment.test.js
```

Wenn Sie `vi.mock` in einer Testdatei ohne Factory oder Optionen aufrufen, sucht es im Ordner `__mocks__` nach einer Datei, die als Modul verwendet wird:

```ts [increment.test.js]
import { vi } from 'vitest'

// axios is a default export from `__mocks__/axios.js`
import axios from 'axios'

// increment is a named export from `src/__mocks__/increment.js`
import { increment } from '../increment.js'

vi.mock('axios')
vi.mock('../increment.js')

axios.get(`/apples/${increment(1)}`)
```

::: warning
Beachten Sie: Wenn Sie `vi.mock` nicht aufrufen, werden Module **nicht** automatisch gemockt. Um Jests Automocking-Verhalten nachzubilden, können Sie `vi.mock` für jedes benötigte Modul innerhalb der [`setupFiles`](/config/setupfiles) aufrufen.
:::

Gibt es keinen `__mocks__`-Ordner und ist keine Factory angegeben, importiert Vitest das ursprüngliche Modul und automockt alle seine Exporte. Die dabei angewandten Regeln finden Sie unter [Algorithmus](/guide/mocking/modules#automocking-algorithm).

### vi.doMock

```ts
function doMock(
  path: string,
  factory?: MockOptions | MockFactory<unknown>
): Disposable
function doMock<T>(
  module: Promise<T>,
  factory?: MockOptions | MockFactory<T>
): Disposable
```

Dasselbe wie [`vi.mock`](#vi-mock), aber es wird nicht an den Anfang der Datei gehoistet, sodass Sie Variablen im globalen Dateiscope referenzieren können. Der nächste [dynamische Import](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/import) des Moduls wird gemockt.

::: warning
Dies mockt keine Module, die vor diesem Aufruf importiert wurden. Vergessen Sie nicht, dass alle statischen Importe in ESM stets [gehoistet](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/import#hoisting) werden; es vor einen statischen Import zu setzen erzwingt also nicht, dass es vor dem Import aufgerufen wird:

```ts
vi.doMock('./increment.js') // this will be called _after_ the import statement

import { increment } from './increment.js'
```
:::

```ts [increment.js]
export function increment(number) {
  return number + 1
}
```

```ts [increment.test.js]
import { beforeEach, test } from 'vitest'
import { increment } from './increment.js'

// the module is not mocked, because vi.doMock is not called yet
increment(1) === 2

let mockedIncrement = 100

beforeEach(() => {
  // you can access variables inside a factory
  vi.doMock('./increment.js', () => ({ increment: () => ++mockedIncrement }))
})

test('importing the next module imports mocked one', async () => {
  // original import WAS NOT MOCKED, because vi.doMock is evaluated AFTER imports
  expect(increment(1)).toBe(2)
  const { increment: mockedIncrement } = await import('./increment.js')
  // new dynamic import returns mocked module
  expect(mockedIncrement(1)).toBe(101)
  expect(mockedIncrement(1)).toBe(102)
  expect(mockedIncrement(1)).toBe(103)
})
```

::: tip
In Umgebungen, die [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) unterstützen, können Sie `using` auf den von `vi.doMock()` zurückgegebenen Wert anwenden, damit beim Verlassen des umgebenden Blocks automatisch [`vi.doUnmock()`](#vi-dounmock) für das gemockte Modul aufgerufen wird. Das ist besonders nützlich, wenn Sie ein dynamisch importiertes Modul für einen einzelnen Testfall mocken.

```ts
it('uses a mocked version of my-module', () => {
  using _mockDisposable = vi.doMock('my-module')

  const myModule = await import('my-module') // mocked

  // my-module is restored here
})

it('uses the normal version of my-module again', () => {
  const myModule = await import('my-module') // not mocked
})
```
:::

### vi.mocked

```ts
function mocked<T>(
  object: T,
  deep?: boolean
): MaybeMockedDeep<T>
function mocked<T>(
  object: T,
  options?: { partial?: boolean; deep?: boolean }
): MaybePartiallyMockedDeep<T>
```

Typhelfer für TypeScript. Gibt einfach das übergebene Objekt zurück.

Ist `partial` gleich `true`, wird ein `Partial<T>` als Rückgabewert erwartet. Standardmäßig lässt das TypeScript nur glauben, dass die Werte der ersten Ebene gemockt sind. Sie können `{ deep: true }` als zweites Argument übergeben, um TypeScript mitzuteilen, dass das gesamte Objekt gemockt ist, sofern es das tatsächlich ist. Sie können `{ partial: true, deep: true }` übergeben, damit auch verschachtelte Objekte rekursiv partiell sind.

```ts [example.ts]
export function add(x: number, y: number): number {
  return x + y
}

export function fetchSomething(): Promise<Response> {
  return fetch('https://vitest.dev/')
}

export function getUser(): { name: string; address: { city: string; zip: string } } {
  return { name: 'John', address: { city: 'New York', zip: '10001' } }
}
```

```ts [example.test.ts]
import * as example from './example'

vi.mock('./example')

test('1 + 1 equals 10', async () => {
  vi.mocked(example.add).mockReturnValue(10)
  expect(example.add(1, 1)).toBe(10)
})

test('mock return value with only partially correct typing', async () => {
  vi.mocked(example.fetchSomething).mockResolvedValue(new Response('hello'))
  vi.mocked(example.fetchSomething, { partial: true }).mockResolvedValue({ ok: false })
  // vi.mocked(example.someFn).mockResolvedValue({ ok: false }) // this is a type error
})

test('mock return value with deep partial typing', async () => {
  vi.mocked(example.getUser, { partial: true, deep: true }).mockReturnValue({
    address: { city: 'Los Angeles' },
  })
  expect(example.getUser().address.city).toBe('Los Angeles')
})
```

### vi.importActual

```ts
function importActual<T>(path: string): Promise<T>
```

Importiert ein Modul und umgeht dabei alle Prüfungen, ob es gemockt werden sollte. Kann nützlich sein, wenn Sie ein Modul teilweise mocken möchten.

```ts
vi.mock('./example.js', async () => {
  const originalModule = await vi.importActual('./example.js')

  return { ...originalModule, get: vi.fn() }
})
```

### vi.importMock

```ts
function importMock<T>(path: string): Promise<MaybeMockedDeep<T>>
```

Importiert ein Modul, bei dem alle Eigenschaften (einschließlich verschachtelter Eigenschaften) gemockt sind. Folgt denselben Regeln wie [`vi.mock`](#vi-mock). Die angewandten Regeln finden Sie unter [Algorithmus](/guide/mocking/modules#automocking-algorithm).

### vi.unmock

```ts
function unmock(path: string | Promise<Module>): void
```

Entfernt ein Modul aus der Mock-Registry. Alle Import-Aufrufe geben das ursprüngliche Modul zurück, selbst wenn es zuvor gemockt war. Dieser Aufruf wird an den Anfang der Datei gehoistet, entmockt also beispielsweise nur Module, die in `setupFiles` definiert wurden.

### vi.doUnmock

```ts
function doUnmock(path: string | Promise<Module>): void
```

Dasselbe wie [`vi.unmock`](#vi-unmock), aber es wird nicht an den Anfang der Datei gehoistet. Der nächste Import des Moduls importiert das ursprüngliche Modul statt des Mocks. Bereits zuvor importierte Module werden dadurch nicht entmockt.

```ts [increment.js]
export function increment(number) {
  return number + 1
}
```

```ts [increment.test.js]
import { increment } from './increment.js'

// increment is already mocked, because vi.mock is hoisted
increment(1) === 100

// this is hoisted, and factory is called before the import on line 1
vi.mock('./increment.js', () => ({ increment: () => 100 }))

// all calls are mocked, and `increment` always returns 100
increment(1) === 100
increment(30) === 100

// this is not hoisted, so other import will return unmocked module
vi.doUnmock('./increment.js')

// this STILL returns 100, because `vi.doUnmock` doesn't reevaluate a module
increment(1) === 100
increment(30) === 100

// the next import is unmocked, now `increment` is the original function that returns count + 1
const { increment: unmockedIncrement } = await import('./increment.js')

unmockedIncrement(1) === 2
unmockedIncrement(30) === 31
```

### vi.resetModules

```ts
function resetModules(): Vitest
```

Setzt die Modul-Registry zurück, indem der Cache aller Module geleert wird. Dadurch können Module beim erneuten Import neu ausgewertet werden. Top-Level-Importe können nicht neu ausgewertet werden. Kann nützlich sein, um Module zu isolieren, deren lokaler Zustand zwischen Tests kollidiert.

```ts
import { vi } from 'vitest'

import { data } from './data.js' // Will not get reevaluated beforeEach test

beforeEach(() => {
  vi.resetModules()
})

test('change state', async () => {
  const mod = await import('./some/path.js') // Will get reevaluated
  mod.changeLocalState('new value')
  expect(mod.getLocalState()).toBe('new value')
})

test('module has old state', async () => {
  const mod = await import('./some/path.js') // Will get reevaluated
  expect(mod.getLocalState()).toBe('old value')
})
```

::: warning
Setzt die Mock-Registry nicht zurück. Um die Mock-Registry zu leeren, verwenden Sie [`vi.unmock`](#vi-unmock) oder [`vi.doUnmock`](#vi-dounmock).
:::

### vi.dynamicImportSettled

```ts
function dynamicImportSettled(): Promise<void>
```

Wartet, bis alle Importe geladen sind. Nützlich, wenn Sie einen synchronen Aufruf haben, der den Import eines Moduls startet, auf das Sie sonst nicht warten können.

```ts
import { expect, test } from 'vitest'

// cannot track import because Promise is not returned
function renderComponent() {
  import('./component.js').then(({ render }) => {
    render()
  })
}

test('operations are resolved', async () => {
  renderComponent()
  await vi.dynamicImportSettled()
  expect(document.querySelector('.component')).not.toBeNull()
})
```

::: tip
Wird während eines dynamischen Imports ein weiterer dynamischer Import angestoßen, wartet diese Methode, bis alle davon aufgelöst sind.

Diese Methode wartet außerdem nach dem Auflösen des Imports auf den nächsten `setTimeout`-Tick, sodass alle synchronen Operationen abgeschlossen sein sollten, wenn sie erfüllt wird.
:::

## Funktionen und Objekte mocken

Dieser Abschnitt beschreibt, wie man mit [Methoden-Mocks](/api/mock) arbeitet und Umgebungs- sowie globale Variablen ersetzt.

### vi.fn

```ts
function fn(fn?: Procedure | Constructable): Mock
```

Erzeugt einen Spy auf eine Funktion, kann aber auch ohne eine solche angelegt werden. Jedes Mal, wenn eine Funktion aufgerufen wird, speichert sie deren Aufrufargumente, Rückgaben und Instanzen. Zusätzlich können Sie ihr Verhalten mit [Methoden](/api/mock) beeinflussen.
Wird keine Funktion übergeben, gibt der Mock beim Aufruf `undefined` zurück.

```ts
const getApples = vi.fn(() => 0)

getApples()

expect(getApples).toHaveBeenCalled()
expect(getApples).toHaveReturnedWith(0)

getApples.mockReturnValueOnce(5)

const res = getApples()
expect(res).toBe(5)
expect(getApples).toHaveNthReturnedWith(2, 5)
```

Sie können `vi.fn` auch eine Klasse übergeben:

```ts
const Cart = vi.fn(class {
  get = () => 0
})

const cart = new Cart()
expect(Cart).toHaveBeenCalled()
```

### vi.mockObject <Version>3.2.0</Version>

```ts
function mockObject<T>(value: T, options?: MockOptions): MaybeMockedDeep<T>
```

Mockt Eigenschaften und Methoden eines gegebenen Objekts tiefgehend, so wie `vi.mock()` Modul-Exporte mockt. Einzelheiten finden Sie unter [Automocking](/guide/mocking.html#automocking-algorithm).

```ts
const original = {
  simple: () => 'value',
  nested: {
    method: () => 'real'
  },
  prop: 'foo',
}

const mocked = vi.mockObject(original)
expect(mocked.simple()).toBe(undefined)
expect(mocked.nested.method()).toBe(undefined)
expect(mocked.prop).toBe('foo')

mocked.simple.mockReturnValue('mocked')
mocked.nested.method.mockReturnValue('mocked nested')

expect(mocked.simple()).toBe('mocked')
expect(mocked.nested.method()).toBe('mocked nested')
```

Genau wie bei `vi.mock()` können Sie `{ spy: true }` als zweites Argument übergeben, um die Funktionsimplementierungen beizubehalten:

```ts
const spied = vi.mockObject(original, { spy: true })
expect(spied.simple()).toBe('value')
expect(spied.simple).toHaveBeenCalled()
expect(spied.simple.mock.results[0]).toEqual({ type: 'return', value: 'value' })
```

### vi.isMockFunction

```ts
function isMockFunction(fn: unknown): asserts fn is Mock
```

Prüft, ob ein gegebener Parameter eine Mock-Funktion ist. Wenn Sie TypeScript verwenden, wird zusätzlich dessen Typ eingegrenzt.

### vi.clearAllMocks

```ts
function clearAllMocks(): Vitest
```

Ruft [`.mockClear()`](/api/mock#mockclear) auf allen Spies auf.
Das leert die Mock-Historie, ohne die Mock-Implementierungen zu beeinflussen.

### vi.resetAllMocks

```ts
function resetAllMocks(): Vitest
```

Ruft [`.mockReset()`](/api/mock#mockreset) auf allen Spies auf.
Das leert die Mock-Historie und setzt die Implementierung jedes Mocks zurück.

### vi.restoreAllMocks

```ts
function restoreAllMocks(): Vitest
```

Dies stellt alle ursprünglichen Implementierungen auf Spies wieder her, die mit [`vi.spyOn`](#vi-spyon) erzeugt wurden.

Nachdem der Mock wiederhergestellt wurde, können Sie ihn erneut ausspähen.

::: warning
Diese Methode wirkt sich auch nicht auf Mocks aus, die während des [Automockings](/guide/mocking/modules#mocking-a-module) erzeugt wurden.

Beachten Sie, dass `vi.restoreAllMocks` – anders als [`mock.mockRestore`](/api/mock#mockrestore) – weder die Mock-Historie leert noch die Mock-Implementierung zurücksetzt.
:::

### vi.spyOn

```ts
function spyOn<T, K extends keyof T>(
  object: T,
  key: K,
  accessor?: 'get' | 'set'
): Mock<T[K]>
```

Erzeugt einen Spy auf eine Methode oder einen Getter/Setter eines Objekts, ähnlich wie [`vi.fn()`](#vi-fn). Gibt eine [Mock-Funktion](/api/mock) zurück.

```ts
let apples = 0
const cart = {
  getApples: () => 42,
}

const spy = vi.spyOn(cart, 'getApples').mockImplementation(() => apples)
apples = 1

expect(cart.getApples()).toBe(1)

expect(spy).toHaveBeenCalled()
expect(spy).toHaveReturnedWith(1)
```

Ist die ausgespähte Methode eine Klassendefinition, müssen die Mock-Implementierungen das Schlüsselwort `function` oder `class` verwenden:

```ts {12-14,16-20}
const cart = {
  Apples: class Apples {
    getApples() {
      return 42
    }
  }
}

const spy = vi.spyOn(cart, 'Apples')
  .mockImplementation(() => ({ getApples: () => 0 })) // [!code --]
  // with a function keyword
  .mockImplementation(function () {
    this.getApples = () => 0
  })
  // with a custom class
  .mockImplementation(class MockApples {
    getApples() {
      return 0
    }
  })
```

Wenn Sie eine Arrow Function übergeben, erhalten Sie beim Aufruf des Mocks den [Fehler `<anonymous> is not a constructor`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Not_a_constructor).

::: tip
In Umgebungen, die [Explicit Resource Management](https://github.com/tc39/proposal-explicit-resource-management) unterstützen, können Sie `using` statt `const` verwenden, damit `mockRestore` bei jeder gemockten Funktion automatisch aufgerufen wird, wenn der umgebende Block verlassen wird. Das ist besonders bei ausgespähten Methoden nützlich:

```ts
it('calls console.log', () => {
  using spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  debug('message')
  expect(spy).toHaveBeenCalled()
})
// console.log is restored here
```
:::

::: tip
Sie können [`vi.restoreAllMocks`](#vi-restoreallmocks) innerhalb von [`afterEach`](/api/hooks#aftereach) aufrufen (oder [`test.restoreMocks`](/config/restoremocks) aktivieren), um nach jedem Test alle Methoden auf ihre ursprünglichen Implementierungen zurückzusetzen. Dabei wird der ursprüngliche [Objekt-Deskriptor](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/defineProperty) wiederhergestellt, sodass Sie die Implementierung der Methode nicht mehr ändern können, es sei denn, Sie spähen erneut:

```ts
const cart = {
  getApples: () => 42,
}

const spy = vi.spyOn(cart, 'getApples').mockReturnValue(10)

console.log(cart.getApples()) // 10
vi.restoreAllMocks()
console.log(cart.getApples()) // 42
spy.mockReturnValue(10)
console.log(cart.getApples()) // still 42!
```
:::

::: tip
Im [Browser-Modus](/guide/browser/) ist es nicht möglich, exportierte Methoden auszuspähen. Stattdessen können Sie jede exportierte Methode ausspähen, indem Sie `vi.mock("./file-path.js", { spy: true })` aufrufen. Das mockt jeden Export, lässt dessen Implementierung aber unangetastet, sodass Sie prüfen können, ob die Methode korrekt aufgerufen wurde.

```ts
import { calculator } from './src/calculator.ts'

vi.mock('./src/calculator.ts', { spy: true })

calculator(1, 2)

expect(calculator).toHaveBeenCalledWith(1, 2)
expect(calculator).toHaveReturned(3)
```

Und auch wenn es möglich ist, Exporte in `jsdom` oder anderen Node.js-Umgebungen auszuspähen, kann sich das in Zukunft ändern.
:::

### vi.stubEnv {#vi-stubenv}

```ts
function stubEnv<T extends string>(
  name: T,
  value: T extends 'PROD' | 'DEV' | 'SSR' ? boolean : string | undefined
): Vitest
```

Ändert den Wert einer Umgebungsvariablen auf `process.env` und `import.meta.env`. Sie können ihren Wert durch Aufruf von `vi.unstubAllEnvs` wiederherstellen.

```ts
import { vi } from 'vitest'

// `process.env.NODE_ENV` and `import.meta.env.NODE_ENV`
// are "development" before calling "vi.stubEnv"

vi.stubEnv('NODE_ENV', 'production')

process.env.NODE_ENV === 'production'
import.meta.env.NODE_ENV === 'production'

vi.stubEnv('NODE_ENV', undefined)

process.env.NODE_ENV === undefined
import.meta.env.NODE_ENV === undefined

// doesn't change other envs
import.meta.env.MODE === 'development'
```

:::tip
Sie können den Wert auch ändern, indem Sie ihn einfach zuweisen, dann können Sie den vorherigen Wert aber nicht mit `vi.unstubAllEnvs` wiederherstellen:

```ts
import.meta.env.MODE = 'test'
```
:::

### vi.unstubAllEnvs {#vi-unstuballenvs}

```ts
function unstubAllEnvs(): Vitest
```

Stellt alle Werte von `import.meta.env` und `process.env` wieder her, die mit `vi.stubEnv` geändert wurden. Beim ersten Aufruf merkt sich Vitest den ursprünglichen Wert und speichert ihn, bis `unstubAllEnvs` erneut aufgerufen wird.

```ts
import { vi } from 'vitest'

// `process.env.NODE_ENV` and `import.meta.env.NODE_ENV`
// are "development" before calling stubEnv

vi.stubEnv('NODE_ENV', 'production')

process.env.NODE_ENV === 'production'
import.meta.env.NODE_ENV === 'production'

vi.stubEnv('NODE_ENV', 'staging')

process.env.NODE_ENV === 'staging'
import.meta.env.NODE_ENV === 'staging'

vi.unstubAllEnvs()

// restores to the value that were stored before the first "stubEnv" call
process.env.NODE_ENV === 'development'
import.meta.env.NODE_ENV === 'development'
```

### vi.stubGlobal

```ts
function stubGlobal(
  name: string | number | symbol,
  value: unknown
): Vitest
```

Ändert den Wert einer globalen Variablen. Sie können ihren ursprünglichen Wert durch Aufruf von `vi.unstubAllGlobals` wiederherstellen.

```ts
import { vi } from 'vitest'

// `innerWidth` is "0" before calling stubGlobal

vi.stubGlobal('innerWidth', 100)

innerWidth === 100
globalThis.innerWidth === 100
// if you are using jsdom or happy-dom
window.innerWidth === 100
```

:::tip
Sie können den Wert auch ändern, indem Sie ihn einfach `globalThis` oder `window` zuweisen (wenn Sie die Umgebung `jsdom` oder `happy-dom` verwenden), dann können Sie den ursprünglichen Wert aber nicht mit `vi.unstubAllGlobals` wiederherstellen:

```ts
globalThis.innerWidth = 100
// if you are using jsdom or happy-dom
window.innerWidth = 100
```
:::

### vi.unstubAllGlobals {#vi-unstuballglobals}

```ts
function unstubAllGlobals(): Vitest
```

Stellt alle globalen Werte auf `globalThis`/`global` (sowie `window`/`top`/`self`/`parent`, wenn Sie die Umgebung `jsdom` oder `happy-dom` verwenden) wieder her, die mit `vi.stubGlobal` geändert wurden. Beim ersten Aufruf merkt sich Vitest den ursprünglichen Wert und speichert ihn, bis `unstubAllGlobals` erneut aufgerufen wird.

```ts
import { vi } from 'vitest'

const Mock = vi.fn()

// IntersectionObserver is "undefined" before calling "stubGlobal"

vi.stubGlobal('IntersectionObserver', Mock)

IntersectionObserver === Mock
global.IntersectionObserver === Mock
globalThis.IntersectionObserver === Mock
// if you are using jsdom or happy-dom
window.IntersectionObserver === Mock

vi.unstubAllGlobals()

globalThis.IntersectionObserver === undefined
'IntersectionObserver' in globalThis === false
// throws ReferenceError, because it's not defined
IntersectionObserver === undefined
```

### vi.when <Version>5.0.0</Version> {#vi-when}

```ts
interface WhenOptions {
  onUnmatched?: 'throw' | 'passthrough' | ((...args: unknown[]) => unknown)
}

interface BehaviorOptions {
  times?: number
}

function when(spy: Mock, options?: WhenOptions): When
```

Definiert argumentabhängiges Verhalten auf einem Spy und ersetzt dessen Implementierung für die Dauer der `when`-Kette.

Rufen Sie `.calledWith(...args)` auf dem zurückgegebenen Objekt auf, um anzugeben, welche Aufrufargumente passen sollen, und verketten Sie dann eine oder mehrere `then*`-Methoden, um zu deklarieren, was der Spy bei einem Aufruf mit diesen Argumenten zurückgeben, werfen oder auflösen soll. Argumente werden mit Tiefengleichheit abgeglichen und unterstützen asymmetrische Matcher wie `expect.any()`.

```ts
const spy = vi.fn()

vi.when(spy)
  .calledWith(1)
  .thenReturn('one')
  .calledWith(2)
  .thenReturn('two')

expect(spy(1)).toBe('one')
expect(spy(2)).toBe('two')
```

Verfügbare `then*`-Methoden:

| Methode | Beschreibung |
|--------|-------------|
| `thenReturn(value, options?)` | Gibt `value` zurück. |
| `thenReturnOnce(value)` | Gibt `value` einmal zurück, danach greift der Rückfall. |
| `thenThrow(error, options?)` | Wirft `error`. |
| `thenThrowOnce(error)` | Wirft `error` einmal, danach greift der Rückfall. |
| `thenResolve(value, options?)` | Gibt ein erfülltes `Promise` mit `value` zurück. |
| `thenResolveOnce(value)` | Erfüllt einmal, danach greift der Rückfall. |
| `thenReject(error, options?)` | Gibt ein abgelehntes `Promise` mit `error` zurück. |
| `thenRejectOnce(error)` | Lehnt einmal ab, danach greift der Rückfall. |

Die optionale Option `times` begrenzt, wie oft ein Verhalten greift, bevor es aufgebraucht ist. Verhalten, die für dieselben Argumente registriert wurden, werden nach dem Last-in-first-out-Prinzip verbraucht: Das zuletzt registrierte Verhalten wird zuerst versucht, und ist es aufgebraucht, dienen die früheren als Rückfall.

```ts
const spy = vi.fn<(key: string) => string>()

vi.when(spy)
  .calledWith('theme')
  .thenReturn('light') // fallback, applies indefinitely
  .thenReturn('dark', { times: 2 }) // applied first for the next 2 calls

expect(spy('theme')).toBe('dark')
expect(spy('theme')).toBe('dark')
expect(spy('theme')).toBe('light') // falls back
```

Wird der Spy mit Argumenten aufgerufen, die zu keinem registrierten Verhalten passen, fällt er standardmäßig auf seine ursprüngliche Implementierung zurück. Mit der Option `onUnmatched` ändern Sie das:

- `'passthrough'` (**Standard**): delegiert an die ursprüngliche Implementierung des Spys
- `'throw'`: wirft einen Fehler, der die nicht passenden Argumente auflistet
- eine Funktion: wird mit den nicht passenden Argumenten aufgerufen; ihr Rückgabewert wird verwendet

```ts
const spy = vi.fn<(id: number) => string>()

vi.when(spy, { onUnmatched: 'throw' })
  .calledWith(1)
  .thenReturn('Alice')

expect(spy(1)).toBe('Alice')
expect(() => spy(99)).toThrow() // no behavior defined for 99
```

Das von `vi.when` zurückgegebene `When`-Objekt unterstützt die [Assertion `toHaveBeenExhausted`](/api/expect#tohavebeenexhausted), die besteht, sobald jedes registrierte Verhalten verbraucht wurde.

```ts
const spy = vi.fn()
const w = vi.when(spy)
  .calledWith(1)
  .thenReturnOnce('once')
  .calledWith(2)
  .thenReturn('always')

expect(w).not.toHaveBeenExhausted()

spy(1) // consumes the `thenReturnOnce` behavior
spy(2) // satisfies `thenReturn` (called at least once)

expect(w).toHaveBeenExhausted()
```

::: tip
In Umgebungen, die [Explicit Resource Management](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Resource_management) unterstützen, können Sie `using` statt `const` verwenden, damit die ursprüngliche Implementierung des Spys automatisch wiederhergestellt wird, wenn der umgebende Block verlassen wird:

```ts
const spy = vi.fn(() => 'original')

{
  using w = vi.when(spy)
    .calledWith('hello')
    .thenReturn('mocked')

  expect(spy('hello')).toBe('mocked')
} // ← spy's original implementation is restored here

expect(spy('hello')).toBe('original')
```
:::

### vi.isWhenChain <Version>5.0.0</Version> {#vi-iswhenchain}

```ts
function isWhenChain(input: object): input is When
```

Gibt `true` zurück, wenn der gegebene Wert eine mit [`vi.when`](#vi-when) erzeugte `When`-Kette ist. Wenn Sie TypeScript verwenden, wird zusätzlich dessen Typ eingegrenzt.

```ts
const spy = vi.fn()
const w = vi.when(spy).calledWith(1).thenReturn(0)

expect(vi.isWhenChain(w)).toBe(true)
expect(vi.isWhenChain(spy)).toBe(false)
```

## Fake Timers

Dieser Abschnitt beschreibt, wie man mit [Fake Timers](/guide/mocking/timers) arbeitet.

### vi.advanceTimersByTime

```ts
function advanceTimersByTime(ms: number): Vitest
```

Diese Methode ruft jeden gestarteten Timer auf, bis die angegebene Anzahl Millisekunden vergangen oder die Warteschlange leer ist – je nachdem, was zuerst eintritt.

```ts
let i = 0
setInterval(() => console.log(++i), 50)

vi.advanceTimersByTime(150)

// log: 1
// log: 2
// log: 3
```

### vi.advanceTimersByTimeAsync

```ts
function advanceTimersByTimeAsync(ms: number): Promise<Vitest>
```

Diese Methode ruft jeden gestarteten Timer auf, bis die angegebene Anzahl Millisekunden vergangen oder die Warteschlange leer ist – je nachdem, was zuerst eintritt. Dabei werden auch asynchron gesetzte Timer berücksichtigt.

```ts
let i = 0
setInterval(() => Promise.resolve().then(() => console.log(++i)), 50)

await vi.advanceTimersByTimeAsync(150)

// log: 1
// log: 2
// log: 3
```

### vi.advanceTimersToNextTimer

```ts
function advanceTimersToNextTimer(): Vitest
```

Ruft den nächsten verfügbaren Timer auf. Nützlich, um zwischen den einzelnen Timer-Aufrufen Assertions zu machen. Sie können den Aufruf verketten, um Timer selbst zu steuern.

```ts
let i = 0
setInterval(() => console.log(++i), 50)

vi.advanceTimersToNextTimer() // log: 1
  .advanceTimersToNextTimer() // log: 2
  .advanceTimersToNextTimer() // log: 3
```

### vi.advanceTimersToNextTimerAsync

```ts
function advanceTimersToNextTimerAsync(): Promise<Vitest>
```

Ruft den nächsten verfügbaren Timer auf und wartet, bis er aufgelöst ist, falls er asynchron gesetzt wurde. Nützlich, um zwischen den einzelnen Timer-Aufrufen Assertions zu machen.

```ts
let i = 0
setInterval(() => Promise.resolve().then(() => console.log(++i)), 50)

await vi.advanceTimersToNextTimerAsync() // log: 1
expect(console.log).toHaveBeenCalledWith(1)

await vi.advanceTimersToNextTimerAsync() // log: 2
await vi.advanceTimersToNextTimerAsync() // log: 3
```

### vi.advanceTimersToNextFrame {#vi-advancetimerstonextframe}

```ts
function advanceTimersToNextFrame(): Vitest
```

Ähnlich wie [`vi.advanceTimersByTime`](/api/vi#vi-advancetimersbytime), rückt die Timer aber um die Millisekunden vor, die nötig sind, um die aktuell mit `requestAnimationFrame` eingeplanten Callbacks auszuführen.

```ts
let frameRendered = false

requestAnimationFrame(() => {
  frameRendered = true
})

vi.advanceTimersToNextFrame()

expect(frameRendered).toBe(true)
```

### vi.getTimerCount

```ts
function getTimerCount(): number
```

Liefert die Anzahl der wartenden Timer.

### vi.clearAllTimers

```ts
function clearAllTimers(): void
```

Entfernt alle Timer, deren Ausführung eingeplant ist. Diese Timer werden in Zukunft nie ausgeführt.

### vi.getMockedSystemTime

```ts
function getMockedSystemTime(): Date | null
```

Gibt das gemockte aktuelle Datum zurück. Ist das Datum nicht gemockt, gibt die Methode `null` zurück.

### vi.getRealSystemTime

```ts
function getRealSystemTime(): number
```

Bei Verwendung von `vi.useFakeTimers` werden Aufrufe von `Date.now` gemockt. Wenn Sie die echte Zeit in Millisekunden benötigen, können Sie diese Funktion aufrufen.

### vi.runAllTicks

```ts
function runAllTicks(): Vitest
```

Ruft jede Microtask auf, die von `process.nextTick` eingereiht wurde. Dabei werden auch alle von diesen selbst eingeplanten Microtasks ausgeführt.

### vi.runAllTimers

```ts
function runAllTimers(): Vitest
```

Diese Methode ruft jeden gestarteten Timer auf, bis die Timer-Warteschlange leer ist. Das bedeutet, dass jeder während `runAllTimers` aufgerufene Timer ausgelöst wird. Haben Sie ein unendliches Intervall, wirft sie nach 10 000 Versuchen einen Fehler (konfigurierbar über [`fakeTimers.loopLimit`](/config/faketimers#faketimers-looplimit)).

```ts
let i = 0
setTimeout(() => console.log(++i))
const interval = setInterval(() => {
  console.log(++i)
  if (i === 3) {
    clearInterval(interval)
  }
}, 50)

vi.runAllTimers()

// log: 1
// log: 2
// log: 3
```

### vi.runAllTimersAsync

```ts
function runAllTimersAsync(): Promise<Vitest>
```

Diese Methode ruft asynchron jeden gestarteten Timer auf, bis die Timer-Warteschlange leer ist. Das bedeutet, dass jeder während `runAllTimersAsync` aufgerufene Timer ausgelöst wird, sogar asynchrone Timer. Haben Sie ein unendliches Intervall,
wirft sie nach 10 000 Versuchen einen Fehler (konfigurierbar über [`fakeTimers.loopLimit`](/config/faketimers#faketimers-looplimit)).

```ts
setTimeout(async () => {
  console.log(await Promise.resolve('result'))
}, 100)

await vi.runAllTimersAsync()

// log: result
```

### vi.runOnlyPendingTimers

```ts
function runOnlyPendingTimers(): Vitest
```

Diese Methode ruft jeden Timer auf, der nach dem Aufruf von [`vi.useFakeTimers`](#vi-usefaketimers) gestartet wurde. Timer, die während ihres Aufrufs gestartet werden, löst sie nicht aus.

```ts
let i = 0
setInterval(() => console.log(++i), 50)

vi.runOnlyPendingTimers()

// log: 1
```

### vi.runOnlyPendingTimersAsync

```ts
function runOnlyPendingTimersAsync(): Promise<Vitest>
```

Diese Methode ruft asynchron jeden Timer auf, der nach dem Aufruf von [`vi.useFakeTimers`](#vi-usefaketimers) gestartet wurde, auch asynchrone. Timer, die während ihres Aufrufs gestartet werden, löst sie nicht aus.

```ts
setTimeout(() => {
  console.log(1)
}, 100)
setTimeout(() => {
  Promise.resolve().then(() => {
    console.log(2)
    setInterval(() => {
      console.log(3)
    }, 40)
  })
}, 10)

await vi.runOnlyPendingTimersAsync()

// log: 2
// log: 3
// log: 3
// log: 1
```

### vi.setSystemTime

```ts
function setSystemTime(date: string | number | Date): Vitest
```

Sind Fake Timers aktiviert, simuliert diese Methode, dass ein Anwender die Systemuhr ändert (das betrifft datumsbezogene APIs wie `hrtime`, `performance.now` oder `new Date()`) – sie löst jedoch keine Timer aus. Sind Fake Timers nicht aktiviert, mockt diese Methode nur Aufrufe von `Date.*` und `Temporal.Now.*`.

Nützlich, wenn Sie etwas testen müssen, das vom aktuellen Datum abhängt – zum Beispiel [Luxon](https://github.com/moment/luxon/)-Aufrufe in Ihrem Code.

Akzeptiert dieselben Zeichenketten- und Zahlenargumente wie `Date`.

```ts
const date = new Date(1998, 11, 19)

vi.useFakeTimers()
vi.setSystemTime(date)

expect(Date.now()).toBe(date.valueOf())

vi.useRealTimers()
```

### vi.useFakeTimers

```ts
function useFakeTimers(config?: FakeTimersConfig): Vitest
```

Um das Mocken von Timern zu aktivieren, müssen Sie diese Methode aufrufen. Sie umhüllt alle weiteren Aufrufe von Timern (etwa `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `setImmediate`, `clearImmediate` und `Date`), bis [`vi.useRealTimers()`](#vi-userealtimers) aufgerufen wird.

Das Mocken von `nextTick` wird nicht unterstützt, wenn Vitest mit `--pool=forks` innerhalb von `node:child_process` läuft. NodeJS verwendet `process.nextTick` intern in `node:child_process` und hängt, wenn es gemockt wird. Das Mocken von `nextTick` wird unterstützt, wenn Vitest mit `--pool=threads` läuft.

Die Implementierung basiert intern auf [`@sinonjs/fake-timers`](https://github.com/sinonjs/fake-timers).

::: tip
`vi.useFakeTimers()` mockt `process.nextTick` und `queueMicrotask` nicht automatisch.
Sie können das aber aktivieren, indem Sie die Option im Argument `toFake` angeben: `vi.useFakeTimers({ toFake: ['nextTick', 'queueMicrotask'] })`.
:::

Sie können mit `toFake` angeben, welche Timer gemockt werden sollen, oder mit `toNotFake`, welche Timer nativ bleiben sollen. Beachten Sie, dass `toFake` und `toNotFake` nicht gemeinsam angegeben werden können.

```ts
// only mock setTimeout and clearTimeout
vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

// mock all timers except setInterval
vi.useFakeTimers({ toNotFake: ['setInterval'] })
```

### vi.setTimerTickMode <Version>4.1.0</Version> {#vi-settimertickmode}

- **Typ:** `(mode: 'manual' | 'nextTimerAsync') => Vitest | (mode: 'interval', interval?: number) => Vitest`

Steuert, wie Fake Timers vorgerückt werden.

- `manual`: Das Standardverhalten. Timer rücken nur vor, wenn Sie eine der Methoden `vi.advanceTimers...()` aufrufen.
- `nextTimerAsync`: Timer werden nach jeder Macrotask automatisch bis zum nächsten verfügbaren Timer vorgerückt.
- `interval`: Timer werden automatisch um ein angegebenes Intervall vorgerückt.

Ist `mode` gleich `'interval'`, können Sie zusätzlich ein `interval` in Millisekunden angeben.

**Beispiel:**

```ts
import { vi } from 'vitest'

vi.useFakeTimers()

// Manual mode (default)
vi.setTimerTickMode('manual')

let i = 0
setInterval(() => console.log(++i), 50)

vi.advanceTimersByTime(150) // logs 1, 2, 3

// nextTimerAsync mode
vi.setTimerTickMode('nextTimerAsync')

// Timers will advance automatically after each macrotask
await new Promise(resolve => setTimeout(resolve, 150)) // logs 4, 5, 6

// interval mode (default when 'fakeTimers.shouldAdvanceTime' is `true`)
vi.setTimerTickMode('interval', 50)

// Timers will advance automatically every 50ms
await new Promise(resolve => setTimeout(resolve, 150)) // logs 7, 8, 9
```

### vi.isFakeTimers {#vi-isfaketimers}

```ts
function isFakeTimers(): boolean
```

Gibt `true` zurück, wenn Fake Timers aktiviert sind.

### vi.useRealTimers

```ts
function useRealTimers(): Vitest
```

Wenn die Timer abgelaufen sind, können Sie diese Methode aufrufen, um die gemockten Timer auf ihre ursprünglichen Implementierungen zurückzusetzen. Alle zuvor eingeplanten Timer werden verworfen.

## Verschiedenes

Eine Reihe nützlicher Hilfsfunktionen, die Vitest bereitstellt.

### vi.waitFor {#vi-waitfor}

```ts
function waitFor<T>(
  callback: WaitForCallback<T>,
  options?: number | WaitForOptions
): Promise<T>
```

Wartet darauf, dass der Callback erfolgreich ausgeführt wird. Wirft der Callback einen Fehler oder gibt er ein abgelehntes Promise zurück, wird weiter gewartet, bis er erfolgreich ist oder ein Timeout eintritt.

Ist options auf eine Zahl gesetzt, entspricht das der Angabe von `{ timeout: options }`.

Das ist sehr nützlich, wenn Sie auf den Abschluss einer asynchronen Aktion warten müssen, zum Beispiel wenn Sie einen Server starten und auf dessen Start warten müssen.

```ts
import { expect, test, vi } from 'vitest'
import { createServer } from './server.js'

test('Server started successfully', async () => {
  const server = createServer()

  await vi.waitFor(
    () => {
      if (!server.isReady) {
        throw new Error('Server not started')
      }

      console.log('Server started')
    },
    {
      timeout: 500, // default is 1000
      interval: 20, // default is 50
    }
  )
  expect(server.isReady).toBe(true)
})
```

Es funktioniert auch für asynchrone Callbacks

```ts
// @vitest-environment jsdom

import { expect, test, vi } from 'vitest'
import { getDOMElementAsync, populateDOMAsync } from './dom.js'

test('Element exists in a DOM', async () => {
  // start populating DOM
  populateDOMAsync()

  const element = await vi.waitFor(async () => {
    // try to get the element until it exists
    const element = await getDOMElementAsync() as HTMLElement | null
    expect(element).toBeTruthy()
    expect(element.dataset.initialized).toBeTruthy()
    return element
  }, {
    timeout: 500, // default is 1000
    interval: 20, // default is 50
  })
  expect(element).toBeInstanceOf(HTMLElement)
})
```

Wird `vi.useFakeTimers` verwendet, ruft `vi.waitFor` in jedem Prüf-Callback automatisch `vi.advanceTimersByTime(interval)` auf.

### vi.waitUntil {#vi-waituntil}

```ts
function waitUntil<T>(
  callback: WaitUntilCallback<T>,
  options?: number | WaitUntilOptions
): Promise<T>
```

Das ähnelt `vi.waitFor`, aber wenn der Callback irgendwelche Fehler wirft, wird die Ausführung sofort unterbrochen und eine Fehlermeldung ausgegeben. Gibt der Callback einen falsy Wert zurück, wird die nächste Prüfung fortgesetzt, bis ein truthy Wert zurückgegeben wird. Das ist nützlich, wenn Sie warten müssen, bis etwas existiert, bevor Sie den nächsten Schritt gehen.

Sehen Sie sich das folgende Beispiel an. Wir können `vi.waitUntil` verwenden, um darauf zu warten, dass das Element auf der Seite erscheint, und dann etwas mit dem Element tun.

```ts
import { expect, test, vi } from 'vitest'

test('Element render correctly', async () => {
  const element = await vi.waitUntil(
    () => document.querySelector('.element'),
    {
      timeout: 500, // default is 1000
      interval: 20, // default is 50
    }
  )

  // do something with the element
  expect(element.querySelector('.element-child')).toBeTruthy()
})
```

### vi.hoisted {#vi-hoisted}

```ts
function hoisted<T>(factory: () => T): T
```

Alle statischen `import`-Anweisungen in ES-Modulen werden an den Anfang der Datei gehoistet, sodass jeder Code, der vor den Importen definiert ist, tatsächlich erst nach dem Auswerten der Importe ausgeführt wird.

Es kann jedoch nützlich sein, Seiteneffekte wie das Mocken von Daten auszulösen, bevor ein Modul importiert wird.

Um diese Einschränkung zu umgehen, können Sie statische Importe wie folgt in dynamische umschreiben:

```diff
callFunctionWithSideEffect()
- import { value } from './some/module.js'
+ const { value } = await import('./some/module.js')
```

Wenn Sie `vitest` ausführen, können Sie das mit der Methode `vi.hoisted` automatisch erledigen. Unter der Haube wandelt Vitest statische Importe in dynamische um und erhält dabei die Live-Bindings.

```diff
- callFunctionWithSideEffect()
import { value } from './some/module.js'
+ vi.hoisted(() => callFunctionWithSideEffect())
```

::: warning IMPORTE SIND NICHT VERFÜGBAR
Code vor den Importen auszuführen bedeutet, dass Sie nicht auf importierte Variablen zugreifen können, weil sie noch nicht definiert sind:

```ts
import { value } from './some/module.js'

vi.hoisted(() => { value }) // throws an error // [!code warning]
```

Dieser Code erzeugt einen Fehler:

```
Cannot access '__vi_import_0__' before initialization
```

Wenn Sie innerhalb von `vi.hoisted` auf eine Variable aus einem anderen Modul zugreifen müssen, verwenden Sie einen dynamischen Import:

```ts
await vi.hoisted(async () => {
  const { value } = await import('./some/module.js')
})
```

Es ist jedoch nicht empfehlenswert, innerhalb von `vi.hoisted` etwas zu importieren, weil Importe bereits gehoistet werden – wenn Sie etwas ausführen müssen, bevor die Tests laufen, führen Sie es einfach im importierten Modul selbst aus.
:::

Diese Methode gibt den Wert zurück, den die Factory zurückgegeben hat. Sie können diesen Wert in Ihren `vi.mock`-Factories verwenden, wenn Sie unkomplizierten Zugriff auf lokal definierte Variablen brauchen:

```ts
import { expect, vi } from 'vitest'
import { originalMethod } from './path/to/module.js'

const { mockedMethod } = vi.hoisted(() => {
  return { mockedMethod: vi.fn() }
})

vi.mock('./path/to/module.js', () => {
  return { originalMethod: mockedMethod }
})

mockedMethod.mockReturnValue(100)
expect(originalMethod()).toBe(100)
```

Beachten Sie, dass diese Methode auch asynchron aufgerufen werden kann, selbst wenn Ihre Umgebung Top-Level-await nicht unterstützt:

```ts
const json = await vi.hoisted(async () => {
  const response = await fetch('https://jsonplaceholder.typicode.com/posts')
  return response.json()
})
```

### vi.setConfig

```ts
function setConfig(config: RuntimeOptions): void
```

Aktualisiert die Konfiguration für die aktuelle Testdatei. Diese Methode unterstützt nur Konfigurationsoptionen, die sich auf die aktuelle Testdatei auswirken:

```ts
vi.setConfig({
  allowOnly: true,
  testTimeout: 10_000,
  hookTimeout: 10_000,
  clearMocks: true,
  restoreMocks: true,
  fakeTimers: {
    now: new Date(2021, 11, 19),
    // supports the whole object
  },
  maxConcurrency: 10,
  sequence: {
    hooks: 'stack'
    // supports only "sequence.hooks"
  }
})
```

### vi.resetConfig

```ts
function resetConfig(): void
```

Wurde zuvor [`vi.setConfig`](#vi-setconfig) aufgerufen, setzt dies die Konfiguration auf den ursprünglichen Zustand zurück.

### vi.defineHelper <Version>4.1.0</Version> {#vi-definehelper}

```ts
function defineHelper<F extends (...args: any) => any>(fn: F): F
```

Umhüllt eine Funktion, um einen Assertion-Helfer zu erzeugen. Schlägt eine Assertion innerhalb des Helfers fehl, verweist der Stacktrace des Fehlers auf die Stelle, an der der Helfer aufgerufen wurde, und nicht auf eine Stelle innerhalb des Helfers. Das erleichtert es, die Ursache von Testfehlern zu erkennen, wenn Sie eigene Assertion-Funktionen verwenden.

Funktioniert sowohl mit synchronen als auch mit asynchronen Funktionen und unterstützt `expect.soft()`.

```ts
import { expect, vi } from 'vitest'

const assertPair = vi.defineHelper((a, b) => {
  expect(a).toEqual(b)
})

test('example', () => {
  assertPair('left', 'right') // Error points to this line
})
```

Beispielausgabe:

<!-- eslint-skip -->
```js
FAIL  example.test.ts > example
AssertionError: expected 'left' to deeply equal 'right'

Expected: "right"
Received: "left"

 ❯ example.test.ts:8:3
      7| test('example', () => {
      8|   assertPair('left', 'right')
       |   ^
      9| })
```
