# Runner-API <Badge type="danger">advanced</Badge>

::: warning
Dies ist eine Advanced-API. Wenn Sie einfach nur [Tests ausführen](/guide/) möchten, brauchen Sie das vermutlich nicht. Sie wird in erster Linie von Bibliotheksautoren verwendet.
:::

Über die Option `runner` in Ihrer Konfigurationsdatei können Sie einen Pfad zu Ihrem eigenen Test-Runner angeben. Diese Datei sollte einen Default-Export mit einem Klassenkonstruktor haben, der diese Methoden implementiert:

```ts
export interface VitestRunner {
  /**
   * First thing that's getting called before actually collecting and running tests.
   */
  onBeforeCollect?: (paths: string[]) => unknown
  /**
   * Called after collecting tests and before "onBeforeRun".
   */
  onCollected?: (files: File[]) => unknown

  /**
   * Called when test runner should cancel next test runs.
   * Runner should listen for this method and mark tests and suites as skipped in
   * "onBeforeRunSuite" and "onBeforeRunTask" when called.
   */
  onCancel?: (reason: CancelReason) => unknown

  /**
   * Called before running a single test. Doesn't have "result" yet.
   */
  onBeforeRunTask?: (test: Test) => unknown
  /**
   * Called before actually running the test function. Already has "result" with "state" and "startTime".
   */
  onBeforeTryTask?: (test: Test, options: { retry: number; repeats: number }) => unknown
  /**
   * Called after result and state are set.
   */
  onAfterRunTask?: (test: Test) => unknown
  /**
   * Called right after running the test function. Doesn't have new state yet. Will not be called, if the test function throws.
   */
  onAfterTryTask?: (test: Test, options: { retry: number; repeats: number }) => unknown
  /**
   * Called after the retry resolution happened. Unlike `onAfterTryTask`, the test now has a new state.
   * All `after` hooks were also called by this point.
   */
  onAfterRetryTask?: (test: Test, options: { retry: number; repeats: number }) => unknown

  /**
   * Called before running a single suite. Doesn't have "result" yet.
   */
  onBeforeRunSuite?: (suite: Suite) => unknown
  /**
   * Called after running a single suite. Has state and result.
   */
  onAfterRunSuite?: (suite: Suite) => unknown

  /**
   * If defined, will be called instead of usual Vitest suite partition and handling.
   * "before" and "after" hooks will not be ignored.
   */
  runSuite?: (suite: Suite) => Promise<void>
  /**
   * If defined, will be called instead of usual Vitest handling. Useful, if you have your custom test function.
   * "before" and "after" hooks will not be ignored.
   */
  runTask?: (test: TaskPopulated) => Promise<void>

  /**
   * Called, when a task is updated. The same as "onTaskUpdate" in a reporter, but this is running in the same thread as tests.
   */
  onTaskUpdate?: (task: [string, TaskResult | undefined, TaskMeta | undefined][]) => Promise<void>

  /**
   * Called before running all tests in collected paths.
   */
  onBeforeRunFiles?: (files: File[]) => unknown
  /**
   * Called right after running all tests in collected paths.
   */
  onAfterRunFiles?: (files: File[]) => unknown
  /**
   * Called when new context for a test is defined. Useful, if you want to add custom properties to the context.
   * If you only want to define custom context with a runner, consider using "beforeAll" in "setupFiles" instead.
   */
  extendTaskContext?: (context: TestContext) => TestContext
  /**
   * Called when certain files are imported. Can be called in two situations: to collect tests and to import setup files.
   */
  importFile: (filepath: string, source: VitestRunnerImportSource) => unknown
  /**
   * Function that is called when the runner attempts to get the value when `test.extend` is used with `{ injected: true }`
   */
  injectValue?: (key: string) => unknown
  /**
   * Publicly available configuration.
   */
  config: SerializedConfig
  /**
   * The name of the current pool. Can affect how stack trace is inferred on the server side.
   */
  pool?: string
}
```

Beim Initialisieren dieser Klasse übergibt Vitest die Vitest-Konfiguration — Sie sollten sie als Eigenschaft `config` bereitstellen:

