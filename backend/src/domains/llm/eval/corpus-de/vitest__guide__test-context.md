# Test-Kontext

Inspiriert von den [Playwright-Fixtures](https://playwright.dev/docs/test-fixtures) erlaubt dir der Test-Kontext von Vitest, Utilities, Zustände und Fixtures zu definieren, die du in deinen Tests verwenden kannst.

## Verwendung

Das erste Argument jedes Test-Callbacks ist ein Test-Kontext.

```ts
import { it } from 'vitest'

it('should work', ({ task }) => {
  // prints name of the test
  console.log(task.name)
})
```

## Eingebauter Test-Kontext

### `task`

Ein schreibgeschütztes Objekt mit Metadaten über den Test.

### `expect`

Die an den aktuellen Test gebundene `expect`-API:

```ts
import { it } from 'vitest'

it('math is easy', ({ expect }) => {
  expect(2 + 2).toBe(4)
})
```

Diese API ist nützlich, um Snapshot-Tests nebenläufig auszuführen, da das globale `expect` sie nicht verfolgen kann:

```ts
import { it } from 'vitest'

it.concurrent('math is easy', ({ expect }) => {
  expect(2 + 2).toMatchInlineSnapshot()
})

it.concurrent('math is hard', ({ expect }) => {
  expect(2 * 2).toMatchInlineSnapshot()
})
```

### `skip`

```ts
function skip(note?: string): never
function skip(condition: boolean, note?: string): void
```

Überspringt die weitere Testausführung und markiert den Test als übersprungen:

```ts
import { expect, it } from 'vitest'

it('math is hard', ({ skip }) => {
  skip()
  expect(2 + 2).toBe(5)
})
```

Seit Vitest 3.1 akzeptiert es einen booleschen Parameter, um den Test bedingt zu überspringen:

```ts
it('math is hard', ({ skip, mind }) => {
  skip(mind === 'foggy')
  expect(2 + 2).toBe(5)
})
```

### `annotate` <Version>3.2.0</Version> {#annotate}

```ts
function annotate(
  message: string,
  attachment?: TestAttachment,
): Promise<TestAnnotation>

function annotate(
  message: string,
  type?: string,
  attachment?: TestAttachment,
): Promise<TestAnnotation>
```

Fügt eine [Test-Annotation](/guide/test-annotations) hinzu, die von deinem [Reporter](/config/reporters) angezeigt wird.

```ts
test('annotations API', async ({ annotate }) => {
  await annotate('https://github.com/vitest-dev/vitest/pull/7953', 'issues')
})
```

### `signal` <Version>3.2.0</Version> {#signal}

Ein [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal), das von Vitest abgebrochen werden kann. Das Signal wird in diesen Situationen abgebrochen:

- Der Test läuft in ein Timeout
- Der Benutzer hat den Testlauf manuell mit Strg+C abgebrochen
- [`vitest.cancelCurrentRun`](/api/advanced/vitest#cancelcurrentrun) wurde programmatisch aufgerufen
- Ein anderer Test ist parallel fehlgeschlagen und das Flag [`bail`](/config/bail) ist gesetzt

```ts
it('stop request when test times out', async ({ signal }) => {
  await fetch('/resource', { signal })
}, 2000)
```

### `bench` <Version>5.0.0</Version> {#bench}

Mit der `bench`-Fixture kannst du Benchmarks innerhalb regulärer Tests definieren und ausführen. Du kannst den Durchsatz messen, Implementierungen vergleichen und relative Performance zusichern:

```ts
import { expect, test } from 'vitest'

test('compare parsers', async ({ bench }) => {
  const result = await bench.compare(
    bench('JSON.parse', () => {
      JSON.parse('{"key":"value"}')
    }),
    bench('custom parser', () => {
      customParse('{"key":"value"}')
    }),
  )

  expect(result.get('JSON.parse')).toBeFasterThan(result.get('custom parser'))
})
```

Die vollständige Dokumentation zu Vergleichen, Baselines und Assertion-Matchern findest du im [Benchmark-Leitfaden](/guide/benchmarking).

### `onTestFailed`

Der an den aktuellen Test gebundene Hook [`onTestFailed`](/api/hooks#ontestfailed). Diese API ist nützlich, wenn du Tests nebenläufig ausführst und nur für diesen einen Test eine besondere Behandlung brauchst.

### `onTestFinished`

Der an den aktuellen Test gebundene Hook [`onTestFinished`](/api/hooks#ontestfailed). Diese API ist nützlich, wenn du Tests nebenläufig ausführst und nur für diesen einen Test eine besondere Behandlung brauchst.

## Test-Kontext erweitern

Vitest erlaubt es dir, den Test-Kontext mit `test.extend` um eigene Fixtures zu erweitern.

Mit der Methode `test.extend` erzeugst du eine eigene Test-API mit Fixtures — wiederverwendbaren Werten, die für deine Tests automatisch aufgebaut und wieder abgebaut werden. Vitest unterstützt zwei Schreibweisen: das Builder-Pattern (empfohlen) und die Objekt-Syntax (Playwright-kompatibel).

### Builder-Pattern <Version>4.1.0</Version> {#builder-pattern}

Das Builder-Pattern ist die empfohlene Art, Fixtures zu definieren, weil es automatische Typinferenz bietet. TypeScript leitet den Typ jeder Fixture aus ihrem Rückgabewert ab, sodass du Typen nicht manuell deklarieren musst.

```ts [my-test.ts]
import { test as baseTest } from 'vitest'

export const test = baseTest
  // Simple value - type is inferred as { port: number; host: string }
  .extend('config', { port: 3000, host: 'localhost' })
  // Function fixture - type is inferred from return value
  .extend('server', async ({ config }) => {
    // TypeScript knows config is { port: number; host: string }
    return `http://${config.host}:${config.port}`
  })
```

Verwende es dann in deinen Tests:

```ts [my-test.test.ts]
import { expect } from 'vitest'
import { test } from './my-test.js'

test('server uses correct port', ({ config, server }) => {
  // TypeScript knows the types:
  // - config is { port: number; host: string }
  // - server is string
  expect(server).toBe('http://localhost:3000')
  expect(config.port).toBe(3000)
})
```

#### Setup und Cleanup mit `onCleanup`

Für Fixtures, die Setup- oder Cleanup-Logik brauchen, verwende eine Funktion. Der `onCleanup`-Callback registriert Teardown-Logik, die läuft, nachdem der Geltungsbereich der Fixture endet:

```ts
import { test as baseTest } from 'vitest'

export const test = baseTest
  .extend('tempFile', async ({}, { onCleanup }) => {
    const filePath = `/tmp/test-${Date.now()}.txt`
    await fs.writeFile(filePath, 'test data')

    // Register cleanup - runs after test completes
    onCleanup(async () => {
      await fs.unlink(filePath)
    })

    return filePath
  })
```

Für komplexere Beispiele:

```ts
const test = baseTest
  .extend('database', { scope: 'file' }, async ({}, { onCleanup }) => {
    const db = await createDatabase()
    await db.connect()

    onCleanup(async () => {
      await db.disconnect()
    })

    return db
  })
  .extend('user', async ({ database }, { onCleanup }) => {
    const user = await database.createTestUser()

    onCleanup(async () => {
      await database.deleteUser(user.id)
    })

    return user
  })
```

::: warning
Die Funktion `onCleanup` kann **nur einmal pro Fixture** aufgerufen werden. Wenn du mehrere Aufräumoperationen brauchst, fasse sie entweder in einer einzigen Aufräumfunktion zusammen oder teile deine Fixture in mehrere kleinere Fixtures auf:

```ts
// ❌ This will throw an error
const test = baseTest
  .extend('resources', async ({}, { onCleanup }) => {
    const a = await acquireA()
    onCleanup(() => releaseA(a))

    const b = await acquireB()
    onCleanup(() => releaseB(b)) // Error: onCleanup can only be called once

    return { a, b }
  })

// ✅ Split into separate fixtures (recommended)
const test = baseTest
  .extend('resourceA', async ({}, { onCleanup }) => {
    const a = await acquireA()
    onCleanup(() => releaseA(a))
    return a
  })
  .extend('resourceB', async ({}, { onCleanup }) => {
    const b = await acquireB()
    onCleanup(() => releaseB(b))
    return b
  })
```

Das Aufteilen in separate Fixtures ist der empfohlene Ansatz, da es bessere Isolation bietet und Abhängigkeiten explizit macht.
:::

#### Fixture-Optionen

Das zweite Argument von `.extend()` akzeptiert Optionen:

```ts
const test = baseTest
  // Automatic fixture - runs for every test even if not used
  .extend('metrics', { auto: true }, ({}, { onCleanup }) => {
    const metrics = new MetricsCollector()
    metrics.start()
    onCleanup(() => metrics.stop())
    return metrics
  })
  // Worker-scoped fixture - initialized once per worker
  .extend('config', { scope: 'worker' }, () => {
    return loadConfig()
  })
  // File-scoped fixture - initialized once per file
  .extend('database', { scope: 'file' }, async ({ config }, { onCleanup }) => {
    const db = await createDatabase(config)
    onCleanup(() => db.close())
    return db
  })
  // Injected fixture - can be overridden via config
  .extend('baseUrl', { injected: true }, () => {
    return 'http://localhost:3000'
  })
```

Für Fixtures mit Test-Geltungsbereich (dem Standard) kannst du die Optionen weglassen:

```ts
const test = baseTest
  .extend('simple', () => 'value')
```

#### Auf andere Fixtures zugreifen

Jede Fixture kann über ihren ersten Parameter auf zuvor definierte Fixtures zugreifen. Das funktioniert sowohl für Funktions- als auch für Nicht-Funktions-Fixtures:

```ts
const test = baseTest
  .extend('config', { apiUrl: 'https://api.example.com', port: 3000 })
  .extend('client', ({ config }) => {
    // TypeScript knows config is { apiUrl: string; port: number }
    return new ApiClient(config.apiUrl)
  })
  .extend('user', async ({ client }) => {
    // TypeScript knows client is ApiClient
    return await client.getCurrentUser()
  })
```

#### Objekt-Syntax (Playwright-kompatibel)

Vitest unterstützt außerdem eine Playwright-kompatible Objekt-Syntax. Sie ist nützlich, wenn du von Playwright migrierst oder es bevorzugst, alle Fixtures auf einmal zu definieren:

```ts [my-test.ts]
import { test as baseTest } from 'vitest'

export const test = baseTest.extend({
  page: async ({}, use) => {
    // setup the fixture before each test function
    const page = await browser.newPage()

    // use the fixture value
    await use(page)

    // cleanup the fixture after each test function
    await page.close()
  },
  baseUrl: 'http://localhost:3000'
})
```

Der wesentliche Unterschied zum Builder-Pattern ist das `use()`-Callback-Muster für das Aufräumen:

```ts
// Object syntax: cleanup code goes AFTER use()
const test = baseTest.extend({
  database: async ({}, use) => {
    const db = await createDatabase()
    await db.connect()

    await use(db) // Test runs here

    // Cleanup after the test
    await db.disconnect()
  }
})

// Builder pattern: cleanup is registered with onCleanup()
const test = baseTest
  .extend('database', async ({}, { onCleanup }) => {
    const db = await createDatabase()
    await db.connect()

    onCleanup(() => db.disconnect())

    return db // Test runs after this returns
  })
```

::: info
Bei der Objekt-Syntax musst du die Typen manuell als Generic-Parameter angeben, da TypeScript sie nicht aus dem `use()`-Callback ableiten kann:

```ts
const test = baseTest.extend<{
  page: Page
  baseUrl: string
}>({
  page: async ({}, use) => {
    const page = await browser.newPage()
    await use(page)
    await page.close()
  },
  baseUrl: 'http://localhost:3000'
})
```
:::

#### Tupel-Syntax für Optionen

Verwende bei der Objekt-Syntax ein Tupel, um Fixture-Optionen anzugeben:

```ts
const test = baseTest.extend({
  // Auto fixture
  fixture: [
    async ({}, use) => {
      setup()
      await use()
      teardown()
    },
    { auto: true }
  ],
  // Scoped fixture
  database: [
    async ({}, use) => {
      const db = await createDatabase()
      await use(db)
      await db.close()
    },
    { scope: 'file' }
  ],
  // Injected fixture
  url: [
    '/default',
    { injected: true }
  ],
})
```

### Initialisierung von Fixtures

Der Vitest-Runner initialisiert deine Fixtures intelligent und injiziert sie je nach Verwendung in den Test-Kontext.

```ts
import { test as baseTest } from 'vitest'

const test = baseTest
  .extend('database', async () => {
    console.log('database initializing')
    return createDatabase()
  })
  .extend('cache', async () => {
    return createCache()
  })

// database will not run
test('no fixtures needed', () => {})
test('only cache', ({ cache }) => {})

// database will run
test('needs database', ({ database }) => {})
```

::: warning
Wenn du `test.extend()` mit Fixtures verwendest, solltest du immer die Destrukturierung `{ database }` benutzen, um sowohl in der Fixture-Funktion als auch in der Testfunktion auf den Kontext zuzugreifen.

```ts
test('context must be destructured', (context) => { // [!code --]
  expect(context.database).toBeDefined()
})

test('context must be destructured', ({ database }) => { // [!code ++]
  expect(database).toBeDefined()
})
```
:::

### Erweiterte Tests weiter erweitern

Du kannst einen bereits erweiterten Test erneut erweitern, um weitere Fixtures hinzuzufügen:

```ts
import { test as dbTest } from './my-test.js'

export const test = dbTest
  .extend('user', ({ database }) => {
    return database.createUser()
  })
```

Mit der Objekt-Syntax:

```ts
import { test as dbTest } from './my-test.js'

export const test = dbTest.extend({
  admin: async ({ database }, use) => {
    const admin = await database.createAdmin()
    await use(admin)
    await database.deleteUser(admin.id)
  }
})
```

### Beide Schreibweisen mischen

Du kannst beide Ansätze kombinieren. Das Builder-Pattern kann hinter objektbasierten Erweiterungen angekettet werden:

```ts
const test = baseTest
  // Object syntax for simple fixtures
  .extend<{ apiKey: string }>({
    apiKey: 'test-key-123',
  })
  // Builder pattern for complex fixtures with inference
  .extend('client', ({ apiKey }) => {
    // TypeScript knows apiKey is string
    return new ApiClient(apiKey)
  })
```

### Geltungsbereiche von Fixtures <Version>3.2.0</Version> {#fixture-scopes}

Standardmäßig werden Fixtures für jeden Test initialisiert. Mit der Option `scope` kannst du das ändern und Fixtures zwischen Tests teilen.

::: warning
Standardmäßig wird jede Fixture ohne Geltungsbereich als `test`-Fixture behandelt. Das bedeutet, dass du sie nicht in den Geltungsbereichen `worker` und `file` verwenden kannst. Wenn du dort darauf zugreifen möchtest, gib den Geltungsbereich manuell an:

```ts
test
  .extend('port', { scope: 'worker' }, 5000)
  .extend('db', { scope: 'worker' }, async ({ port }) => {
    return createDb(port)
  })
```

Beachte, dass du Nicht-Test-Fixtures nicht innerhalb von `describe`-Blöcken überschreiben kannst:

```ts
test.describe('a nested suite', () => {
  test.override('port', { scope: 'worker' }, 3000) // throws an error
})
```

Erwäge, sie auf oberster Ebene des Moduls zu überschreiben oder die Option [`injected`](#default-fixture-injected) zu verwenden und den Wert in der Projektkonfiguration bereitzustellen.

Beachte außerdem, dass im [Non-Isolate-Modus](/config/isolate) das Überschreiben einer `worker`-Fixture den Fixture-Wert in allen Testdateien beeinflusst, die nach dem Überschreiben laufen.
:::

#### Test-Geltungsbereich (Standard)

Fixtures mit Test-Geltungsbereich werden für jeden Test frisch erzeugt:

```ts
const test = baseTest
  .extend('counter', () => {
    return { value: 0 }
  })

test('first test', ({ counter }) => {
  counter.value++
  expect(counter.value).toBe(1)
})

test('second test', ({ counter }) => {
  // Fresh instance, value is 0 again
  expect(counter.value).toBe(0)
})
```

Fixtures mit Test-Geltungsbereich haben Zugriff auf den [eingebauten Test-Kontext](#built-in-test-context) (`task`, `expect`, `skip` usw.):

```ts
const test = baseTest
  .extend('testInfo', ({ task }) => {
    return { name: task.name }
  })
```

#### Datei-Geltungsbereich

Fixtures mit Datei-Geltungsbereich werden einmal pro Testdatei initialisiert:

```ts
const test = baseTest
  .extend('database', { scope: 'file' }, async ({}, { onCleanup }) => {
    const db = await createDatabase()
    onCleanup(() => db.close())
    return db
  })

test('first test', ({ database }) => {
  // Uses the same database instance
})

test('second test', ({ database }) => {
  // Same database instance as first test
})
```

#### Worker-Geltungsbereich

Fixtures mit Worker-Geltungsbereich werden einmal pro Worker-Prozess initialisiert:

```ts
const test = baseTest
  .extend('config', { scope: 'worker' }, () => {
    return await loadExpensiveConfig()
  })
```

::: info
Standardmäßig läuft jede Datei in einem eigenen Worker, sodass die Geltungsbereiche `file` und `worker` gleich funktionieren. Deaktivierst du jedoch die [Isolation](/config/isolate), wird die Anzahl der Worker durch [`maxWorkers`](/config/maxworkers) begrenzt, und Fixtures mit Worker-Geltungsbereich werden von allen Dateien geteilt, die im selben Worker laufen.

Beim Ausführen von Tests in `vmThreads` oder `vmForks` funktioniert `scope: 'worker'` genauso wie `scope: 'file'`, weil jede Datei ihren eigenen VM-Kontext hat.
:::

#### Hierarchie der Geltungsbereiche

Fixtures können nur auf andere Fixtures desselben oder eines höheren (langlebigeren) Geltungsbereichs zugreifen:

| Fixture-Geltungsbereich | Zugriff auf |
|---------------|------------|
| `worker` | Nur andere Worker-Fixtures |
| `file` | Worker- + Datei-Fixtures |
| `test` | Worker- + Datei- + Test-Fixtures + [Test-Kontext](#built-in-test-context) |

```ts
const test = baseTest
  .extend('config', { scope: 'worker' }, () => {
    return { apiUrl: 'https://api.example.com' }
  })
  .extend('database', { scope: 'file' }, async ({ config }, { onCleanup }) => {
    // ✅ File fixture can access worker fixture
    const db = await createDatabase(config.apiUrl)
    onCleanup(() => db.close())
    return db
  })
  .extend('user', async ({ database, task }) => {
    // ✅ Test fixture can access file fixture AND test context
    return await database.createUser(task.name)
  })
```

::: tip
Nur Fixtures mit Test-Geltungsbereich haben Zugriff auf den [eingebauten Test-Kontext](#built-in-test-context) (`task`, `expect`, `skip` usw.). Worker- und Datei-Fixtures laufen außerhalb eines konkreten Tests, testspezifische Eigenschaften stehen ihnen also nicht zur Verfügung.

Wenn du in einer Fixture mit Datei-Geltungsbereich den Dateipfad brauchst, verwende stattdessen `expect.getState().testPath`.
:::

#### Typsicherer Zugriff über Geltungsbereiche <Version>3.2.0</Version> {#type-safe-scope-access}

Beim Builder-Pattern erzwingt TypeScript die geltungsbereichsbasierten Zugriffsregeln automatisch. Wenn du versuchst, aus einer Fixture mit Datei-Geltungsbereich auf eine Fixture mit Test-Geltungsbereich zuzugreifen, erhältst du einen Fehler zur Kompilierzeit.

Wenn du die Objekt-Syntax verwendest und dieselbe Typsicherheit möchtest, kannst du mit den Schlüsseln `$worker`, `$file` und `$test` explizit deklarieren, welche Fixtures zu welchem Geltungsbereich gehören:

```ts
const test = baseTest.extend<{
  $worker: { config: Config }
  $file: { database: Database }
  $test: { user: User }
}>({
  config: [async ({}, use) => {
    await use(loadConfig())
  }, { scope: 'worker' }],

  database: [async ({ config }, use) => {
    const db = await createDatabase(config)
    await use(db)
    await db.close()
  }, { scope: 'file' }],

  user: async ({ database }, use) => {
    const user = await database.createUser()
    await use(user)
    await database.deleteUser(user.id)
  },
})
```

Das bietet dieselbe Sicherheit zur Kompilierzeit wie das Builder-Pattern und fängt Verletzungen der Geltungsbereiche zur Build- statt zur Laufzeit ab.

### Standard-Fixture (Injected)

Seit Vitest 3 kannst du in verschiedenen [Projekten](/guide/projects) unterschiedliche Werte bereitstellen. Übergib dazu `{ injected: true }` in den Optionen. Ist der Schlüssel in der [Projektkonfiguration](/config/provide) nicht angegeben, wird der Standardwert verwendet.

:::code-group
```ts [fixtures.test.ts]
import { test as baseTest } from 'vitest'

const test = baseTest
  .extend('url', { injected: true }, '/default')

test('works correctly', ({ url }) => {
  // url is "/default" in "project-new"
  // url is "/full" in "project-full"
  // url is "/empty" in "project-empty"
})
```
```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'project-new',
        },
      },
      {
        test: {
          name: 'project-full',
          provide: {
            url: '/full',
          },
        },
      },
      {
        test: {
          name: 'project-empty',
          provide: {
            url: '/empty',
          },
        },
      },
    ],
  },
})
```
:::

### Fixture-Werte überschreiben <Version>4.1.0</Version> {#overriding-fixture-values}

Mit `test.override` kannst du Fixture-Werte für eine bestimmte Suite und deren Kinder überschreiben. Das ist nützlich, wenn du für unterschiedliche Testszenarien unterschiedliche Fixture-Werte brauchst.

::: tip
Vitest übernimmt die Optionen automatisch, wenn sie beim Überschreiben nicht angegeben werden. Beachte, dass du die Optionen `scope` oder `auto` einer Fixture nicht überschreiben kannst.
:::

#### Builder-Pattern (empfohlen)

```ts
import { test as baseTest, describe, expect } from 'vitest'

