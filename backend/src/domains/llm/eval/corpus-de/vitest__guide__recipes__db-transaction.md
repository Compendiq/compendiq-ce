# Eine Datenbanktransaktion pro Test

Integrationstests, die eine echte Datenbank verwenden, müssen von einem sauberen Zustand ausgehen. Zwischen jedem Test die Tabellen zu leeren, ist langsam; der übliche Ausweg besteht darin, jeden Test in eine Transaktion zu verpacken, die am Ende zurückgerollt wird. Es wird nie etwas committet, und es muss kein Aufräumen pro Test geschrieben werden.

Vitest bietet das über [`aroundEach`](/api/hooks#aroundeach) <Version>4.1.0</Version> und eine [gescopte Fixture](/guide/test-context#fixture-scopes) <Version>3.2.0</Version> an.

## Muster

```ts
import { test as baseTest } from 'vitest'
import { createTestDatabase } from './db.ts'

export const test = baseTest
  .extend('db', { scope: 'file' }, async ({}, { onCleanup }) => {
    const db = await createTestDatabase()
    onCleanup(() => db.close())
    return db
  })

test.aroundEach(async (runTest, { db }) => {
  await db.transaction(runTest)
})

test('insert user', async ({ db }) => {
  await db.insert({ name: 'Alice' })
  // rolled back automatically when the test ends
})
```

## Wie es funktioniert

Die `db`-Fixture wird über `scope: 'file'` einmal pro Datei erzeugt, sodass der Verbindungsaufbau nur einmal statt bei jedem Test erfolgt; `onCleanup` schließt die Verbindung, wenn die Datei abgearbeitet ist. `aroundEach` verpackt jeden Test in `db.transaction(runTest)`, und alles, was der Test schreibt, wird zurückgerollt, sobald `runTest` auflöst. Der Test erhält dieselbe `db`-Instanz über seinen Kontext, ohne zu wissen, dass er innerhalb einer Transaktion läuft.

Das funktioniert, solange Ihr Datenbanktreiber verschachtelte Transaktionen oder Savepoints unterstützt, was auf die meisten modernen Datenbanken zutrifft. Derselbe `aroundEach`-Hook kann auch einen [`AsyncLocalStorage`](https://nodejs.org/api/async_context.html#class-asynclocalstorage)-Kontext umschließen, wenn Sie neben der Transaktion Dinge wie Mandanten- oder Trace-IDs durch den Test hindurchreichen möchten.

## Eine Verbindung pro Worker

Wenn die Suite viele Dateien umfasst, summiert sich der Aufwand, für jede Datei eine frische Datenbankverbindung zu bezahlen. Stellt man die Fixture auf `scope: 'worker'` um und schaltet die Isolation ab, können sich mehrere Dateien eine einzige Verbindung pro Worker-Prozess teilen:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    isolate: false,
  },
})
```

```ts
import { test as baseTest } from 'vitest'
import { createTestDatabase } from './db.ts'

export const test = baseTest
  .extend('db', { scope: 'worker' }, async ({}, { onCleanup }) => {
    const db = await createTestDatabase()
    onCleanup(() => db.close())
    return db
  })

test.aroundEach(async (runTest, { db }) => {
  await db.transaction(runTest)
})
```

Standardmäßig läuft jede Testdatei in ihrem eigenen Worker, sodass sich `scope: 'file'` und `scope: 'worker'` identisch verhalten. Mit `isolate: false` verwendet Vitest Worker über Dateien hinweg wieder (begrenzt durch [`maxWorkers`](/config/maxworkers)), sodass eine worker-gescopte Fixture einmal pro Worker statt einmal pro Datei erzeugt wird. Bei einer Suite aus 200 Dateien auf 8 Workern sind das 8 Verbindungen statt 200.

Die Wiederverwendung von Workern ist keine kostenlose Optimierung. Ist die Isolation abgeschaltet, teilen sich Dateien innerhalb des Workers dieselben Modulinstanzen, und Tests, die Zustand auf oberster Ebene verändern (Zähler, Caches, monkey-gepatchte Globals), können diesen Zustand an die Datei weiterreichen, die als Nächste im selben Worker läuft. Das Zurückrollen pro Test kümmert sich um die Datenisolation in der Datenbank. Den Modulzustand im Worker kann es nicht schützen. Lesen Sie die Abwägungen im Rezept [Isolationseinstellungen pro Datei](/guide/recipes/disable-isolation), bevor Sie die Isolation suite-weit abschalten.

[`vmThreads` und `vmForks`](/config/pool) laufen unabhängig vom `isolate`-Flag stets isoliert, sodass worker-gescopte Fixtures in diesen Pools auf das Verhalten pro Datei zurückfallen.

## Siehe auch

- [`aroundEach` und `aroundAll`](/api/hooks#aroundeach)
- [Fixture-Scopes](/guide/test-context#fixture-scopes)
- [Builder-Muster](/guide/test-context#builder-pattern)
