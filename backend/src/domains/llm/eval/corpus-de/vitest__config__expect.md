# expect

- **Typ:** `ExpectOptions`

## expect.requireAssertions

- **Typ:** `boolean`
- **Standard:** `false`

Entspricht dem Aufruf von [`expect.hasAssertions()`](/api/expect#expect-hasassertions) zu Beginn jedes Tests. Damit wird sichergestellt, dass kein Test versehentlich besteht.

::: tip
Das funktioniert nur mit dem `expect` von Vitest. Wenn Sie `assert`- oder `.should`-Assertions verwenden, zählen diese nicht, und Ihr Test schlägt mangels expect-Assertions fehl.

Sie können diesen Wert ändern, indem Sie `vi.setConfig({ expect: { requireAssertions: false } })` aufrufen. Die Konfiguration gilt für jeden nachfolgenden `expect`-Aufruf, bis `vi.resetConfig` manuell aufgerufen wird.
:::

::: warning
Wenn Sie Tests mit `sequence.concurrent` und `expect.requireAssertions` auf `true` ausführen, sollten Sie das [lokale expect](/guide/test-context.html#expect) statt des globalen verwenden. Andernfalls kann dies in [manchen Situationen (#8469)](https://github.com/vitest-dev/vitest/issues/8469) zu falsch negativen Ergebnissen führen.
:::

## expect.poll

Globale Konfigurationsoptionen für [`expect.poll`](/api/expect#poll). Es sind dieselben Optionen, die Sie an `expect.poll(condition, options)` übergeben können.

### expect.poll.interval

- **Typ:** `number`
- **Standard:** `50`

Abfrageintervall in Millisekunden

### expect.poll.timeout

- **Typ:** `number`
- **Standard:** `1000`

Zeitlimit der Abfrage in Millisekunden