const test = baseTest
  .extend('config', { port: 3000, host: 'localhost' })
  .extend('server', ({ config }) => `http://${config.host}:${config.port}`)

describe('production environment', () => {
  // Override with a new static value (chainable)
  test
    .override('config', { port: 8080, host: 'api.example.com' })

  test('uses production config', ({ server }) => {
    expect(server).toBe('http://api.example.com:8080')
  })
})

describe('with custom server', () => {
  // Override with a function that can access other fixtures
  test.override('server', ({ config }) => {
    return `https://${config.host}:${config.port}/v2`
  })

  test('uses custom server', ({ server }) => {
    expect(server).toBe('https://localhost:3000/v2')
  })
})

test('uses default values', ({ server }) => {
  expect(server).toBe('http://localhost:3000')
})
```

#### Mehrere Overrides verketten

`test.override` gibt die Test-API zurück, du kannst also mehrere Aufrufe verketten:

```ts
describe('production environment', () => {
  test
    .override('environment', 'production')
    .override('port', 8080)
    .override('debug', false)

  test('uses production settings', ({ environment, port, debug }) => {
    expect(environment).toBe('production')
    expect(port).toBe(8080)
    expect(debug).toBe(false)
  })
})
```

#### Objekt-Syntax

Du kannst auch die Objekt-Syntax verwenden, um mehrere Fixtures auf einmal zu überschreiben:

```ts
describe('different configuration', () => {
  test.override({
    config: { port: 4000, host: 'test.local' },
  })

  test('uses overwritten config', ({ config }) => {
    expect(config.port).toBe(4000)
  })
})
```

#### Mit Cleanup

Beim Überschreiben mit einer Funktion kannst du `onCleanup` genauso verwenden wie in `test.extend`:

```ts
describe('with custom database', () => {
  test.override('database', async ({ config }, { onCleanup }) => {
    const db = await createTestDatabase(config)
    onCleanup(() => db.drop())
    return db
  })

  test('uses custom database', ({ database }) => {
    // Uses the overwritten database
  })
})
```

#### Verschachtelte Geltungsbereiche

Overrides werden von verschachtelten Suites geerbt und können erneut überschrieben werden:

```ts
describe('level 1', () => {
  test.override('value', 'one')

  test('uses level 1 value', ({ value }) => {
    expect(value).toBe('one')
  })

  describe('level 2', () => {
    test.override('value', 'two')

    test('uses level 2 value', ({ value }) => {
      expect(value).toBe('two')
    })
  })

  test('still uses level 1 value', ({ value }) => {
    expect(value).toBe('one')
  })
})
```

::: warning
Beachte, dass du innerhalb von `test.override` keine neuen Fixtures einführen kannst. Erweitere den Test-Kontext stattdessen mit `test.extend`.
:::

::: info
`test.scoped` ist zugunsten von `test.override` veraltet. Die API `test.scoped` funktioniert weiterhin, wird aber in einer künftigen Version entfernt.
:::

### Typsichere Hooks

Wenn du `test.extend` verwendest, stellt das erweiterte `test`-Objekt typsichere Hooks bereit, die den erweiterten Kontext kennen:

```ts
const test = baseTest
  .extend('counter', { value: 0, increment() { this.value++ } })

