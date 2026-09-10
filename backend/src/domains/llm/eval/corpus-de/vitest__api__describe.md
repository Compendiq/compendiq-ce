# describe

- **Alias:** `suite`

```ts
function describe(
  name: string | Function,
  body?: () => unknown,
  timeout?: number
): void
function describe(
  name: string | Function,
  options: SuiteOptions,
  body?: () => unknown,
): void
```

`describe` wird verwendet, um verwandte Tests und Benchmarks zu einer Suite zu gruppieren. Suites helfen dabei, deine Testdateien zu organisieren, indem sie logische Blöcke bilden, die Testausgabe lesbarer machen und gemeinsames Setup/Teardown über [Lifecycle-Hooks](/api/hooks) ermöglichen.

Wenn du `test` auf oberster Ebene einer Datei verwendest, werden diese als Teil der impliziten Suite dieser Datei erfasst. Mit `describe` kannst du im aktuellen Kontext eine neue Suite definieren, als Menge verwandter Tests oder Benchmarks und weiterer verschachtelter Suites.

```ts [basic.spec.ts]
import { describe, expect, test } from 'vitest'

const person = {
  isActive: true,
  age: 32,
}

describe('person', () => {
  test('person is defined', () => {
    expect(person).toBeDefined()
  })

  test('is active', () => {
    expect(person.isActive).toBeTruthy()
  })

  test('age limit', () => {
    expect(person.age).toBeLessThanOrEqual(32)
  })
})
```

Du kannst `describe`-Blöcke auch verschachteln, wenn du eine Hierarchie von Tests hast:

```ts
import { describe, expect, test } from 'vitest'

function numberToCurrency(value: number | string) {
  if (typeof value !== 'number') {
    throw new TypeError('Value must be a number')
  }

  return value.toFixed(2).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

describe('numberToCurrency', () => {
  describe('given an invalid number', () => {
    test('composed of non-numbers to throw error', () => {
      expect(() => numberToCurrency('abc')).toThrow()
    })
  })

  describe('given a valid number', () => {
    test('returns the correct currency format', () => {
      expect(numberToCurrency(10000)).toBe('10,000.00')
    })
  })
})
```

## Test-Optionen

