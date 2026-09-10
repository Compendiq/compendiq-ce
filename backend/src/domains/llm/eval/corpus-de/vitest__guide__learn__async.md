# Asynchronen Code testen

JavaScript-Code läuft häufig asynchron. Ob Sie Daten abrufen, Dateien lesen oder auf Timer warten – Vitest muss wissen, wann der getestete Code abgeschlossen ist, bevor es zum nächsten Test übergeht. Hier sind die Muster, die Sie am häufigsten verwenden werden.

## Async/Await

Der einfachste Ansatz ist, Ihre Testfunktion als `async` zu deklarieren. Vitest wartet automatisch darauf, dass das zurückgegebene Promise erfüllt wird, bevor es den Test als abgeschlossen betrachtet. Wird das Promise abgelehnt, schlägt der Test mit dem Ablehnungsgrund fehl.

```js
import { expect, test } from 'vitest'

function fetchUser(id) {
  return Promise.resolve({ id, name: 'Alice' })
}

test('fetches user by id', async () => {
  const user = await fetchUser(1)
  expect(user.name).toBe('Alice')
})
```

Dies ist das Muster, das Sie in der überwiegenden Mehrheit der Fälle verwenden werden. Es liest sich genau wie synchroner Code, und Fehler werden über `await` auf natürliche Weise weitergereicht.

## Resolves und Rejects

Manchmal möchten Sie lieber direkt gegen ein Promise assertieren, statt es zuerst per `await` in eine Variable zu überführen. Die Helfer [`.resolves`](/api/expect#resolves) und [`.rejects`](/api/expect#rejects) ermöglichen genau das. Sie packen das Promise aus und wenden den Matcher dann auf den erfüllten oder abgelehnten Wert an:

```js
test('resolves to Alice', async () => {
  await expect(fetchUser(1)).resolves.toMatchObject({ name: 'Alice' })
})

test('rejects with an error', async () => {
  await expect(fetchInvalidUser()).rejects.toThrow('User not found')
})
```

::: warning
Vergessen Sie das `await` vor `expect` nicht. Vitest erkennt nicht abgewartete Assertions und lässt den Test an dessen Ende fehlschlagen.
:::

## Assertions zählen

Bei asynchronem Code gibt es ein subtiles Risiko: Eine Assertion innerhalb eines Callbacks oder einer `.then()`-Kette wird möglicherweise nie ausgeführt, und der Test würde trotzdem bestehen, weil keine Assertion fehlgeschlagen ist. [`expect.hasAssertions()`](/api/expect#hasassertions) schützt davor, indem es prüft, dass während des Tests mindestens eine Assertion ausgeführt wurde:

```js
test('callback is invoked', async () => {
  expect.hasAssertions()

  const data = await fetchData()
  data.items.forEach((item) => {
    expect(item.id).toBeDefined()
  })
  // if data.items is empty, the test fails instead of silently passing
})
```

Wenn Sie genau wissen, wie viele Assertions ausgeführt werden sollen, ist [`expect.assertions(n)`](/api/expect#assertions) präziser:

```js
test('both callbacks are called', async () => {
  expect.assertions(2)

  await Promise.all([
    fetchUser(1).then(user => expect(user.name).toBe('Alice')),
    fetchUser(2).then(user => expect(user.name).toBe('Bob')),
  ])
})
```

In den meisten Fällen ist `async`/`await` mit direkten Assertions klar genug und Sie brauchen kein Zählen von Assertions. Am nützlichsten ist es, wenn Assertions in Callbacks, Schleifen oder bedingten Zweigen stehen, bei denen Sie sicherstellen wollen, dass sie tatsächlich ausgeführt wurden.

::: tip
Wenn Sie möchten, dass jeder Test in Ihrem Projekt mindestens eine Assertion erfordert, aktivieren Sie [`expect.requireAssertions`](/config/expect#expect-requireassertions) in Ihrer Konfiguration, anstatt `expect.hasAssertions()` manuell zu jedem Test hinzuzufügen.
:::

## Callbacks

Einige ältere APIs verwenden Callbacks statt Promises. Da Vitest mit Promises arbeitet, ist der einfachste Ansatz, den Callback in ein `Promise` einzupacken:

```js
function fetchData(callback) {
  setTimeout(callback, 100, 'peanut butter')
}

test('the data is peanut butter', async () => {
  const data = await new Promise((resolve) => {
    fetchData(resolve)
  })
  expect(data).toBe('peanut butter')
})
```

Dieses Muster funktioniert für jede callback-basierte API. Übergeben Sie `resolve` als Erfolgs-Callback, und der Test wartet, bis der Callback aufgerufen wird.

::: tip
Die meisten modernen Node.js-APIs (etwa `fs/promises` und `fetch`) unterstützen Promises nativ, sodass Sie direkt `async`/`await` verwenden können. Das obige Muster zum Einpacken von Callbacks ist vor allem für ältere Bibliotheken nützlich, die noch nicht auf Promises umgestellt haben.
:::

## Timeouts

Standardmäßig hat jeder Test ein Timeout von 5 Sekunden. Dauert ein Test länger (etwa weil ein Promise nie erfüllt wird oder ein Netzwerk-Request hängt), schlägt er mit einem Timeout-Fehler fehl. Das verhindert, dass Ihre Test-Suite unbegrenzt hängen bleibt.

Sie können ein [eigenes Timeout](/api/test#timeout) als drittes Argument an `test` übergeben, was für Tests nützlich ist, die berechtigterweise mehr Zeit benötigen:

```js
test('long-running operation', async () => {
  await someSlowOperation()
}, 10_000) // 10 seconds
```

Wenn Sie feststellen, dass Sie über viele Tests hinweg längere Timeouts brauchen, können Sie den Standardwert für alle Tests mit der Konfigurationsoption [`testTimeout`](/config/testtimeout) ändern:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 10_000,
  },
})
```

## Unbehandelte Rejections

Standardmäßig meldet Vitest unbehandelte Promise-Rejections als Fehler im Testlauf. Wenn ein Promise irgendwo in Ihrem Code abgelehnt wird und nichts es abfängt, schlägt der Testlauf fehl, selbst wenn alle Ihre Assertions erfolgreich waren. Das ist beabsichtigt: Unbehandelte Rejections deuten in der Regel auf echte Fehler hin, etwa ein vergessenes `await` oder ein Fire-and-forget-Promise, das stillschweigend fehlschlägt.

```js
test('this causes an unhandled rejection error', () => {
  // This promise rejects but is never awaited or caught
  Promise.reject(new Error('oops'))
})
```

Um das zu beheben, stellen Sie sicher, dass Sie alle Promises mit `await` abwarten oder erwartete Rejections abfangen:

```js
test('handle the rejection', async () => {
  // Either await the promise
  await expect(Promise.reject(new Error('oops'))).rejects.toThrow('oops')

  // Or catch it explicitly if you don't need to assert on it
  Promise.reject(new Error('expected')).catch(() => {})
})
```

Wenn Ihr Code absichtlich unbehandelte Rejections erzeugt, können Sie bestimmte Fehler mit [`onUnhandledError`](/config/onunhandlederror) filtern oder die Prüfung mit [`dangerouslyIgnoreUnhandledErrors`](/config/dangerouslyignoreunhandlederrors) vollständig deaktivieren.
