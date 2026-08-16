# Mock-Funktionen

Beim Schreiben von Tests müssen Sie häufig eine echte Funktion oder ein echtes Modul durch eine kontrollierte Variante ersetzen. Das nennt man **Mocking**. Dafür gibt es mehrere Gründe: Vielleicht führt die echte Funktion Netzwerk-Requests aus, die Ihre Tests verlangsamen würden, oder Sie müssen einen Fehler simulieren, der sich mit echtem Code nur schwer auslösen lässt. Mock-Funktionen erlauben es Ihnen zu steuern, was eine Abhängigkeit zurückgibt, zu beobachten, wie sie aufgerufen wurde, und den getesteten Code von Seiteneffekten zu isolieren.

Vitest stellt Mocking-Werkzeuge über das Objekt [`vi`](/api/vi) bereit.

## Mock-Funktionen erzeugen

Am einfachsten erzeugen Sie einen Mock mit [`vi.fn()`](/api/vi#vi-fn). Damit erhalten Sie eine Funktion, die standardmäßig nichts tut (sie gibt `undefined` zurück), aber jeden Aufruf an sie mitschreibt:

```js
import { expect, test, vi } from 'vitest'

test('mock function basics', () => {
  const getApples = vi.fn()

  // Call it
  getApples()

  // Check it was called
  expect(getApples).toHaveBeenCalled()
  expect(getApples).toHaveBeenCalledTimes(1)

  // By default, a mock returns undefined
  expect(getApples()).toBeUndefined()
})
```

## Rückgabewerte von Mocks

Ein Mock, der stets `undefined` zurückgibt, ist für sich genommen wenig nützlich. Meist möchten Sie steuern, was er zurückgibt, um zu testen, wie Ihr Code auf verschiedene Werte reagiert:

```js
import { expect, test, vi } from 'vitest'

test('mock return values', () => {
  const getApples = vi.fn()

  // Always return this value
  getApples.mockReturnValue(10)
  expect(getApples()).toBe(10)

  // Return this value only once, then fall back to the default
  getApples.mockReturnValueOnce(20)
  expect(getApples()).toBe(20) // 20 (one-time)
  expect(getApples()).toBe(10) // back to default
})
```

Ist die zu mockende Funktion asynchron, verwenden Sie [`mockResolvedValue`](/api/mock#mockresolvedvalue) und [`mockRejectedValue`](/api/mock#mockrejectedvalue), um das Ergebnis des Promise zu steuern:

```js
test('mock async return values', async () => {
  const fetchUser = vi.fn()

  fetchUser.mockResolvedValue({ name: 'Alice' })
  const user = await fetchUser()
  expect(user.name).toBe('Alice')

  fetchUser.mockRejectedValue(new Error('Not found'))
  await expect(fetchUser()).rejects.toThrow('Not found')
})
```

::: tip
`mockReturnValue` gibt unabhängig von den Argumenten, die der Mock erhält, stets denselben Wert zurück. Wenn Sie argumentabhängige Rückgabewerte benötigen, erlaubt es [`vi.when`](/api/vi#vi-when), unterschiedliche Verhaltensweisen für verschiedene Argumentkombinationen zu hinterlegen, ohne eigene `if/else`-Logik zu schreiben. Details finden Sie im Rezept [Bedingtes Mocking](/guide/recipes/conditional-mocking).
:::

## Mock-Implementierung

Manchmal brauchen Sie mehr als einen festen Rückgabewert. Sie möchten, dass der Mock tatsächlich etwas mit seinen Argumenten tut. Mit [`mockImplementation`](/api/mock#mockimplementation) können Sie eine vollständige Ersatzfunktion bereitstellen:

```js
import { expect, test, vi } from 'vitest'

test('mock with custom implementation', () => {
  const add = vi.fn()
  add.mockImplementation((a, b) => a + b)

  expect(add(1, 2)).toBe(3)
  expect(add(10, 20)).toBe(30)
})
```

Als Kurzform können Sie die Implementierung direkt an `vi.fn()` übergeben:

```js
const add = vi.fn((a, b) => a + b)
```

## Aufrufe untersuchen

Eine der stärksten Eigenschaften von Mock-Funktionen ist, dass sie sich jeden Aufruf merken. Sie können prüfen, wie oft eine Funktion aufgerufen wurde, welche Argumente sie erhalten hat und was sie zurückgegeben hat:

```js
import { expect, test, vi } from 'vitest'

test('inspecting mock calls', () => {
  const greet = vi.fn()

  greet('Alice')
  greet('Bob', 'Charlie')

  // Number of calls
  expect(greet).toHaveBeenCalledTimes(2)

  // Check specific arguments
  expect(greet).toHaveBeenCalledWith('Alice')
  expect(greet).toHaveBeenCalledWith('Bob', 'Charlie')

  // Check the arguments of a specific call by position
  expect(greet).toHaveBeenNthCalledWith(1, 'Alice')
  expect(greet).toHaveBeenLastCalledWith('Bob', 'Charlie')

  // Access the raw call data
  expect(greet.mock.calls).toEqual([
    ['Alice'],
    ['Bob', 'Charlie'],
  ])
})
```

Die Eigenschaft `.mock` gibt Ihnen vollen Zugriff auf die Aufrufhistorie. Neben `.mock.calls` können Sie auch `.mock.results` untersuchen, um zu sehen, was der Mock bei jedem Aufruf zurückgegeben (oder geworfen) hat:

```js
const double = vi.fn(x => x * 2)

double(5)
double(10)

expect(double.mock.results).toEqual([
  { type: 'return', value: 10 },
  { type: 'return', value: 20 },
])
```

::: warning
`.mock.calls` speichert Referenzen auf die Argumente, keine Kopien. Wenn Sie ein Objekt an einen Mock übergeben und es anschließend verändern, spiegelt der aufgezeichnete Aufruf den veränderten Zustand wider, nicht den Zustand zum Zeitpunkt des Aufrufs:

```js
const fn = vi.fn()
const obj = { count: 1 }

fn(obj)
obj.count = 2

// ❌ This fails! mock.calls[0][0].count is now 2, not 1
expect(fn).toHaveBeenCalledWith({ count: 1 })
```

Wenn Sie die ursprünglichen Werte prüfen müssen, können Sie mit `mockImplementation` zum Aufrufzeitpunkt einen Klon festhalten:

```js
const calls = []
const fn = vi.fn((obj) => {
  calls.push(structuredClone(obj))
})

const obj = { count: 1 }
fn(obj)
obj.count = 2

expect(calls[0]).toEqual({ count: 1 }) // ✅ passes
```

Alternativ können Sie Ihre Assertion vornehmen, bevor die Mutation stattfindet.
:::

## Methoden mit Spies überwachen

[`vi.spyOn`](/api/vi#vi-spyon) unterscheidet sich in einem wichtigen Punkt von `vi.fn()`. Statt eine völlig neue Funktion zu erzeugen, umschließt es eine *bestehende* Methode eines Objekts. Die ursprüngliche Implementierung funktioniert standardmäßig weiterhin, doch Sie können jeden Aufruf beobachten und das Verhalten optional überschreiben:

```js
import { expect, test, vi } from 'vitest'

const calculator = {
  add(a, b) {
    return a + b
  },
}

test('spy on a method', () => {
  const spy = vi.spyOn(calculator, 'add')

  // The original implementation still works
  expect(calculator.add(1, 2)).toBe(3)

  // But we can observe calls
  expect(spy).toHaveBeenCalledWith(1, 2)
  expect(spy).toHaveBeenCalledTimes(1)
})

test('spy can override implementation', () => {
  const spy = vi.spyOn(calculator, 'add')
  spy.mockReturnValue(42)

  expect(calculator.add(1, 2)).toBe(42)
})
```

Das ist besonders nützlich, wenn Sie überprüfen möchten, ob Ihr Code eine Methode korrekt aufruft, ohne deren Verhalten vollständig zu ersetzen.

## Mocks zurücksetzen

Mock-Funktionen sammeln im Laufe der Tests Zustand an. Sie merken sich jeden Aufruf, jeden Rückgabewert und jede eigene Implementierung, die Sie gesetzt haben. Setzen Sie sie zwischen Tests nicht zurück, kann dieser Zustand überlaufen und verwirrende Fehlschläge verursachen. Vitest bietet drei Stufen der Bereinigung:

- **[`mockClear()`](/api/mock#mockclear)** löscht die aufgezeichnete Aufrufhistorie und die Rückgabewerte, behält aber jede von Ihnen gesetzte eigene Implementierung bei
- **[`mockReset()`](/api/mock#mockreset)** tut alles, was `mockClear` tut, und entfernt zusätzlich jede eigene Implementierung, wodurch der Mock in seinen Standardzustand zurückkehrt
- **[`mockRestore()`](/api/mock#mockrestore)** ist speziell für mit `vi.spyOn` erzeugte Spies gedacht. Es stellt die ursprüngliche Objektmethode wieder her und macht den Spy damit rückgängig. Bei `vi.fn()`-Mocks verhält es sich wie `mockReset`

In der Praxis ist es am einfachsten, alle Mocks nach jedem Test automatisch wiederherzustellen:

```js
import { afterEach, expect, test, vi } from 'vitest'

const calculator = {
  add: (a, b) => a + b,
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('spy is restored after the test', () => {
  const spy = vi.spyOn(calculator, 'add').mockReturnValue(42)
  expect(calculator.add(1, 2)).toBe(42)
  // afterEach will restore calculator.add to the original implementation
})
```

Noch besser: Sie können das global über die Option [`restoreMocks`](/config/restoremocks) konfigurieren, sodass Sie das `afterEach` gar nicht benötigen:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    restoreMocks: true,
  },
})
```

## Module mocken

Manchmal müssen Sie ein [ganzes Modul](/guide/mocking/modules) ersetzen statt einer einzelnen Funktion. Zum Beispiel einen Datenbank-Client oder einen Logger, der während der Tests nicht laufen soll. Mit [`vi.mock`](/api/vi#vi-mock) können Sie die Exporte eines Moduls durch Mock-Implementierungen ersetzen:

```js
import { expect, test, vi } from 'vitest'
import { getUser } from './db.js'

vi.mock(import('./db.js'), () => ({
  getUser: vi.fn(),
}))

test('mock a module', () => {
  vi.mocked(getUser).mockReturnValue({ name: 'Alice' })

  const user = getUser(1)
  expect(user.name).toBe('Alice')
  expect(getUser).toHaveBeenCalledWith(1)
})
```

::: warning
Aufrufe von [`vi.mock`](/api/vi#vi-mock) werden an den Anfang der Datei gehoben. Sie laufen vor allen Importen. Das bedeutet, dass die gemockte Version bereits an Ort und Stelle ist, wenn Ihr Testcode ausgeführt wird.
:::

::: warning
Übergeben Sie stets `import('./db.js')` statt eines einfachen Strings `'./db.js'`. Bei Verwendung von `import()` kann TypeScript die Typen des Moduls ableiten, sodass der Rückgabewert der Factory-Funktion typgeprüft wird und `importOriginal` das korrekt typisierte Modul zurückgibt. Als Zugabe wird der Importpfad automatisch aktualisiert, wenn Sie die Datei in Ihrer IDE umbenennen oder verschieben. Mit einem String verlieren Sie sowohl die Typsicherheit als auch das automatische Refactoring.
:::

Vitest bietet ausführliche Anleitungen für spezielle Mocking-Szenarien:

- [Funktionen mocken](/guide/mocking/functions)
- [Module mocken](/guide/mocking/modules)
- [Timer mocken](/guide/mocking/timers)
- [Datumsangaben mocken](/guide/mocking/dates)
- [Globals mocken](/guide/mocking/globals)
- [Requests mocken](/guide/mocking/requests)
- [Das Dateisystem mocken](/guide/mocking/file-system)
- [Klassen mocken](/guide/mocking/classes)