Du kannst [Test-Optionen](/api/test#test-options) verwenden, um jede Konfiguration auf jeden Test innerhalb einer Suite anzuwenden, einschließlich verschachtelter Suites. Das ist nützlich, wenn du Timeouts, Wiederholungen oder andere Optionen für eine Gruppe verwandter Tests setzen möchtest.

```ts
import { describe, test } from 'vitest'

describe('slow tests', { timeout: 10_000 }, () => {
  test('test 1', () => { /* ... */ })
  test('test 2', () => { /* ... */ })

  // nested suites also inherit the timeout
  describe('nested', () => {
    test('test 3', () => { /* ... */ })
  })
})
```

### `shuffle`

- **Typ:** `boolean`
- **Standard:** `false` (konfiguriert über [`sequence.shuffle`](/config/sequence#sequence-shuffle))
- **Alias:** [`describe.shuffle`](#describe-shuffle)

Führt Tests innerhalb der Suite in zufälliger Reihenfolge aus. Diese Option wird an verschachtelte Suites vererbt.

```ts
import { describe, test } from 'vitest'

describe('randomized tests', { shuffle: true }, () => {
  test('test 1', () => { /* ... */ })
  test('test 2', () => { /* ... */ })
  test('test 3', () => { /* ... */ })
})
```

## describe.skip

- **Alias:** `suite.skip`

Verwende `describe.skip` in einer Suite, um einen bestimmten describe-Block nicht auszuführen.

```ts
import { assert, describe, test } from 'vitest'

describe.skip('skipped suite', () => {
  test('sqrt', () => {
    // Suite skipped, no error
    assert.equal(Math.sqrt(4), 3)
  })
})
```

## describe.skipIf

- **Alias:** `suite.skipIf`

In manchen Fällen führst du Suites mehrfach in unterschiedlichen Umgebungen aus, und einige der Suites sind möglicherweise umgebungsspezifisch. Statt die Suite mit `if` zu umschließen, kannst du `describe.skipIf` verwenden, um die Suite zu überspringen, sobald die Bedingung truthy ist.

```ts
import { describe, test } from 'vitest'

const isDev = process.env.NODE_ENV === 'development'

describe.skipIf(isDev)('prod only test suite', () => {
  // this test suite only runs in production
})
```

## describe.runIf

- **Alias:** `suite.runIf`

Das Gegenteil von [describe.skipIf](#describe-skipif).

```ts
import { assert, describe, test } from 'vitest'

const isDev = process.env.NODE_ENV === 'development'

describe.runIf(isDev)('dev only test suite', () => {
  // this test suite only runs in development
})
```

## describe.only

- **Alias:** `suite.only`

Verwende `describe.only`, um nur bestimmte Suites auszuführen

```ts
import { assert, describe, test } from 'vitest'

// Only this suite (and others marked with only) are run
describe.only('suite', () => {
  test('sqrt', () => {
    assert.equal(Math.sqrt(4), 3)
  })
})

describe('other suite', () => {
  // ... will be skipped
})
```

Manchmal ist es sehr nützlich, `only`-Tests in einer bestimmten Datei auszuführen und alle anderen Tests der gesamten Test-Suite zu ignorieren, die die Ausgabe zumüllen.

Dazu führe `vitest` mit der konkreten Datei aus, die die betreffenden Tests enthält:

```shell
vitest interesting.test.ts
```

## describe.concurrent

- **Alias:** `suite.concurrent`

`describe.concurrent` führt alle inneren Suites und Tests parallel aus

```ts
import { describe, test } from 'vitest'

// All suites and tests within this suite will be run in parallel
describe.concurrent('suite', () => {
  test('concurrent test 1', async () => { /* ... */ })
  describe('concurrent suite 2', async () => {
    test('concurrent test inner 1', async () => { /* ... */ })
    test('concurrent test inner 2', async () => { /* ... */ })
  })
  test.concurrent('concurrent test 3', async () => { /* ... */ })
})
```

Setze `concurrent` auf `false`, um von einer übergeordneten Suite oder von [`sequence.concurrent`](/config/sequence#sequence-concurrent) geerbte Nebenläufigkeit abzuwählen:

```ts
describe.concurrent('suite', () => {
  test('concurrent test', async () => { /* ... */ })

  describe('sequential suite', { concurrent: false }, () => {
    test('sequential test 1', async () => { /* ... */ })
    test('sequential test 2', async () => { /* ... */ })
  })
})
```

`.skip`, `.only` und `.todo` funktionieren mit nebenläufigen Suites. Alle folgenden Kombinationen sind gültig:

```ts
describe.concurrent(/* ... */)
describe.skip.concurrent(/* ... */) // or describe.concurrent.skip(/* ... */)
describe.only.concurrent(/* ... */) // or describe.concurrent.only(/* ... */)
describe.todo.concurrent(/* ... */) // or describe.concurrent.todo(/* ... */)
```

Bei nebenläufigen Tests müssen Snapshots und Assertions das `expect` aus dem lokalen [Test-Kontext](/guide/test-context) verwenden, damit der richtige Test erkannt wird.

```ts
describe.concurrent('suite', () => {
  test('concurrent test 1', async ({ expect }) => {
    expect(foo).toMatchSnapshot()
  })
  test('concurrent test 2', async ({ expect }) => {
    expect(foo).toMatchSnapshot()
  })
})
```

## describe.shuffle

- **Alias:** `suite.shuffle`

Vitest bietet über das CLI-Flag [`--sequence.shuffle`](/guide/cli) oder die Konfigurationsoption [`sequence.shuffle`](/config/sequence#sequence-shuffle) eine Möglichkeit, alle Tests in zufälliger Reihenfolge auszuführen. Wenn du aber nur einen Teil deiner Test-Suite in zufälliger Reihenfolge ausführen möchtest, kannst du diesen mit diesem Flag markieren.

```ts
import { describe, test } from 'vitest'

// or describe('suite', { shuffle: true }, ...)
describe.shuffle('suite', () => {
  test('random test 1', async () => { /* ... */ })
  test('random test 2', async () => { /* ... */ })
  test('random test 3', async () => { /* ... */ })

  // `shuffle` is inherited
  describe('still random', () => {
    test('random 4.1', async () => { /* ... */ })
    test('random 4.2', async () => { /* ... */ })
  })

  // disable shuffle inside
  describe('not random', { shuffle: false }, () => {
    test('in order 5.1', async () => { /* ... */ })
    test('in order 5.2', async () => { /* ... */ })
  })
})
// order depends on sequence.seed option in config (Date.now() by default)
```

`.skip`, `.only` und `.todo` funktionieren mit zufällig angeordneten Suites.

## describe.todo

- **Alias:** `suite.todo`

Verwende `describe.todo`, um Suites als Platzhalter für eine spätere Implementierung anzulegen. Für diese Tests wird ein Eintrag im Report angezeigt, sodass du weißt, wie viele Tests du noch implementieren musst.

```ts
// An entry will be shown in the report for this suite
describe.todo('unimplemented suite')
```

## describe.each

- **Alias:** `suite.each`

::: tip
`describe.each` wird zwar aus Gründen der Jest-Kompatibilität bereitgestellt,
Vitest bietet aber auch [`describe.for`](#describe-for), das die Argumenttypen vereinfacht und sich an [`test.for`](/api/test#test-for) orientiert.
:::

Verwende `describe.each`, wenn du mehr als einen Test hast, der von denselben Daten abhängt.

```ts
import { describe, expect, test } from 'vitest'

describe.each([
  { a: 1, b: 1, expected: 2 },
  { a: 1, b: 2, expected: 3 },
  { a: 2, b: 1, expected: 3 },
])('describe object add($a, $b)', ({ a, b, expected }) => {
  test(`returns ${expected}`, () => {
    expect(a + b).toBe(expected)
  })

  test(`returned value not be greater than ${expected}`, () => {
    expect(a + b).not.toBeGreaterThan(expected)
  })

  test(`returned value not be less than ${expected}`, () => {
    expect(a + b).not.toBeLessThan(expected)
  })
})
```

* Die erste Zeile sollte die Spaltennamen enthalten, getrennt durch `|`;
* Eine oder mehrere nachfolgende Datenzeilen, angegeben als Template-Literal-Ausdrücke in der Syntax `${value}`.

```ts
import { describe, expect, test } from 'vitest'

describe.each`
  a               | b      | expected
  ${1}            | ${1}   | ${2}
  ${'a'}          | ${'b'} | ${'ab'}
  ${[]}           | ${'b'} | ${'b'}
  ${{}}           | ${'b'} | ${'[object Object]b'}
  ${{ asd: 1 }}   | ${'b'} | ${'[object Object]b'}
`('describe template string add($a, $b)', ({ a, b, expected }) => {
  test(`returns ${expected}`, () => {
    expect(a + b).toBe(expected)
  })
})
```

## describe.for

- **Alias:** `suite.for`

Der Unterschied zu `describe.each` liegt darin, wie der Array-Fall in den Argumenten übergeben wird. Alle anderen Fälle, die keine Arrays sind (einschließlich der Verwendung von Template-Strings), funktionieren exakt gleich.

```ts
// `each` spreads array case
describe.each([
  [1, 1, 2],
  [1, 2, 3],
  [2, 1, 3],
])('add(%i, %i) -> %i', (a, b, expected) => { // [!code --]
  test('test', () => {
    expect(a + b).toBe(expected)
  })
})

// `for` doesn't spread array case
describe.for([
  [1, 1, 2],
  [1, 2, 3],
  [2, 1, 3],
])('add(%i, %i) -> %i', ([a, b, expected]) => { // [!code ++]
  test('test', () => {
    expect(a + b).toBe(expected)
  })
})
```
