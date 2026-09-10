# Test

- **Alias:** `it`

```ts
function test(
  name: string | Function,
  body?: () => unknown,
  timeout?: number
): void
function test(
  name: string | Function,
  options: TestOptions,
  body?: () => unknown,
): void
```

`test` bzw. `it` definiert eine Reihe zusammengehöriger Erwartungen. Es erhält den Testnamen und eine Funktion, die die zu prüfenden Erwartungen enthält.

Optional können Sie ein Timeout (in Millisekunden) angeben, das festlegt, wie lange bis zum Abbruch gewartet wird, oder eine Reihe [zusätzlicher Optionen](#test-options). Das Standard-Timeout beträgt 5 Sekunden und lässt sich global über [`testTimeout`](/config/testtimeout) konfigurieren.

```ts
import { expect, test } from 'vitest'

test('should work as expected', () => {
  expect(Math.sqrt(4)).toBe(2)
})
```

::: warning
Ist das erste Argument eine Funktion, wird deren Eigenschaft `name` als Name des Tests verwendet. Die Funktion selbst wird nicht aufgerufen.

Wird kein Testkörper angegeben, wird der Test als `todo` markiert.
:::

Gibt eine Testfunktion ein Promise zurück, wartet der Runner, bis es aufgelöst ist, um asynchrone Erwartungen zu erfassen. Wird das Promise abgelehnt, schlägt der Test fehl.

::: tip
In Jest kann `TestFunction` auch vom Typ `(done: DoneCallback) => void` sein. Wird diese Form verwendet, gilt der Test erst als abgeschlossen, wenn `done` aufgerufen wurde. Dasselbe erreichen Sie mit einer `async`-Funktion, siehe den [Abschnitt „Done Callback“ im Migrationsleitfaden](/guide/migration#done-callback).
:::

## Test-Optionen

Boolesche Optionen können Sie definieren, indem Sie Eigenschaften an eine Funktion anketten:

```ts
import { test } from 'vitest'

test.skip('skipped test', () => {
  // some logic that fails right now
})

test.concurrent.skip('skipped concurrent test', () => {
  // some logic that fails right now
})
```

Sie können stattdessen aber auch ein Objekt als zweites Argument übergeben:

```ts
import { test } from 'vitest'

test('skipped test', { skip: true }, () => {
  // some logic that fails right now
})

test('skipped concurrent test', { skip: true, concurrent: true }, () => {
  // some logic that fails right now
})
```

Beide funktionieren exakt gleich. Welche Sie verwenden, ist reine Geschmackssache.

### timeout

- **Typ:** `number`
- **Standard:** `5_000` (konfiguriert über [`testTimeout`](/config/testtimeout))

Test-Timeout in Millisekunden.

::: warning
Beachten Sie: Wenn Sie das Timeout als letztes Argument angeben, können Sie keine Optionen mehr verwenden:

```ts
import { test } from 'vitest'

// ✅ this works
test.skip('heavy test', () => {
  // ...
}, 10_000)

// ❌ this doesn't work
test('heavy test', { skip: true }, () => {
  // ...
}, 10_000)
```

Sie können ein Timeout jedoch innerhalb des Objekts angeben:

```ts
import { test } from 'vitest'

// ✅ this works
test('heavy test', { skip: true, timeout: 10_000 }, () => {
  // ...
})
```
:::

### retry

- **Standard:** `0` (konfiguriert über [`retry`](/config/retry))
- **Typ:**

```ts
type Retry = number | {
  /**
   * The number of times to retry the test if it fails.
   * @default 0
   */
  count?: number
  /**
   * Delay in milliseconds between retry attempts.
   * @default 0
   */
  delay?: number
  /**
   * Condition to determine if a test should be retried based on the error.
   * - If a RegExp, it is tested against the error message
   * - If a function, called with the TestError object; return true to retry
   *
   * NOTE: Functions can only be used in test files, not in vitest.config.ts,
   * because the configuration is serialized when passed to worker threads.
   *
   * @default undefined (retry on all errors)
   */
  condition?: RegExp | ((error: TestError) => boolean)
}
```

Retry-Konfiguration für den Test. Bei einer Zahl gibt sie an, wie oft wiederholt wird. Bei einem Objekt erlaubt sie feingranulare Steuerung der Wiederholungen.

Beachten Sie, dass die Objektkonfiguration erst seit Vitest 4.1 verfügbar ist.

### repeats

- **Typ:** `number`
- **Standard:** `0`

Wie oft der Test erneut ausgeführt wird. Bei `0` (dem Standard) läuft der Test nur ein einziges Mal.

Das kann beim Debuggen flakiger Tests nützlich sein.

### tags <Version>4.1.0</Version> {#tags}

- **Typ:** `string[]`
- **Standard:** `[]`

Eigene [Tags](/guide/test-tags). Ist der Tag nicht in der [Konfiguration](/config/tags) angegeben, schlägt der Test fehl, bevor er startet, sofern [`strictTags`](/config/stricttags) nicht manuell deaktiviert wurde.

```ts
import { it } from 'vitest'

it('user returns data from db', { tags: ['db', 'flaky'] }, () => {
  // ...
})
```

### meta <Version>4.1.0</Version> {#meta}

- **Typ:** `TaskMeta`

Hängt eigene [Metadaten](/api/advanced/metadata) an, die in Reportern verfügbar sind.

::: warning
Vitest mergt Eigenschaften auf oberster Ebene, die von Suites oder Tags geerbt wurden. Ein tiefes Mergen verschachtelter Objekte findet jedoch nicht statt.

```ts
import { describe, test } from 'vitest'

describe(
  'nested meta',
  {
    meta: {
      nested: { object: true, array: false },
    },
  },
  () => {
    test(
      'overrides part of meta',
      {
        meta: {
          nested: { object: false }
        },
      },
      ({ task }) => {
        // task.meta === { nested: { object: false } }
        // notice array got lost because "nested" object was overridden
      }
    )
  }
)
```

Verwenden Sie nach Möglichkeit nicht verschachtelte Meta-Daten.
:::

### concurrent

- **Typ:** `boolean`
- **Standard:** `false` (konfiguriert über [`sequence.concurrent`](/config/sequence#sequence-concurrent))
- **Alias:** [`test.concurrent`](#test-concurrent)

Ob dieser Test nebenläufig zu anderen nebenläufigen Tests der Suite ausgeführt wird.

Setzen Sie `concurrent` auf `false`, um die von [`describe.concurrent`](/api/describe#describe-concurrent) oder [`sequence.concurrent`](/config/sequence#sequence-concurrent) geerbte Nebenläufigkeit abzuwählen:

```ts
test('runs sequentially', { concurrent: false }, async () => {
  // ...
})
```

### skip

- **Typ:** `boolean`
- **Standard:** `false`
- **Alias:** [`test.skip`](#test-skip)

Ob der Test übersprungen werden soll.

### only

- **Typ:** `boolean`
- **Standard:** `false`
- **Alias:** [`test.only`](#test-only)

Ob dieser Test als einziger in einer Suite laufen soll.

### todo

- **Typ:** `boolean`
- **Standard:** `false`
- **Alias:** [`test.todo`](#test-todo)

Ob der Test übersprungen und als Todo markiert werden soll.

### fails

- **Typ:** `boolean`
- **Standard:** `false`
- **Alias:** [`test.fails`](#test-fails)

Ob erwartet wird, dass der Test fehlschlägt. Tut er das, gilt der Test als bestanden, andernfalls schlägt er fehl.

## test.extend

- **Alias:** `it.extend`

Verwenden Sie `test.extend`, um den Testkontext um eigene Fixtures zu erweitern. Das gibt ein neues `test` zurück, das ebenfalls erweiterbar ist, sodass Sie weitere Fixtures zusammensetzen oder bestehende überschreiben können, indem Sie es nach Bedarf erweitern. Weitere Informationen finden Sie unter [Testkontext erweitern](/guide/test-context#extend-test-context).

```ts
import { test as baseTest, expect } from 'vitest'

export const test = baseTest
  // Simple value - type is inferred as { port: number; host: string }
  .extend('config', { port: 3000, host: 'localhost' })
  // Function fixture - type is inferred from return value
  .extend('server', async ({ config }) => {
    // TypeScript knows config is { port: number; host: string }
    return `http://${config.host}:${config.port}`
  })

test('server uses correct port', ({ config, server }) => {
  // TypeScript knows the types:
  // - config is { port: number; host: string }
  // - server is string
  expect(server).toBe('http://localhost:3000')
  expect(config.port).toBe(3000)
})
```

## test.override <Version>4.1.0</Version> {#test-override}

Verwenden Sie `test.override`, um Fixture-Werte für alle Tests innerhalb der aktuellen Suite und ihrer verschachtelten Suites zu überschreiben. Das muss auf der obersten Ebene eines `describe`-Blocks aufgerufen werden. Weitere Informationen finden Sie unter [Fixture-Werte überschreiben](/guide/test-context.html#overriding-fixture-values).

```ts
import { test as baseTest, describe, expect } from 'vitest'

const test = baseTest
  .extend('dependency', 'default')
  .extend('dependant', ({ dependency }) => dependency)

describe('use scoped values', () => {
  test.override({ dependency: 'new' })

  test('uses scoped value', ({ dependant }) => {
    // `dependant` uses the new overridden value that is scoped
    // to all tests in this suite
    expect(dependant).toEqual({ dependency: 'new' })
  })
})
```

## test.scoped <Version>3.1.0</Version> <Deprecated /> {#test-scoped}

- **Alias:** `it.scoped`

::: danger DEPRECATED
`test.scoped` ist zugunsten von [`test.override`](#test-override) deprecated und wird in einer künftigen Major-Version entfernt.
:::

Alias von [`test.override`](#test-override)

## test.skip

- **Alias:** `it.skip`

Wenn Sie bestimmte Tests nicht ausführen, den Code aber aus irgendeinem Grund nicht löschen möchten, können Sie `test.skip` verwenden, um ihre Ausführung zu vermeiden.

```ts
import { assert, test } from 'vitest'

test.skip('skipped test', () => {
  // Test skipped, no error
  assert.equal(Math.sqrt(4), 3)
})
```

Sie können einen Test auch dynamisch überspringen, indem Sie `skip` auf seinem [Kontext](/guide/test-context) aufrufen:

```ts
import { assert, test } from 'vitest'

test('skipped test', (context) => {
  context.skip()
  // Test skipped, no error
  assert.equal(Math.sqrt(4), 3)
})
```

Ist die Bedingung unbekannt, können Sie sie der Methode `skip` als erstes Argument übergeben:

```ts
import { assert, test } from 'vitest'

test('skipped test', (context) => {
  context.skip(Math.random() < 0.5, 'optional message')
  // Test skipped, no error
  assert.equal(Math.sqrt(4), 3)
})
```

## test.skipIf

- **Alias:** `it.skipIf`

In manchen Fällen führen Sie Tests mehrfach in verschiedenen Umgebungen aus, und einige der Tests sind umgebungsspezifisch. Statt den Testcode mit `if` zu umschließen, können Sie `test.skipIf` verwenden, um den Test zu überspringen, sobald die Bedingung truthy ist.

```ts
import { assert, test } from 'vitest'

const isDev = process.env.NODE_ENV === 'development'

test.skipIf(isDev)('prod only test', () => {
  // this test only runs in production
})
```

## test.runIf

- **Alias:** `it.runIf`

Das Gegenteil von [test.skipIf](#test-skipif).

```ts
import { assert, test } from 'vitest'

const isDev = process.env.NODE_ENV === 'development'

test.runIf(isDev)('dev only test', () => {
  // this test only runs in development
})
```

## test.only

- **Alias:** `it.only`

Verwenden Sie `test.only`, um in einer bestimmten Suite nur bestimmte Tests auszuführen. Das ist beim Debuggen nützlich.

```ts
import { assert, test } from 'vitest'

test.only('test', () => {
  // Only this test (and others marked with only) are run
  assert.equal(Math.sqrt(4), 2)
})
```

Manchmal ist es sehr nützlich, `only`-Tests in einer bestimmten Datei auszuführen und alle anderen Tests der gesamten Test-Suite zu ignorieren, die die Ausgabe zumüllen.

Führen Sie dazu `vitest` mit der konkreten Datei aus, die die betreffenden Tests enthält:

```shell
vitest interesting.test.ts
```

::: warning
Vitest erkennt, wenn Tests in CI laufen, und wirft einen Fehler, sobald ein Test das `only`-Flag trägt. Dieses Verhalten lässt sich über die Option [`allowOnly`](/config/allowonly) konfigurieren.
:::

## test.concurrent

- **Alias:** `it.concurrent`

`test.concurrent` markiert aufeinanderfolgende Tests zur parallelen Ausführung. Es erhält den Testnamen, eine asynchrone Funktion mit den zu erfassenden Tests und ein optionales Timeout (in Millisekunden).

```ts
import { describe, test } from 'vitest'

// The two tests marked with concurrent will be run in parallel
describe('suite', () => {
  test('serial test', async () => { /* ... */ })
  test.concurrent('concurrent test 1', async () => { /* ... */ })
  test.concurrent('concurrent test 2', async () => { /* ... */ })
})
```

`test.skip`, `test.only` und `test.todo` funktionieren mit nebenläufigen Tests. Alle folgenden Kombinationen sind gültig:

```ts
test.concurrent(/* ... */)
test.skip.concurrent(/* ... */) // or test.concurrent.skip(/* ... */)
test.only.concurrent(/* ... */) // or test.concurrent.only(/* ... */)
test.todo.concurrent(/* ... */) // or test.concurrent.todo(/* ... */)
```

Beim Ausführen nebenläufiger Tests müssen Snapshots und Assertions das `expect` aus dem lokalen [Testkontext](/guide/test-context.md) verwenden, damit der richtige Test erkannt wird.

```ts
test.concurrent('test 1', async ({ expect }) => {
  expect(foo).toMatchSnapshot()
})
test.concurrent('test 2', async ({ expect }) => {
  expect(foo).toMatchSnapshot()
})
```

Beachten Sie: Sind die Tests synchron, führt Vitest sie dennoch nacheinander aus.

## test.todo

- **Alias:** `it.todo`

Verwenden Sie `test.todo`, um Tests zu skizzieren, die später implementiert werden. Im Report erscheint ein Eintrag für diese Tests, sodass Sie wissen, wie viele Tests Sie noch implementieren müssen.

```ts
// An entry will be shown in the report for this test
test.todo('unimplemented test', () => {
  // failing implementation...
})
```

::: tip
Vitest markiert einen Test automatisch als `todo`, wenn er keinen Körper hat.
:::

## test.fails

- **Alias:** `it.fails`

Verwenden Sie `test.fails`, um explizit anzugeben, dass eine Assertion fehlschlagen wird.

```ts
import { expect, test } from 'vitest'

test.fails('repro #1234', () => {
  expect(add(1, 2)).toBe(4)
})
```

Dieses Flag ist nützlich, um Verhaltensunterschiede Ihrer Bibliothek über die Zeit zu verfolgen. Sie können beispielsweise einen fehlschlagenden Test definieren, ohne das Problem aus Zeitgründen bereits zu beheben. Mit `fails` markierte Tests werden seit Vitest 4.1 in der Testzusammenfassung ausgewiesen.

## test.each

- **Alias:** `it.each`

::: tip
Während `test.each` der Jest-Kompatibilität dient,
bietet Vitest auch [`test.for`](#test-for) mit einer zusätzlichen Funktion zur Einbindung des [`TestContext`](/guide/test-context).
:::

Verwenden Sie `test.each`, wenn Sie denselben Test mit unterschiedlichen Variablen ausführen müssen.
Sie können Parameter mit [printf-Formatierung](https://nodejs.org/api/util.html#util_util_format_format_args) im Testnamen einsetzen, in der Reihenfolge der Parameter der Testfunktion.

- `%s`: String
- `%d`: Zahl
- `%i`: Ganzzahl
- `%f`: Gleitkommawert
- `%j`: JSON
- `%o`: Objekt
- `%#`: 0-basierter Index des Testfalls
- `%$`: 1-basierter Index des Testfalls
- `%%`: einzelnes Prozentzeichen ('%')

```ts
import { expect, test } from 'vitest'

test.each([
  [1, 1, 2],
  [1, 2, 3],
  [2, 1, 3],
])('add(%i, %i) -> %i', (a, b, expected) => {
  expect(a + b).toBe(expected)
})

// this will return
// ✓ add(1, 1) -> 2
// ✓ add(1, 2) -> 3
// ✓ add(2, 1) -> 3
```

Mit dem Präfix `$` können Sie auch auf Objekteigenschaften und Array-Elemente zugreifen:

```ts
test.each([
  { a: 1, b: 1, expected: 2 },
  { a: 1, b: 2, expected: 3 },
  { a: 2, b: 1, expected: 3 },
])('add($a, $b) -> $expected', ({ a, b, expected }) => {
  expect(a + b).toBe(expected)
})

// this will return
// ✓ add(1, 1) -> 2
// ✓ add(1, 2) -> 3
// ✓ add(2, 1) -> 3

test.each([
  [1, 1, 2],
  [1, 2, 3],
  [2, 1, 3],
])('add($0, $1) -> $2', (a, b, expected) => {
  expect(a + b).toBe(expected)
})

// this will return
// ✓ add(1, 1) -> 2
// ✓ add(1, 2) -> 3
// ✓ add(2, 1) -> 3
```

Wenn Sie Objekte als Argumente verwenden, können Sie über `.` auch auf Objektattribute zugreifen:

  ```ts
  test.each`
  a               | b      | expected
  ${{ val: 1 }}   | ${'b'} | ${'1b'}
  ${{ val: 2 }}   | ${'b'} | ${'2b'}
  ${{ val: 3 }}   | ${'b'} | ${'3b'}
  `('add($a.val, $b) -> $expected', ({ a, b, expected }) => {
    expect(a.val + b).toBe(expected)
  })

  // this will return
  // ✓ add(1, b) -> 1b
  // ✓ add(2, b) -> 2b
  // ✓ add(3, b) -> 3b
  ```

* Die erste Zeile sollte die Spaltennamen enthalten, getrennt durch `|`;
* Eine oder mehrere nachfolgende Datenzeilen, angegeben als Template-Literal-Ausdrücke mit der `${value}`-Syntax.

```ts
import { expect, test } from 'vitest'

test.each`
  a               | b      | expected
  ${1}            | ${1}   | ${2}
  ${'a'}          | ${'b'} | ${'ab'}
  ${[]}           | ${'b'} | ${'b'}
  ${{}}           | ${'b'} | ${'[object Object]b'}
  ${{ asd: 1 }}   | ${'b'} | ${'[object Object]b'}
`('returns $expected when $a is added $b', ({ a, b, expected }) => {
  expect(a + b).toBe(expected)
})
```

::: tip
Vitest formatiert interpolierte Titelwerte mit seinem Display-Formatter. Ist der Wert zu stark gekürzt, können Sie [taskTitleValueFormatTruncate](/config/tasktitlevalueformattruncate) in Ihrer Konfigurationsdatei erhöhen.
:::

## test.for

- **Alias:** `it.for`

Alternative zu `test.each`, die den [`TestContext`](/guide/test-context) bereitstellt.

Der Unterschied zu `test.each` liegt darin, wie Arrays in den Argumenten übergeben werden.
Argumente an `test.for`, die keine Arrays sind (einschließlich der Template-String-Nutzung), funktionieren exakt wie bei `test.each`.

```ts
// `each` spreads arrays
test.each([
  [1, 1, 2],
  [1, 2, 3],
  [2, 1, 3],
])('add(%i, %i) -> %i', (a, b, expected) => { // [!code --]
  expect(a + b).toBe(expected)
})

// `for` doesn't spread arrays (notice the square brackets around the arguments)
test.for([
  [1, 1, 2],
  [1, 2, 3],
  [2, 1, 3],
])('add(%i, %i) -> %i', ([a, b, expected]) => { // [!code ++]
  expect(a + b).toBe(expected)
})
```

Das zweite Argument ist der [`TestContext`](/guide/test-context) und lässt sich beispielsweise für nebenläufige Snapshots verwenden:

```ts
test.concurrent.for([
  [1, 1],
  [1, 2],
  [2, 1],
])('add(%i, %i)', ([a, b], { expect }) => {
  expect(a + b).toMatchSnapshot()
})
```

## test.describe <Version>4.1.0</Version> {#test-describe}

Gescoptes `describe`. Weitere Informationen finden Sie unter [describe](/api/describe).

## test.suite <Version>4.1.0</Version> {#test-suite}

Alias für `suite`. Weitere Informationen finden Sie unter [describe](/api/describe).

## test.beforeEach

Gescopter `beforeEach`-Hook, der Typen von [`test.extend`](#test-extend) erbt. Weitere Informationen finden Sie unter [beforeEach](/api/hooks#beforeeach).

## test.afterEach

Gescopter `afterEach`-Hook, der Typen von [`test.extend`](#test-extend) erbt. Weitere Informationen finden Sie unter [afterEach](/api/hooks#aftereach).

## test.beforeAll

Gescopter `beforeAll`-Hook, der Typen von [`test.extend`](#test-extend) erbt. Weitere Informationen finden Sie unter [beforeAll](/api/hooks#beforeall).

## test.afterAll

Gescopter `afterAll`-Hook, der Typen von [`test.extend`](#test-extend) erbt. Weitere Informationen finden Sie unter [afterAll](/api/hooks#afterall).

## test.aroundEach <Version>4.1.0</Version> {#test-aroundeach}

Gescopter `aroundEach`-Hook, der Typen von [`test.extend`](#test-extend) erbt. Weitere Informationen finden Sie unter [aroundEach](/api/hooks#aroundeach).

## test.aroundAll <Version>4.1.0</Version> {#test-aroundall}

Gescopter `aroundAll`-Hook, der Typen von [`test.extend`](#test-extend) erbt. Weitere Informationen finden Sie unter [aroundAll](/api/hooks#aroundall).

## bench <Experimental /> {#bench}

::: warning Aktualisiert in Vitest 5
Die Benchmarking-API wurde neu geschrieben. `bench` ist kein Top-Level-Import aus `vitest` mehr, und die Helfer `bench.skip` / `bench.only` / `bench.todo` wurden entfernt. `bench` ist nun eine [Test-Context-Fixture](/guide/test-context#bench), die aus einem `test()` heraus angesprochen wird.

Die neue API beschreibt der [Benchmarking-Leitfaden](/guide/benchmarking).
:::