```ts [runner.ts]
import type { RunnerTestFile, SerializedConfig, TestRunner, VitestTestRunner } from 'vitest'

class CustomRunner extends TestRunner implements VitestTestRunner {
  public config: SerializedConfig

  constructor(config: SerializedConfig) {
    this.config = config
  }

  onAfterRunFiles(files: RunnerTestFile[]) {
    console.log('finished running', files)
  }
}

export default CustomRunner
```

::: warning
Vitest injiziert außerdem eine Instanz von `ModuleRunner` aus `vite/module-runner` als Eigenschaft `moduleRunner`. Sie können sie nutzen, um Dateien in der Methode `importFile` zu verarbeiten (das ist das Standardverhalten von `TestRunner` und `BenchmarkRunner`).

`ModuleRunner` stellt eine Methode `import` bereit, die verwendet wird, um Testdateien in einer Vite-freundlichen Umgebung zu importieren. Das heißt, sie löst Imports auf und transformiert Dateiinhalte zur Laufzeit, damit Node sie versteht:

```ts
export default class Runner {
  async importFile(filepath: string) {
    await this.moduleRunner.import(filepath)
  }
}
```
:::

::: warning
Wenn Sie keinen eigenen Runner haben oder keine Methode `runTest` definiert haben, versucht Vitest, einen Task automatisch zu ermitteln. Falls Sie keine Funktion mit `setFn` hinzugefügt haben, schlägt das fehl.
:::

::: tip
Snapshot-Unterstützung und einige weitere Funktionen hängen vom Runner ab. Wenn Sie sie nicht verlieren möchten, können Sie Ihren Runner von `TestRunner` aus `vitest` ableiten. Vitest stellt außerdem `NodeBenchmarkRunner` bereit, falls Sie die Benchmark-Funktionalität erweitern möchten.
:::

## Tasks

::: warning
Die „Runner Tasks API“ ist experimentell und sollte in erster Linie nur in der Test-Laufzeit verwendet werden. Vitest stellt außerdem die [„Reported Tasks API“](/api/advanced/test-module) bereit, die bei Arbeiten im Hauptthread (etwa innerhalb eines Reporters) vorzuziehen ist.

Das Team diskutiert derzeit, ob „Runner Tasks“ künftig durch „Reported Tasks“ ersetzt werden sollen.
:::

Suites und Tests heißen intern `tasks`. Der Vitest-Runner initialisiert einen `File`-Task, bevor er irgendwelche Tests sammelt — das ist eine Obermenge von `Suite` mit einigen zusätzlichen Eigenschaften. Er ist an jedem Task (einschließlich `File`) als Eigenschaft `file` verfügbar.

```ts
interface File extends Suite {
  /**
   * The name of the pool that the file belongs to.
   * @default 'forks'
   */
  pool?: string
  /**
   * The path to the file in UNIX format.
   */
  filepath: string
  /**
   * The name of the test project the file belongs to.
   */
  projectName: string | undefined
  /**
   * The time it took to collect all tests in the file.
   * This time also includes importing all the file dependencies.
   */
  collectDuration?: number
  /**
   * The time it took to import the setup file.
   */
  setupDuration?: number
}
```

Jede Suite hat eine Eigenschaft `tasks`, die während der Sammelphase gefüllt wird. Sie ist nützlich, um den Task-Baum von oben nach unten zu durchlaufen.

```ts
interface Suite extends TaskBase {
  type: 'suite'
  /**
   * File task. It's the root task of the file.
   */
  file: File
  /**
   * An array of tasks that are part of the suite.
   */
  tasks: Task[]
}
```

Jeder Task hat eine Eigenschaft `suite`, die auf die Suite verweist, in der er liegt. Werden `test` oder `describe` auf oberster Ebene aufgerufen, haben sie keine `suite`-Eigenschaft (sie ist **nicht** gleich `file`!). Auch `File` hat nie eine `suite`-Eigenschaft. Sie ist nützlich, um die Tasks von unten nach oben zu durchlaufen.

