# Hooks

Diese Funktionen erlauben es dir, dich in den Lebenszyklus von Tests einzuklinken, um Setup- und Teardown-Code nicht wiederholen zu müssen. Sie gelten für den aktuellen Kontext: für die Datei, wenn sie auf oberster Ebene verwendet werden, oder für die aktuelle Suite, wenn sie innerhalb eines `describe`-Blocks stehen. Diese Hooks werden nicht aufgerufen, wenn du Vitest als [Type Checker](/guide/testing-types) ausführst.

Test-Hooks werden standardmäßig in Stack-Reihenfolge aufgerufen ("after"-Hooks in umgekehrter Reihenfolge), du kannst das aber über die Option [`sequence.hooks`](/config/sequence#sequence-hooks) konfigurieren.

## beforeEach

```ts
function beforeEach(
  body: (context: TestContext) => unknown,
  timeout?: number,
): void
```

Registriert einen Callback, der vor jedem Test der aktuellen Suite aufgerufen wird.
Gibt die Funktion ein Promise zurück, wartet Vitest auf dessen Auflösung, bevor der Test läuft.

Optional kannst du ein Timeout (in Millisekunden) übergeben, das festlegt, wie lange vor dem Abbruch gewartet wird. Der Standard beträgt 10 Sekunden und lässt sich global über [`hookTimeout`](/config/hooktimeout) konfigurieren.

```ts
import { beforeEach } from 'vitest'

beforeEach(async () => {
  // Clear mocks and add some testing data before each test run
  await stopMocking()
  await addUser({ name: 'John' })
})
```

Hier stellt `beforeEach` sicher, dass für jeden Test ein Benutzer angelegt wird.

`beforeEach` kann außerdem optional eine Aufräumfunktion zurückgeben. Sie ähnelt [`afterEach`](#aftereach). Der einzige Unterschied besteht darin, dass sie nach allen anderen `afterEach`-Hooks ausgeführt wird:

```ts
import { beforeEach } from 'vitest'

beforeEach(async () => {
  // called once before each test run
  await prepareSomething()

  // clean up function, called once after each test run, after afterEach hooks
  return async () => {
    await resetSomething()
  }
})
```

## afterEach

```ts
function afterEach(
  body: (context: TestContext) => unknown,
  timeout?: number,
): void
```

Registriert einen Callback, der nach Abschluss jedes einzelnen Tests der aktuellen Suite aufgerufen wird.
Gibt die Funktion ein Promise zurück, wartet Vitest auf dessen Auflösung, bevor es fortfährt.

Optional kannst du ein Timeout (in Millisekunden) angeben, das festlegt, wie lange vor dem Abbruch gewartet wird. Der Standard beträgt 10 Sekunden und lässt sich global über [`hookTimeout`](/config/hooktimeout) konfigurieren.

```ts
import { afterEach } from 'vitest'

afterEach(async () => {
  await clearTestingData() // clear testing data after each test run
})
```

Hier stellt `afterEach` sicher, dass die Testdaten nach jedem Testlauf gelöscht werden.

::: tip
Du kannst auch [`onTestFinished`](#ontestfinished) während der Testausführung verwenden, um Zustand aufzuräumen, nachdem der Test durchgelaufen ist.
:::

## beforeAll

```ts
function beforeAll(
  body: (context: ModuleContext) => unknown,
  timeout?: number,
): void
```

Registriert einen Callback, der einmal aufgerufen wird, bevor alle Tests der aktuellen Suite starten.
Gibt die Funktion ein Promise zurück, wartet Vitest auf dessen Auflösung, bevor die Tests laufen.

Optional kannst du ein Timeout (in Millisekunden) angeben, das festlegt, wie lange vor dem Abbruch gewartet wird. Der Standard beträgt 10 Sekunden und lässt sich global über [`hookTimeout`](/config/hooktimeout) konfigurieren.

```ts
import { beforeAll } from 'vitest'

beforeAll(async () => {
  await startMocking() // called once before all tests run
})
```

Hier stellt `beforeAll` sicher, dass die Mock-Daten vor dem Testlauf eingerichtet sind.

`beforeAll` kann außerdem optional eine Aufräumfunktion zurückgeben. Sie ähnelt [`afterAll`](#afterall). Der einzige Unterschied besteht darin, dass sie nach allen anderen `afterAll`-Hooks ausgeführt wird:

```ts
import { beforeAll } from 'vitest'

beforeAll(async () => {
  // called once before all tests run
  await startMocking()

  // clean up function, called once after all tests run, after afterAll hooks
  return async () => {
    await stopMocking()
  }
})
```

## afterAll

```ts
function afterAll(
  body: (context: ModuleContext) => unknown,
  timeout?: number,
): void
```

Registriert einen Callback, der einmal aufgerufen wird, nachdem alle Tests der aktuellen Suite gelaufen sind.
Gibt die Funktion ein Promise zurück, wartet Vitest auf dessen Auflösung, bevor es fortfährt.

Optional kannst du ein Timeout (in Millisekunden) angeben, das festlegt, wie lange vor dem Abbruch gewartet wird. Der Standard beträgt 10 Sekunden und lässt sich global über [`hookTimeout`](/config/hooktimeout) konfigurieren.

```ts
import { afterAll } from 'vitest'

afterAll(async () => {
  await stopMocking() // this method is called after all tests run
})
```

Hier stellt `afterAll` sicher, dass die Methode `stopMocking` nach allen Testläufen aufgerufen wird.

## aroundEach

```ts
function aroundEach(
  body: (
    runTest: () => Promise<void>,
    context: TestContext,
  ) => Promise<void>,
  timeout?: number,
): void
```

Registriert eine Callback-Funktion, die sich um jeden Test innerhalb der aktuellen Suite legt. Der Callback erhält eine `runTest`-Funktion, die aufgerufen werden **muss**, damit der Test läuft.

Die Funktion `runTest()` führt die `beforeEach`-Hooks, den Test selbst, die im Test verwendeten Fixtures und die `afterEach`-Hooks aus. Fixtures, auf die im `aroundEach`-Callback zugegriffen wird, werden vor dem Aufruf von `runTest()` initialisiert und erst abgebaut, nachdem der Teardown-Code von aroundEach abgeschlossen ist — so kannst du sie gefahrlos in beiden Phasen, Setup und Teardown, verwenden.

::: warning
Du **musst** `runTest()` innerhalb deines Callbacks aufrufen. Wird `runTest()` nicht aufgerufen, schlägt der Test mit einem Fehler fehl.
:::

Optional kannst du ein Timeout (in Millisekunden) angeben, das festlegt, wie lange vor dem Abbruch gewartet wird. Das Timeout gilt unabhängig für die Setup-Phase (vor `runTest()`) und die Teardown-Phase (nach `runTest()`). Der Standard beträgt 10 Sekunden und lässt sich global über [`hookTimeout`](/config/hooktimeout) konfigurieren.

```ts
import { aroundEach, test } from 'vitest'

aroundEach(async (runTest) => {
  await db.transaction(runTest)
})

test('insert user', async () => {
  await db.insert({ name: 'Alice' })
  // transaction is automatically rolled back after the test
})
```

::: tip Wann `aroundEach` verwenden
Verwende `aroundEach`, wenn dein Test **innerhalb eines Kontexts** laufen muss, der ihn umschließt, zum Beispiel:
- Tests in einen [AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)-Kontext einbetten
- Tests mit Tracing-Spans umschließen
- Datenbanktransaktionen

Wenn du lediglich Code vor und nach Tests ausführen musst, verwende bevorzugt [`beforeEach`](#beforeeach) mit einer zurückgegebenen Aufräumfunktion:
```ts
beforeEach(async () => {
  await database.connect()
  return async () => {
    await database.disconnect()
  }
})
```
:::

### Mehrere Hooks

Wenn mehrere `aroundEach`-Hooks registriert sind, werden sie ineinander verschachtelt. Der zuerst registrierte Hook ist die äußerste Hülle:

```ts
aroundEach(async (runTest) => {
  console.log('outer before')
  await runTest()
  console.log('outer after')
})

aroundEach(async (runTest) => {
  console.log('inner before')
  await runTest()
  console.log('inner after')
})

// Output order:
//  outer before
//    inner before
//      test
//    inner after
//  outer after
```

### Kontext und Fixtures

Der Callback erhält den Test-Kontext als zweites Argument, was bedeutet, dass du Fixtures mit `aroundEach` verwenden kannst:

```ts
import { aroundEach, test as base } from 'vitest'

const test = base.extend<{ db: Database; user: User }>({
  db: async ({}, use) => {
    // db is created before `aroundEach` hook
    const db = await createTestDatabase()
    await use(db)
    await db.close()
  },
  user: async ({ db }, use) => {
    // `user` runs as part of the transaction
    // because it's accessed inside the `test`
    const user = await db.createUser()
    await use(user)
  },
})

// note that `aroundEach` is available on test
// for a better TypeScript support of fixtures
test.aroundEach(async (runTest, { db }) => {
  await db.transaction(runTest)
})

test('insert user', async ({ db, user }) => {
  await db.insert(user)
})
```

## aroundAll

```ts
function aroundAll(
  body: (
    runSuite: () => Promise<void>,
    context: ModuleContext,
  ) => Promise<void>,
  timeout?: number,
): void
```

Registriert eine Callback-Funktion, die sich um alle Tests innerhalb der aktuellen Suite legt. Der Callback erhält eine `runSuite`-Funktion, die aufgerufen werden **muss**, damit die Tests der Suite laufen.

Die Funktion `runSuite()` führt alle Tests der Suite aus, einschließlich der Hooks `beforeAll`/`afterAll`/`beforeEach`/`afterEach`, der `aroundEach`-Hooks und der Fixtures.

::: warning
Du **musst** `runSuite()` innerhalb deines Callbacks aufrufen. Wird `runSuite()` nicht aufgerufen, schlägt der Hook mit einem Fehler fehl und alle Tests der Suite werden übersprungen.
:::

Optional kannst du ein Timeout (in Millisekunden) angeben, das festlegt, wie lange vor dem Abbruch gewartet wird. Das Timeout gilt unabhängig für die Setup-Phase (vor `runSuite()`) und die Teardown-Phase (nach `runSuite()`). Der Standard beträgt 10 Sekunden und lässt sich global über [`hookTimeout`](/config/hooktimeout) konfigurieren.

```ts
import { aroundAll, test } from 'vitest'

aroundAll(async (runSuite) => {
  await tracer.trace('test-suite', runSuite)
})

test('test 1', () => {
  // Runs within the tracing span
})

test('test 2', () => {
  // Also runs within the same tracing span
})
```

::: tip Wann `aroundAll` verwenden
Verwende `aroundAll`, wenn deine Suite **innerhalb eines Kontexts** laufen muss, der alle Tests umschließt, zum Beispiel:
- Eine ganze Suite in einen [AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage)-Kontext einbetten
- Eine Suite mit Tracing-Spans umschließen
- Datenbanktransaktionen

Wenn du lediglich einmal Code vor und nach allen Tests ausführen musst, verwende bevorzugt [`beforeAll`](#beforeall) mit einer zurückgegebenen Aufräumfunktion:
```ts
beforeAll(async () => {
  await server.start()
  return async () => {
    await server.stop()
  }
})
```
:::

### Mehrere Hooks

Wenn mehrere `aroundAll`-Hooks registriert sind, werden sie ineinander verschachtelt. Der zuerst registrierte Hook ist die äußerste Hülle:

```ts
aroundAll(async (runSuite) => {
  console.log('outer before')
  await runSuite()
  console.log('outer after')
})

aroundAll(async (runSuite) => {
  console.log('inner before')
  await runSuite()
  console.log('inner after')
})

// Output order: outer before → inner before → tests → inner after → outer after
```

Jede Suite hat ihre eigenen, unabhängigen `aroundAll`-Hooks. Das `aroundAll` der übergeordneten Suite umschließt die Ausführung der untergeordneten Suite:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { aroundAll, describe, test } from 'vitest'

const context = new AsyncLocalStorage<{ suiteId: string }>()

aroundAll(async (runSuite) => {
  await context.run({ suiteId: 'root' }, runSuite)
})

test('root test', () => {
  // context.getStore() returns { suiteId: 'root' }
})

describe('nested', () => {
  aroundAll(async (runSuite) => {
    // Parent's context is available here
    await context.run({ suiteId: 'nested' }, runSuite)
  })

  test('nested test', () => {
    // context.getStore() returns { suiteId: 'nested' }
  })
})
```

## Test-Hooks

Vitest bietet einige Hooks, die du _während_ der Testausführung aufrufen kannst, um den Zustand aufzuräumen, sobald der Test durchgelaufen ist.

::: warning
Diese Hooks werfen einen Fehler, wenn sie außerhalb des Testkörpers aufgerufen werden.
:::

### onTestFinished {#ontestfinished}

Dieser Hook wird immer aufgerufen, nachdem der Test durchgelaufen ist. Er wird nach den `afterEach`-Hooks aufgerufen, da diese das Testergebnis beeinflussen können. Er erhält wie `beforeEach` und `afterEach` ein `TestContext`-Objekt.

```ts {1,5}
import { onTestFinished, test } from 'vitest'

test('performs a query', () => {
  const db = connectDb()
  onTestFinished(() => db.close())
  db.query('SELECT * FROM users')
})
```

::: warning
Wenn du Tests nebenläufig ausführst, solltest du immer den `onTestFinished`-Hook aus dem Test-Kontext verwenden, da Vitest nebenläufige Tests in globalen Hooks nicht verfolgt:

```ts {3,5}
import { test } from 'vitest'

test.concurrent('performs a query', ({ onTestFinished }) => {
  const db = connectDb()
  onTestFinished(() => db.close())
  db.query('SELECT * FROM users')
})
```
:::

Dieser Hook ist besonders nützlich, wenn du wiederverwendbare Logik schreibst:

```ts
// this can be in a separate file
function getTestDb() {
  const db = connectMockedDb()
  onTestFinished(() => db.close())
  return db
}

test('performs a user query', async () => {
  const db = getTestDb()
  expect(
    await db.query('SELECT * from users').perform()
  ).toEqual([])
})

test('performs an organization query', async () => {
  const db = getTestDb()
  expect(
    await db.query('SELECT * from organizations').perform()
  ).toEqual([])
})
```

Es ist außerdem gute Praxis, deine Spies nach jedem Test aufzuräumen, damit sie nicht in andere Tests hineinlecken. Das erreichst du, indem du die Konfiguration [`restoreMocks`](/config/restoremocks) global aktivierst oder den Spy innerhalb von `onTestFinished` wiederherstellst (wenn du den Mock am Ende des Tests wiederherstellen willst, geschieht das nicht, falls eine der Assertions fehlschlägt — `onTestFinished` stellt sicher, dass der Code immer läuft):

```ts
import { onTestFinished, test } from 'vitest'

test('performs a query', () => {
  const spy = vi.spyOn(db, 'query')
  onTestFinished(() => spy.mockClear())

  db.query('SELECT * FROM users')
  expect(spy).toHaveBeenCalled()
})
```

::: tip
Dieser Hook wird immer in umgekehrter Reihenfolge aufgerufen und ist von der Option [`sequence.hooks`](/config/sequence#sequence-hooks) nicht betroffen.
:::

### onTestFailed

Dieser Hook wird nur aufgerufen, nachdem der Test fehlgeschlagen ist. Er wird nach den `afterEach`-Hooks aufgerufen, da diese das Testergebnis beeinflussen können. Er erhält wie `beforeEach` und `afterEach` ein `TestContext`-Objekt. Dieser Hook ist nützlich zum Debuggen.

```ts {1,5-7}
import { onTestFailed, test } from 'vitest'

test('performs a query', () => {
  const db = connectDb()
  onTestFailed(({ task }) => {
    console.log(task.result.errors)
  })
  db.query('SELECT * FROM users')
})
```

::: warning
Wenn du Tests nebenläufig ausführst, solltest du immer den `onTestFailed`-Hook aus dem Test-Kontext verwenden, da Vitest nebenläufige Tests in globalen Hooks nicht verfolgt:

```ts {3,5-7}
import { test } from 'vitest'

test.concurrent('performs a query', ({ onTestFailed }) => {
  const db = connectDb()
  onTestFailed(({ task }) => {
    console.log(task.result.errors)
  })
  db.query('SELECT * FROM users')
})
```
:::