// Unlike global hooks, these hooks are aware of the extended context
test.beforeEach(({ counter }) => {
  counter.increment()
})

test.afterEach(({ counter }) => {
  console.log('Final count:', counter.value)
})
```

#### Hooks auf Suite-Ebene mit Fixtures <Version>4.1.0</Version> {#suite-level-hooks}

Das erweiterte `test`-Objekt stellt außerdem die Hooks [`beforeAll`](/api/hooks#beforeall), [`afterAll`](/api/hooks#afterall) und [`aroundAll`](/api/hooks#aroundall) bereit, die auf Fixtures mit Datei- und Worker-Geltungsbereich zugreifen können:

```ts
const test = baseTest
  .extend('config', { scope: 'file' }, () => loadConfig())
  .extend('database', { scope: 'file' }, async ({ config }, { onCleanup }) => {
    const db = await createDatabase(config)
    onCleanup(() => db.close())
    return db
  })

// Access file-scoped fixtures in suite-level hooks
test.aroundAll(async (runSuite, { database }) => {
  await database.transaction(runSuite)
})

test.beforeAll(async ({ database }) => {
  await database.createUsers()
})

test.afterAll(async ({ database }) => {
  await database.removeUsers()
})
```

::: warning WICHTIG
Hooks auf Suite-Ebene (`beforeAll`, `afterAll`, `aroundAll`) **müssen auf dem `test`-Objekt aufgerufen werden, das von `test.extend()` zurückgegeben wird**, um Zugriff auf die erweiterten Fixtures zu haben. Die globalen Funktionen `beforeAll`/`afterAll`/`aroundAll` haben keinen Zugriff auf deine eigenen Fixtures:

```ts
import { test as baseTest, beforeAll } from 'vitest'

