# TestModule

Die Klasse `TestModule` repräsentiert ein einzelnes Modul in einem einzelnen Projekt. Diese Klasse ist nur im Haupt-Thread verfügbar. Sieh dir die ["Runner API"](/api/advanced/runner#tasks) an, wenn du mit Laufzeit-Tasks arbeitest.

Die `TestModule`-Instanz hat immer eine Eigenschaft `type` mit dem Wert `module`. Damit kannst du zwischen verschiedenen Task-Typen unterscheiden:

```ts
if (task.type === 'module') {
  task // TestModule
}
```

::: warning Erweiterte Suite-Methoden
Die Klasse `TestModule` erbt alle Methoden und Eigenschaften von [`TestSuite`](/api/advanced/test-suite). Dieser Leitfaden listet nur Methoden und Eigenschaften auf, die für `TestModule` spezifisch sind.
:::

## moduleId

Dies ist üblicherweise ein absoluter Unix-Dateipfad (auch unter Windows). Es kann eine virtuelle ID sein, wenn die Datei nicht auf der Festplatte liegt. Dieser Wert entspricht der ID in Vites `ModuleGraph`.

```ts
'C:/Users/Documents/project/example.test.ts' // ✅
'/Users/mac/project/example.test.ts' // ✅
'C:\\Users\\Documents\\project\\example.test.ts' // ❌
```

## relativeModuleId

Modul-ID relativ zum Projekt. Dies entspricht `task.name` in der veralteten API.

```ts
'project/example.test.ts' // ✅
'example.test.ts' // ✅
'project\\example.test.ts' // ❌
```

## viteEnvironment <Version>4.1.0</Version> {#viteenvironment}

Dies ist eine Vite-[`DevEnvironment`](https://vite.dev/guide/api-environment), die alle Dateien innerhalb des Testmoduls transformiert.

::: details Historie
- `v4.0.15`: als experimentell hinzugefügt
:::

## state

```ts
function state(): TestModuleState
```

Funktioniert genauso wie [`testSuite.state()`](/api/advanced/test-suite#state), kann aber zusätzlich `queued` zurückgeben, wenn das Modul noch nicht ausgeführt wurde.

## meta <Version>3.1.0</Version> {#meta}

```ts
function meta(): TaskMeta
```

Benutzerdefinierte [Metadaten](/api/advanced/metadata), die dem Modul während seiner Ausführung oder Erfassung angehängt wurden. Die Metadaten können angehängt werden, indem während eines Testlaufs eine Eigenschaft am Objekt `task.meta` zugewiesen wird:

```ts {5,10}
import { test } from 'vitest'

describe('the validation works correctly', (task) => {
  // assign "decorated" during collection
  task.file.meta.decorated = false

  test('some test', ({ task }) => {
    // assign "decorated" during test run, it will be available
    // only in onTestCaseReady hook
    task.file.meta.decorated = false
  })
})
```

:::tip
Wenn Metadaten während der Erfassung angehängt wurden (außerhalb der `test`-Funktion), dann sind sie im Hook [`onTestModuleCollected`](./reporters#ontestmodulecollected) des eigenen Reporters verfügbar.
:::

## diagnostic

```ts
function diagnostic(): ModuleDiagnostic
```

Nützliche Informationen über das Modul wie Dauer, Speicherverbrauch usw. Wurde das Modul noch nicht ausgeführt, geben alle Diagnosewerte `0` zurück.

```ts
interface ModuleDiagnostic {
  /**
   * The time it takes to import and initiate an environment.
   */
  readonly environmentSetupDuration: number
  /**
   * The time it takes Vitest to setup test harness (runner, mocks, etc.).
   */
  readonly prepareDuration: number
  /**
   * The time it takes to import the test module.
   * This includes importing everything in the module and executing suite callbacks.
   */
  readonly collectDuration: number
  /**
   * The time it takes to import the setup module.
   */
  readonly setupDuration: number
  /**
   * Accumulated duration of all tests and hooks in the module.
   */
  readonly duration: number
  /**
   * The amount of memory used by the module in bytes.
   * This value is only available if the test was executed with `logHeapUsage` flag.
   */
  readonly heap: number | undefined
  /**
   * The time spent importing every non-externalized dependency that Vitest has processed.
   */
  readonly importDurations: Record<string, ImportDuration>
  /**
   * The id of the worker that ran this file. This value cannot be higher than `maxWorkers`.
   * If file did not run yet, this will be 0.
   *
   * **Warning**: Node.js tests and browser tests run in different pools and do not share `concurrencyId`.
   * It is possible to have multiple modules with the same `concurrencyId` because of that.
   * Use `project.isBrowserEnabled()` to distinguish the concurrency.
   */
  readonly concurrencyId: number
  /**
   * Incremental number of the worker that ran this file. This number increases with each worker.
   * If file did not run yet, this will be 0.
   *
   * **Warning**: Node.js tests and browser tests run in different pools and do not share `workerId`.
   * It is possible to have multiple modules with the same `workerId` because of that.
   * Use `project.isBrowserEnabled()` to distinguish the concurrency.
   */
  readonly workerId: number
}

/** The time spent importing & executing a non-externalized file. */
interface ImportDuration {
  /** The time spent importing & executing the file itself, not counting all non-externalized imports that the file does. */
  selfTime: number

  /** The time spent importing & executing the file and all its imports. */
  totalTime: number
}
```

## logs <Version>5.0.0</Version> {#logs}

```ts
function logs(): ReadonlyArray<UserConsoleLog>
```

Konsolenausgaben, die während der Testerfassung auf oberster Ebene des Moduls aufgezeichnet wurden. Zum Beispiel:

```ts
console.log('included') // [!code highlight]

describe('suite', () => {
  console.log('not included') // [!code error]

  test('test', () => {
    console.log('not included') // [!code error]
  })
})
```

## toTestSpecification <Version>4.1.0</Version> {#totestspecification}

```ts
function toTestSpecification(testCases?: TestCase[]): TestSpecification
```

Gibt eine neue [Test-Spezifikation](/api/advanced/test-specification) zurück, mit der dieses konkrete Testmodul gefiltert oder ausgeführt werden kann.

Sie akzeptiert ein optionales Array von Testfällen, die gefiltert werden sollen.
