# Mocking

::: tip
Neu beim Thema Mocking? Beginne mit dem Tutorial [Mock-Funktionen](/guide/learn/mock-functions) für eine praxisnahe Einführung in `vi.fn`, `vi.spyOn` und `vi.mock`.
:::

Beim Schreiben von Tests ist es nur eine Frage der Zeit, bis du eine "gefälschte" Version eines internen — oder externen — Dienstes erstellen musst. Das wird üblicherweise als **Mocking** bezeichnet. Vitest stellt dir über seinen `vi`-Helper Hilfsfunktionen dafür bereit. Du kannst ihn aus `vitest` importieren oder global darauf zugreifen, wenn die [`global`-Konfiguration](/config/globals) aktiviert ist.

::: warning
Denke immer daran, Mocks vor oder nach jedem Testlauf zurückzusetzen oder wiederherzustellen, um Änderungen am Mock-Zustand zwischen den Läufen rückgängig zu machen! Weitere Informationen findest du in der Dokumentation zu [`mockReset`](/api/mock#mockreset).
:::

Wenn dir die Methoden `vi.fn`, `vi.mock` oder `vi.spyOn` nicht vertraut sind, sieh dir zuerst den [API-Abschnitt](/api/vi) an.

Vitest bietet eine umfangreiche Liste von Leitfäden rund um das Mocking:

- [Klassen mocken](/guide/mocking/classes.md)
- [Datumsangaben mocken](/guide/mocking/dates.md)
- [Das Dateisystem mocken](/guide/mocking/file-system.md)
- [Funktionen mocken](/guide/mocking/functions.md)
- [Globals mocken](/guide/mocking/globals.md)
- [Module mocken](/guide/mocking/modules.md)
- [Requests mocken](/guide/mocking/requests.md)
- [Timer mocken](/guide/mocking/timers.md)

Für einen einfacheren und schnelleren Einstieg ins Mocking kannst du dir das Cheat Sheet weiter unten ansehen.

## Cheat Sheet

Ich möchte …

### Exportierte Variablen mocken
```js [example.js]
export const getter = 'variable'
```
```ts [example.test.ts]
import * as exports from './example.js'

vi.spyOn(exports, 'getter', 'get').mockReturnValue('mocked')
```

::: warning
Das funktioniert im Browser-Modus nicht. Einen Workaround findest du unter [Einschränkungen](/guide/browser/#spying-on-module-exports).
:::

### Eine exportierte Funktion mocken

1. Beispiel mit `vi.mock`:

::: warning
Vergiss nicht, dass ein `vi.mock`-Aufruf an den Anfang der Datei gehoben wird. Er wird immer vor allen Imports ausgeführt.
:::

```ts [example.js]
export function method() {}
```
```ts
import { method } from './example.js'

vi.mock('./example.js', () => ({
  method: vi.fn()
}))
```

2. Beispiel mit `vi.spyOn`:
```ts
import * as exports from './example.js'

vi.spyOn(exports, 'method').mockImplementation(() => {})
```

::: warning
Das Beispiel mit `vi.spyOn` funktioniert im Browser-Modus nicht. Einen Workaround findest du unter [Einschränkungen](/guide/browser/#spying-on-module-exports).
:::

### Die Implementierung einer exportierten Klasse mocken

1. Beispiel mit einer gefälschten `class`:
```ts [example.js]
export class SomeClass {}
```
```ts
import { SomeClass } from './example.js'

vi.mock(import('./example.js'), () => {
  const SomeClass = vi.fn(class FakeClass {
    someMethod = vi.fn()
  })
  return { SomeClass }
})
```

2. Beispiel mit `vi.spyOn`:

```ts
import * as mod from './example.js'

vi.spyOn(mod, 'SomeClass').mockImplementation(class FakeClass {
  someMethod = vi.fn()
})
```

::: warning
Das Beispiel mit `vi.spyOn` funktioniert im Browser-Modus nicht. Einen Workaround findest du unter [Einschränkungen](/guide/browser/#spying-on-module-exports).
:::

### Ein von einer Funktion zurückgegebenes Objekt ausspähen

1. Beispiel mit Cache:

```ts [example.js]
export function useObject() {
  return { method: () => true }
}
```

```ts [useObject.js]
import { useObject } from './example.js'

const obj = useObject()
obj.method()
```

```ts [useObject.test.js]
import { useObject } from './example.js'

vi.mock(import('./example.js'), () => {
  let _cache
  const useObject = () => {
    if (!_cache) {
      _cache = {
        method: vi.fn(),
      }
    }
    // now every time that useObject() is called it will
    // return the same object reference
    return _cache
  }
  return { useObject }
})

const obj = useObject()
// obj.method was called inside some-path
expect(obj.method).toHaveBeenCalled()
```

### Einen Teil eines Moduls mocken

```ts
import { mocked, original } from './some-path.js'

vi.mock(import('./some-path.js'), async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    mocked: vi.fn()
  }
})
original() // has original behaviour
mocked() // is a spy function
```

::: warning
Vergiss nicht, dass damit nur der [_externe_ Zugriff gemockt wird](/guide/mocking/modules#mocking-modules-pitfalls). Wenn `original` in diesem Beispiel intern `mocked` aufruft, wird immer die im Modul definierte Funktion aufgerufen, nicht die aus der Mock-Factory.
:::

### Das aktuelle Datum mocken

Um die Zeit von `Date` und `Temporal` zu mocken, kannst du die Hilfsfunktion `vi.setSystemTime` verwenden. Dieser Wert wird zwischen verschiedenen Tests **nicht** automatisch zurückgesetzt.

Beachte, dass auch die Verwendung von `vi.useFakeTimers` die Zeit von `Date` verändert.

```ts
const mockDate = new Date(2022, 0, 1)
vi.setSystemTime(mockDate)
const now = new Date()
expect(now.valueOf()).toBe(mockDate.valueOf())
const nowInstant = Temporal.Now.instant()
expect(nowInstant.epochMilliseconds).toBe(mockDate.valueOf())
// reset mocked time
vi.useRealTimers()
```

### Eine globale Variable mocken

Du kannst eine globale Variable setzen, indem du `globalThis` einen Wert zuweist oder den Helper [`vi.stubGlobal`](/api/vi#vi-stubglobal) verwendest. Bei `vi.stubGlobal` wird der Wert zwischen verschiedenen Tests **nicht** automatisch zurückgesetzt, es sei denn, du aktivierst die Konfigurationsoption [`unstubGlobals`](/config/unstubglobals) oder rufst [`vi.unstubAllGlobals`](/api/vi#vi-unstuballglobals) auf.

```ts
vi.stubGlobal('__VERSION__', '1.0.0')
expect(__VERSION__).toBe('1.0.0')
```

### `import.meta.env` mocken

1. Um eine Umgebungsvariable zu ändern, kannst du ihr einfach einen neuen Wert zuweisen.

::: warning
Der Wert der Umgebungsvariablen wird zwischen verschiedenen Tests **_nicht_** automatisch zurückgesetzt.
:::

```ts
import { beforeEach, expect, it } from 'vitest'

// you can reset it in beforeEach hook manually
const originalViteEnv = import.meta.env.VITE_ENV

beforeEach(() => {
  import.meta.env.VITE_ENV = originalViteEnv
})

it('changes value', () => {
  import.meta.env.VITE_ENV = 'staging'
  expect(import.meta.env.VITE_ENV).toBe('staging')
})
```

2. Wenn du die Werte automatisch zurücksetzen lassen möchtest, kannst du den Helper `vi.stubEnv` zusammen mit der aktivierten Konfigurationsoption [`unstubEnvs`](/config/unstubenvs) verwenden (oder [`vi.unstubAllEnvs`](/api/vi#vi-unstuballenvs) manuell in einem `beforeEach`-Hook aufrufen):

```ts
import { expect, it, vi } from 'vitest'

// before running tests "VITE_ENV" is "test"
import.meta.env.VITE_ENV === 'test'

it('changes value', () => {
  vi.stubEnv('VITE_ENV', 'staging')
  expect(import.meta.env.VITE_ENV).toBe('staging')
})

it('the value is restored before running an other test', () => {
  expect(import.meta.env.VITE_ENV).toBe('test')
})
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    unstubEnvs: true,
  },
})
```