```ts
interface Test<ExtraContext = object> extends TaskBase {
  type: 'test'
  /**
   * Test context that will be passed to the test function.
   */
  context: TestContext & ExtraContext
  /**
   * File task. It's the root task of the file.
   */
  file: File
  /**
   * Whether the task was skipped by calling `context.skip()`.
   */
  pending?: boolean
  /**
   * Whether the task should succeed if it fails. If the task fails, it will be marked as passed.
   */
  fails?: boolean
  /**
   * Store promises (from async expects) to wait for them before finishing the test
   */
  promises?: Promise<any>[]
}
```

Jeder Task kann ein Feld `result` haben. Suites können dieses Feld nur dann haben, wenn ein Fehler im Suite-Callback oder in `beforeAll`/`afterAll`-Callbacks sie daran hindert, Tests zu sammeln. Tests haben dieses Feld immer, nachdem ihre Callbacks aufgerufen wurden — die Felder `state` und `errors` sind je nach Ergebnis vorhanden. Wurde in `beforeEach`- oder `afterEach`-Callbacks ein Fehler geworfen, findet sich dieser in `task.result.errors`.

```ts
export interface TaskResult {
  /**
   * State of the task. Inherits the `task.mode` during collection.
   * When the task has finished, it will be changed to `pass` or `fail`.
   * - **pass**: task ran successfully
   * - **fail**: task failed
   */
  state: TaskState
  /**
   * Errors that occurred during the task execution. It is possible to have several errors
   * if `expect.soft()` failed multiple times.
   */
  errors?: TestError[]
  /**
   * How long in milliseconds the task took to run.
   */
  duration?: number
  /**
   * Time in milliseconds when the task started running.
   */
  startTime?: number
  /**
   * Heap size in bytes after the task finished.
   * Only available if `logHeapUsage` option is set and `process.memoryUsage` is defined.
   */
  heap?: number
  /**
   * State of related to this task hooks. Useful during reporting.
   */
  hooks?: Partial<Record<'afterAll' | 'beforeAll' | 'beforeEach' | 'afterEach', TaskState>>
  /**
   * The amount of times the task was retried. The task is retried only if it
   * failed and `retry` option is set.
   */
  retryCount?: number
  /**
   * The amount of times the task was repeated. The task is repeated only if
   * `repeats` option is set. This number also contains `retryCount`.
   */
  repeatCount?: number
}
```

## Ihre eigene Task-Funktion

Vitest stellt das Hilfsmittel `createTaskCollector` bereit, um eine eigene `test`-Methode zu erstellen. Sie verhält sich wie ein Test, ruft während der Sammelphase aber eine eigene Methode auf.

Ein Task ist ein Objekt, das Teil einer Suite ist. Er wird der aktuellen Suite automatisch über die Methode `suite.task` hinzugefügt:

```js [custom.js]
export { afterAll, beforeAll, describe, TestRunner } from 'vitest'

// this function will be called during collection phase:
// don't call function handler here, add it to suite tasks
// with "getCurrentSuite().task()" method
// note: createTaskCollector provides support for "todo"/"each"/...
export const myCustomTask = TestRunner.createTaskCollector(
  function (name, fn, timeout) {
    TestRunner.getCurrentSuite().task(name, {
      ...this, // so "todo"/"skip"/... is tracked correctly
      meta: {
        customPropertyToDifferentiateTask: true
      },
      handler: fn,
      timeout,
    })
  }
)
```

```js [tasks.test.js]
import {
  afterAll,
  beforeAll,
  describe,
  myCustomTask
} from './custom.js'
import { gardener } from './gardener.js'

describe('take care of the garden', () => {
  beforeAll(() => {
    gardener.putWorkingClothes()
  })

  myCustomTask('weed the grass', () => {
    gardener.weedTheGrass()
  })
  myCustomTask.todo('mow the lawn', () => {
    gardener.mowerTheLawn()
  })
  myCustomTask('water flowers', () => {
    gardener.waterFlowers()
  })

  afterAll(() => {
    gardener.goHome()
  })
})
```

```bash
vitest ./garden/tasks.test.js
```
