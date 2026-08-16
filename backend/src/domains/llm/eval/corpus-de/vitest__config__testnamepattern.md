# testNamePattern <CRoot /> {#testnamepattern}

- **Typ:** `string | RegExp`
- **CLI:** `-t <pattern>`, `--testNamePattern=<pattern>`, `--test-name-pattern=<pattern>`

Führt Tests aus, deren vollständiger Name auf das Muster passt.
Wenn Sie `OnlyRunThis` für diese Eigenschaft angeben, werden Tests übersprungen, deren Testname das Wort `OnlyRunThis` nicht enthält.

```js
import { expect, test } from 'vitest'

// run
test('OnlyRunThis', () => {
  expect(true).toBe(true)
})

// skipped
test('doNotRun', () => {
  expect(true).toBe(true)
})
```

Das Muster wird gegen den vollständigen Namen des Tests abgeglichen: die Namen der umschließenden Suites und der Testname, verbunden durch `' > '` (dieselbe Zeichenkette, die in der Reporter-Ausgabe erscheint). Der folgende Test hat beispielsweise den vollständigen Namen `math > adds` und wird daher von `-t 'math > adds'` oder `-t adds` erfasst:

```js
import { describe, expect, test } from 'vitest'

describe('math', () => {
  test('adds', () => {
    expect(1 + 1).toBe(2)
  })
})
```

::: warning
Vor Vitest 5 wurden die Segmente durch ein einzelnes Leerzeichen verbunden (`math adds`), analog zu Jest. Einzelheiten finden Sie im [Migrations-Guide](/guide/migration#vitest-5).
:::
