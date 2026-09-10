# Matcher erweitern

Da Vitest sowohl zu Chai als auch zu Jest kompatibel ist, können Sie ganz nach Vorliebe entweder die [`chai.use`](https://www.chaijs.com/guide/plugins/)-API oder `expect.extend` verwenden.

Diese Anleitung behandelt das Erweitern von Matchern mit `expect.extend`. Wenn Sie sich für die API von Chai interessieren, sehen Sie sich [deren Anleitung](https://www.chaijs.com/guide/plugins/) an.

Um die Standard-Matcher zu erweitern, rufen Sie `expect.extend` mit einem Objekt auf, das Ihre Matcher enthält.

```ts
expect.extend({
  toBeFoo(received) {
    const { isNot } = this
    return {
      // do not alter your "pass" based on isNot. Vitest does it for you
      pass: received === 'foo',
      message: () => `${received} is${isNot ? ' not' : ''} foo`
    }
  }
})
```

Wenn Sie TypeScript verwenden, können Sie das Standard-Interface `Matchers` in einer Ambient-Deklarationsdatei (z. B. `vitest.d.ts`) mit dem folgenden Code erweitern:

```ts
import 'vitest'

declare module 'vitest' {
  interface Matchers<R, T> {
    toBeFoo: () => R
  }
}
```

`R` ist der Rückgabetyp der Assertion und `T` der Typ des empfangenen Werts.

Geben Sie `R` aus Matchern zurück, die synchron laufen. Damit ist der Rückgabetyp `void` für eine gewöhnliche Assertion und `Promise<void>`, wenn die Assertion mit `.resolves`, `.rejects`, [`expect.poll`](/api/expect#poll) oder [`expect.element`](/api/browser/assertions) verwendet wird. `T` können Sie nutzen, wenn ein erwartetes Argument denselben Typ wie der empfangene Wert haben soll:

```ts
declare module 'vitest' {
  interface Matchers<R, T> {
    toEqualTyped: (expected: T) => R
  }
}
```

::: tip
Der Import von `vitest` lässt TypeScript diese Datei als ES-Modul betrachten; ohne ihn funktioniert die Typdeklaration nicht.
:::

Das Erweitern des `Matchers`-Interface fügt gleichzeitig Typen für `expect.extend`, `expect().*` und die `expect.*`-Methoden hinzu.

::: warning
Vergessen Sie nicht, die Ambient-Deklarationsdatei in Ihrer `tsconfig.json` einzubinden.
:::

Der Rückgabewert eines Matchers sollte zu den folgenden Typen kompatibel sein:

```ts
interface SyncMatcherResult {
  pass: boolean
  message: () => string
  // If you pass these, they will automatically appear inside a diff when
  // the matcher does not pass, so you don't need to print the diff yourself
  actual?: unknown
  expected?: unknown
  meta?: object
}

type MatcherResult = SyncMatcherResult | Promise<SyncMatcherResult>
```

::: warning
Wenn die Implementierung eines Matchers asynchron ist, deklarieren Sie seinen Rückgabetyp als `Promise<void>` statt als `R` und vergessen Sie nicht, ihn im Test mit `await` abzuwarten:

```ts
expect.extend({
  async toBeAsyncAssertion(received) {
    return {
      pass: received === 'foo',
      message: () => `expected ${received} to be foo`,
    }
  }
})

declare module 'vitest' {
  interface Matchers<R, T> {
    toBeAsyncAssertion: () => Promise<void>
  }
}

await expect('foo').toBeAsyncAssertion()
```
:::

Das erste Argument innerhalb der Funktion eines Matchers ist der empfangene Wert (derjenige innerhalb von `expect(received)`). Die übrigen sind Argumente, die direkt an den Matcher übergeben werden. Seit Version 4.1 stellt Vitest mehrere Typen bereit, die Ihr eigener Matcher verwenden kann:

```ts
import type {
  // the function type
  Matcher,
  // the return value
  MatcherResult,
  // state available as `this`
  MatcherState,
} from 'vitest'
import { expect } from 'vitest'

// a simple matcher, using "function" to have access to "this"
const customMatcher: Matcher = function (received) {
  // ...
}

// a matcher with arguments
const customMatcher: Matcher<MatcherState, [arg1: unknown, arg2: unknown]> = function (received, arg1, arg2) {
  // ...
}

// a matcher with custom annotations
function customMatcher(this: MatcherState, received: unknown, arg1: unknown, arg2: unknown): MatcherResult {
  // ...
  return {
    pass: false,
    message: () => 'something went wrong!',
  }
}

expect.extend({ customMatcher })
```

::: tip
Um eigene **Snapshot-Matcher** zu bauen (Wrapper um `toMatchSnapshot()` / `toMatchInlineSnapshot()` / `toMatchFileSnapshot()`), verwenden Sie das von `vitest` exportierte `Snapshots`. Siehe [Eigene Snapshot-Matcher](/guide/snapshot#custom-snapshot-matchers).
:::

Die Matcher-Funktion hat Zugriff auf den `this`-Kontext mit den folgenden Eigenschaften:

## `isNot`

Gibt `true` zurück, wenn der Matcher auf `not` aufgerufen wurde (`expect(received).not.toBeFoo()`). Sie müssen das nicht berücksichtigen – Vitest kehrt den Wert von `pass` automatisch um.

## `promise`

Wurde der Matcher auf `resolved`/`rejected` aufgerufen, enthält dieser Wert den Namen des Modifikators. Andernfalls ist er ein leerer String.

## `equals`

Dies ist eine Hilfsfunktion, mit der Sie zwei Werte vergleichen können. Sie gibt `true` zurück, wenn die Werte gleich sind, andernfalls `false`. Diese Funktion wird intern von nahezu jedem Matcher verwendet. Sie unterstützt Objekte mit asymmetrischen Matchern standardmäßig.

## `utils`

Enthält eine Reihe von Hilfsfunktionen, mit denen Sie Meldungen darstellen können.

Der `this`-Kontext enthält außerdem Informationen über den aktuellen Test. Sie erhalten diese auch durch einen Aufruf von `expect.getState()`. Die nützlichsten Eigenschaften sind:

## `currentTestName`

Vollständiger Name des aktuellen Tests (einschließlich des describe-Blocks).

## `task` <Advanced /> <Version>4.1.0</Version> {#task}

Enthält, sofern verfügbar, eine Referenz auf [die `Test`-Runner-Task](/api/advanced/runner#tasks).

::: warning
Bei Verwendung des globalen `expect` mit nebenläufigen Tests ist `this.task` `undefined`. Verwenden Sie stattdessen `context.expect`, damit `task` in eigenen Matchern verfügbar ist.
:::

## `testPath`

Dateipfad zum aktuellen Test.

## `environment`

Der Name der aktuellen [`environment`](/config/environment) (zum Beispiel `jsdom`).

## `soft`

Ob die Assertion als [`soft`](/api/expect#soft) aufgerufen wurde. Sie müssen das nicht berücksichtigen – Vitest fängt den Fehler immer ab.

## `assertion` <Advanced /> <Version>5.0.0</Version> {#assertion}

Das zugrunde liegende [Chai-Assertion](https://www.chaijs.com/guide/plugins/)-Objekt. Es ist dieselbe Instanz, die auch Chai-Plugins erhalten, und gibt Ihnen Zugriff auf Chais Flag-System und verkettbare Methoden. Das kann beim Bau eigener Matcher nützlich sein, die mit Chais Interna interagieren müssen.

::: tip
Das sind nicht alle verfügbaren Eigenschaften, sondern nur die nützlichsten. Die übrigen Zustandswerte verwendet Vitest intern.
:::