const test = baseTest
  .extend('database', { scope: 'file' }, async ({}, { onCleanup }) => {
    const db = await createDatabase()
    onCleanup(() => db.close())
    return db
  })

// ❌ WRONG: Global beforeAll doesn't have access to 'database'
beforeAll(({ database }) => {
  // Error: 'database' is undefined
})

// ✅ CORRECT: Use test.beforeAll to access fixtures
test.beforeAll(({ database }) => {
  // 'database' is available
})
```

Das gilt für alle Hooks auf Suite-Ebene: `beforeAll`, `afterAll` und `aroundAll`.
:::

::: tip
Hooks auf Suite-Ebene können nur auf [Fixtures mit **Datei-** und **Worker-Geltungsbereich**](#fixture-scopes) zugreifen, einschließlich `auto`-Fixtures. Fixtures mit Test-Geltungsbereich stehen in diesen Hooks nicht zur Verfügung, weil sie außerhalb des Kontexts einzelner Tests laufen. Wenn du in einem Hook auf Suite-Ebene auf eine Fixture mit Test-Geltungsbereich zugreifst, wirft Vitest einen Fehler.

```ts
const test = baseTest
  .extend('testFixture', () => 'test-scoped')
  .extend('fileFixture', { scope: 'file' }, () => 'file-scoped')

// ❌ Error: test-scoped fixtures not available in beforeAll
test.beforeAll(({ testFixture }) => {})

// ✅ Works: file-scoped fixtures are available
test.beforeAll(({ fileFixture }) => {})
```
:::
