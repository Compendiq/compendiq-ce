# Auf asynchrone Bedingungen warten

Vieles in Tests geschieht nicht synchron. Ein Server braucht einen Moment zum Hochfahren, oder ein DOM-Element wird erst nach einem Microtask gerendert. Warten mit `setTimeout` landet meist entweder bei einem flakigen Zu-kurz-Warten oder bei einem verschwenderisch langen Sleep, und eine manuelle Polling-Schleife ist mehr Code, als man pro Test schreiben möchte.

Vitest stellt Helfer bereit, die das Pollen für Sie übernehmen und in festen Intervallen erneut versuchen, bis die Bedingung erfüllt ist oder ein Timeout abläuft.

## `expect.poll`: eine Assertion wiederholen

Verwenden Sie [`expect.poll`](/api/expect#poll), wenn die Wartebedingung eine Assertion ist. Der Callback liefert den zu prüfenden Wert, der Matcher führt den Vergleich durch, und Vitest wiederholt den gesamten Ausdruck in jedem Intervall, bis der Matcher erfolgreich ist.

```ts
import { expect, test } from 'vitest'
import { createServer } from './server.ts'

test('server starts', async () => {
  const server = createServer()

  await expect.poll(() => server.isReady, {
    timeout: 500,
    interval: 20
  }).toBe(true)
})
```

Die Fehlermeldung ist das gewohnte `expect`-Diff, ohne ein manuelles `throw new Error('Server not started')`, das gepflegt werden müsste. Das ist das richtige Werkzeug für die meisten Fälle nach dem Muster "warte, bis X zu Y wird".

`expect.poll` macht jede Assertion asynchron, der Aufruf muss also mit `await` versehen werden. Einige Matcher passen nicht dazu: Snapshot-Matcher (die unter Polling immer erfolgreich wären), `.resolves` und `.rejects` (die Bedingung wird bereits awaited) sowie `toThrow` (der Wert ist aufgelöst, bevor der Matcher ihn sieht). Greifen Sie in diesen Fällen stattdessen zu `vi.waitFor`.

## `vi.waitFor`: warten und den Wert entgegennehmen

[`vi.waitFor`](/api/vi#vi-waitfor) ist das richtige Werkzeug, wenn die Wartebedingung darin besteht, dass die Arbeit selbst gelingt, und nicht in einer Assertion, die Sie schreiben. Der Callback wird in jedem Intervall ausgeführt; ein geworfener Fehler stellt einen weiteren Versuch in die Warteschlange, und der erste Aufruf, der nichts wirft, löst das Warten mit dem Rückgabewert des Callbacks auf.

```ts
import { expect, test, vi } from 'vitest'
import { connect, DB_URL } from './db.ts'

test('database is reachable', async () => {
  // `connect` throws ECONNREFUSED until the database accepts connections
  const client = await vi.waitFor(() => connect(DB_URL), {
    timeout: 5000,
    interval: 100,
  })

  const rows = await client.query('SELECT 1 AS ok')
  expect(rows[0].ok).toBe(1)
})
```

Der Fehler, der den erneuten Versuch auslöst, kommt von `connect` selbst und nicht von einem `expect`, das Sie im Callback geschrieben haben. `expect.poll` passt zu dieser Form nicht, weil es um Assertions herum gebaut ist, und "wiederhole, bis dieser Aufruf keinen Fehler mehr wirft, und gib mir das Ergebnis" ist keine Assertion. Den Aufruf in ein `try`/`catch` zu verpacken, um eine Assertion vorzutäuschen, würde entweder die Arbeit nach dem Warten duplizieren oder erfordern, die Retry-Schleife von Hand zu bauen.

## `vi.waitUntil`: pollen bis truthy, bei Fehlern sofort scheitern

Verwenden Sie [`vi.waitUntil`](/api/vi#vi-waituntil) für eine Wertabfrage, bei der jeder geworfene Fehler den Test unmittelbar scheitern lassen soll, statt weggretryt zu werden. In jedem Intervall wird der Callback erneut aufgerufen. Ein truthy Rückgabewert löst das Warten auf; ein falsy Rückgabewert wartet auf das nächste Intervall. Ein geworfener Fehler lässt den Test sofort scheitern.

```ts
import { expect, test, vi } from 'vitest'
import { jobResults, startJob } from './worker.ts'

test('worker completes the job', async () => {
  startJob('build-42')

  const result = await vi.waitUntil(
    () => jobResults.get('build-42'),
    { timeout: 5000, interval: 100 },
  )

  expect(result.status).toBe('ok')
  expect(result.steps).toHaveLength(4)
})
```

`jobResults.get('build-42')` liefert `JobResult | undefined`. `waitUntil` pollt, bis ein truthy Wert zurückkommt, verengt den aufgelösten Typ auf `JobResult` und gibt ihn für weitere Assertions zurück. Wirft die Abfrage selbst wegen eines Programmierfehlers, etwa eines Tippfehlers im Import, wird der Fehler von `waitUntil` bereits beim ersten Versuch sichtbar gemacht, statt darüber hinweg zu retryen.

Im Browser-Modus sollten Sie für DOM-Abfragen [`page.locator`](/api/browser/locators) und [`expect.element`](/api/browser/assertions) gegenüber `waitUntil` bevorzugen: Locators wiederholen von sich aus und liefern aussagekräftigere Fehlermeldungen.

## Die Wahl zwischen ihnen

|  | `expect.poll` | `vi.waitFor` | `vi.waitUntil` |
| --- | --- | --- | --- |
| Greifen Sie dazu, wenn | das Warten eine Assertion ist | die Arbeit fehlschlagen kann, bis sie bereit ist | eine Abfrage falsy sein darf und das in Ordnung ist |
| Wiederholt bei geworfenem Fehler | ja | ja | nein, scheitert sofort |
| Löst auf mit | der Assertion | dem Rückgabewert des Callbacks | dem Rückgabewert des Callbacks |

Alle drei akzeptieren die Optionen `{ timeout, interval }` mit einem Standard-Timeout von 1000 ms und Intervallen von 50 ms. `vi.waitFor` und `vi.waitUntil` akzeptieren außerdem eine Zahl anstelle des Optionsobjekts als Kurzform für das Timeout.

## Fake Timer

Wenn [`vi.useFakeTimers`](/api/vi#vi-usefaketimers) aktiv ist, ruft `vi.waitFor` zwischen den Versuchen automatisch `vi.advanceTimersByTime(interval)` auf. So bleibt getesteter Code, der auf `setTimeout` beruht, erreichbar, ohne dass echte Zeit in den Test durchsickert.

## Siehe auch

- [`expect.poll`](/api/expect#poll)
- [`vi.waitFor`](/api/vi#vi-waitfor)
- [`vi.waitUntil`](/api/vi#vi-waituntil)
- [`vi.useFakeTimers`](/api/vi#vi-usefaketimers)
