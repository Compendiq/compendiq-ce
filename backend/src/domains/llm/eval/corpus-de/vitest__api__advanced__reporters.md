# Reporter

::: warning
Dies ist eine fortgeschrittene API. Wenn du lediglich die eingebauten Reporter konfigurieren möchtest, lies den Leitfaden ["Reporters"](/guide/reporters).
:::

Vitest hat seinen eigenen Lebenszyklus für Testläufe. Dieser wird durch die Methoden des Reporters abgebildet:

- [`onInit`](#oninit)
- [`onTestRunStart`](#ontestrunstart)
  - [`onTestModuleQueued`](#ontestmodulequeued)
  - [`onTestModuleCollected`](#ontestmodulecollected)
  - [`onTestModuleStart`](#ontestmodulestart)
    - [`onTestSuiteReady`](#ontestsuiteready)
      - [`onHookStart(beforeAll)`](#onhookstart)
      - [`onHookEnd(beforeAll)`](#onhookend)
        - [`onTestCaseReady`](#ontestcaseready)
          - [`onTestCaseAnnotate`](#ontestcaseannotate) <Version>3.2.0</Version>
          - [`onTestCaseArtifactRecord`](#ontestcaseartifactrecord) <Version type="experimental">4.0.11</Version>
          - [`onHookStart(beforeEach)`](#onhookstart)
          - [`onHookEnd(beforeEach)`](#onhookend)
          - [`onHookStart(afterEach)`](#onhookstart)
          - [`onHookEnd(afterEach)`](#onhookend)
        - [`onTestCaseResult`](#ontestcaseresult)
      - [`onHookStart(afterAll)`](#onhookstart)
      - [`onHookEnd(afterAll)`](#onhookend)
    - [`onTestSuiteResult`](#ontestsuiteresult)
  - [`onTestModuleEnd`](#ontestmoduleend)
  - [`onCoverage`](#oncoverage)
- [`onTestRunEnd`](#ontestrunend)

Tests und Suites innerhalb eines einzelnen Moduls werden der Reihe nach gemeldet, sofern sie nicht übersprungen wurden. Alle übersprungenen Tests werden am Ende der Suite bzw. des Moduls gemeldet.

Beachte, dass Vitest Testmodule parallel meldet, da sie parallel laufen können.

Dieser Leitfaden führt alle unterstützten Reporter-Methoden auf. Vergiss aber nicht, dass du, statt einen eigenen Reporter zu erstellen, auch [einen bestehenden erweitern](/guide/advanced/reporters) kannst:

```ts [custom-reporter.js]
import { BaseReporter } from 'vitest/node'

export default class CustomReporter extends BaseReporter {
  onTestRunEnd(testModules, errors) {
    console.log(testModule.length, 'tests finished running')
    super.onTestRunEnd(testModules, errors)
  }
}
```

## onInit

```ts
function onInit(vitest: Vitest): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn [Vitest](/api/advanced/vitest) initialisiert oder gestartet wurde, aber bevor die Tests gefiltert wurden.

::: info
Intern wird diese Methode innerhalb von [`vitest.start`](/api/advanced/vitest#start), [`vitest.standalone`](/api/advanced/vitest#standalone) oder [`vitest.mergeReports`](/api/advanced/vitest#mergereports) aufgerufen. Wenn du die programmatische API verwendest, achte darauf, je nach Bedarf eine davon aufzurufen, bevor du z. B. [`vitest.runTestSpecifications`](/api/advanced/vitest#runtestspecifications) aufrufst. Die eingebaute CLI ruft die Methoden immer in der richtigen Reihenfolge auf.
:::

Beachte, dass du über die Eigenschaft [`project`](/api/advanced/test-project) auch aus Testfällen, Suites und Testmodulen Zugriff auf die `vitest`-Instanz bekommst; es kann aber ebenfalls nützlich sein, in dieser Methode eine Referenz auf `vitest` zu speichern.

::: details Beispiel
```ts
import type { Reporter, TestSpecification, Vitest } from 'vitest/node'

class MyReporter implements Reporter {
  private vitest!: Vitest

  onInit(vitest: Vitest) {
    this.vitest = vitest
  }

  onTestRunStart(specifications: TestSpecification[]) {
    console.log(
      specifications.length,
      'test files will run in',
      this.vitest.config.root,
    )
  }
}

export default new MyReporter()
```
:::

## onBrowserInit {#onbrowserinit}

```ts
function onBrowserInit(project: TestProject): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn die Browser-Instanz initialisiert wird. Sie erhält eine Instanz des Projekts, für das der Browser initialisiert wird. `project.browser` ist immer definiert, wenn diese Methode aufgerufen wird.

## onTestRunStart

```ts
function onTestRunStart(
  specifications: TestSpecification[]
): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn ein neuer Testlauf gestartet wurde. Sie erhält ein Array von [Test-Spezifikationen](/api/advanced/test-specification), die zur Ausführung eingeplant sind. Dieses Array ist readonly und dient ausschließlich der Information.

Wenn Vitest keine auszuführenden Testdateien gefunden hat, wird dieses Event mit einem leeren Array ausgelöst, und danach wird unmittelbar [`onTestRunEnd`](#ontestrunend) aufgerufen.

::: details Beispiel
```ts
import type { Reporter, TestSpecification } from 'vitest/node'

class MyReporter implements Reporter {
  onTestRunStart(specifications: TestSpecification[]) {
    console.log(specifications.length, 'test files will run')
  }
}

export default new MyReporter()
```
:::

## onTestRunEnd

```ts
function onTestRunEnd(
  testModules: ReadonlyArray<TestModule>,
  unhandledErrors: ReadonlyArray<SerializedError>,
  reason: TestRunEndReason
): Awaitable<void>
```

Diese Methode wird aufgerufen, nachdem alle Tests durchgelaufen sind und die Coverage – sofern aktiviert – alle Reports zusammengeführt hat. Beachte, dass du die Coverage-Informationen im Hook [`onCoverage`](#oncoverage) erhältst.

Sie erhält eine readonly Liste von Testmodulen. Du kannst über die Eigenschaft [`testModule.children`](/api/advanced/test-collection) darüber iterieren, um Zustand und etwaige Fehler zu melden.

Das zweite Argument ist eine readonly Liste nicht behandelter Fehler, die Vitest keinem Test zuordnen konnte. Diese können außerhalb des Testlaufs durch einen Fehler in einem Plugin auftreten oder innerhalb des Testlaufs als Seiteneffekt einer nicht awaiteten Funktion (zum Beispiel ein Timeout, der einen Fehler geworfen hat, nachdem der Test bereits durchgelaufen war).

Das dritte Argument gibt an, warum der Testlauf beendet wurde:

- `passed`: Der Testlauf wurde normal beendet und es gibt keine Fehler
- `failed`: Der Testlauf hat mindestens einen Fehler (durch einen Syntaxfehler während der Erfassung oder einen tatsächlichen Fehler während der Testausführung)
- `interrupted`: Der Test wurde durch einen Aufruf von [`vitest.cancelCurrentRun`](/api/advanced/vitest#cancelcurrentrun) unterbrochen oder es wurde `Ctrl+C` im Terminal gedrückt (beachte, dass es in diesem Fall trotzdem fehlgeschlagene Tests geben kann)

Wenn Vitest keine auszuführenden Testdateien gefunden hat, wird dieses Event mit leeren Arrays für Module und Fehler ausgelöst, und der Zustand hängt vom Wert von [`config.passWithNoTests`](/config/passwithnotests) ab.

::: details Beispiel
```ts
import type {
  Reporter,
  SerializedError,
  TestModule,
  TestRunEndReason,
  TestSpecification
} from 'vitest/node'

class MyReporter implements Reporter {
  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ) {
    if (reason === 'passed') {
      testModules.forEach(module => console.log(module.moduleId, 'succeeded'))
    }
    else if (reason === 'failed') {
      // note that this will skip possible errors in suites
      // you can get them from testSuite.errors()
      for (const testCase of testModules.children.allTests()) {
        if (testCase.result().state === 'failed') {
          console.log(testCase.fullName, 'in', testCase.module.moduleId, 'failed')
          console.log(testCase.result().errors)
        }
      }
    }
    else {
      console.log('test run was interrupted, skipping report')
    }
  }
}

export default new MyReporter()
```
:::

## onCoverage

```ts
function onCoverage(coverage: unknown): Awaitable<void>
```

Dieser Hook wird aufgerufen, nachdem die Coverage-Ergebnisse verarbeitet wurden. Die Reporter des Coverage-Providers werden nach diesem Hook aufgerufen. Die Typisierung von `coverage` hängt von `coverage.provider` ab. Für die standardmäßig eingebauten Provider von Vitest kannst du die Typen aus dem Paket `istanbul-lib-coverage` importieren:

```ts
import type { CoverageMap } from 'istanbul-lib-coverage'

declare function onCoverage(coverage: CoverageMap): Awaitable<void>
```

Wenn Vitest keine Coverage ermittelt hat, wird dieser Hook nicht aufgerufen.

## onTestModuleQueued

```ts
function onTestModuleQueued(testModule: TestModule): Awaitable<void>
```

Diese Methode wird unmittelbar bevor Vitest die Setup-Datei und das Testmodul selbst importiert aufgerufen. Das bedeutet, dass `testModule` noch keine [`children`](/api/advanced/test-suite#children) hat, du es aber bereits als nächsten auszuführenden Test melden kannst.

## onTestModuleCollected

```ts
function onTestModuleCollected(testModule: TestModule): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn alle Tests innerhalb der Datei erfasst wurden, das heißt, die Sammlung [`testModule.children`](/api/advanced/test-suite#children) ist befüllt, aber die Tests haben noch keine Ergebnisse.

## onTestModuleStart

```ts
function onTestModuleStart(testModule: TestModule): Awaitable<void>
```

Diese Methode wird unmittelbar nach [`onTestModuleCollected`](#ontestmodulecollected) aufgerufen, es sei denn, Vitest läuft im Erfassungsmodus ([`vitest.collect()`](/api/advanced/vitest#collect) oder `vitest collect` in der CLI); in diesem Fall wird sie überhaupt nicht aufgerufen, da es keine auszuführenden Tests gibt.

## onTestModuleEnd

```ts
function onTestModuleEnd(testModule: TestModule): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn jeder Test im Modul durchgelaufen ist. Das bedeutet, jeder Test innerhalb von [`testModule.children`](/api/advanced/test-suite#children) hat ein `test.result()`, das nicht gleich `pending` ist.

## onHookStart

```ts
function onHookStart(context: ReportedHookContext): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn einer dieser Hooks zu laufen begonnen hat:

- `beforeAll`
- `afterAll`
- `beforeEach`
- `afterEach`

Wenn `beforeAll` oder `afterAll` gestartet werden, ist `entity` entweder [`TestSuite`](/api/advanced/test-suite) oder [`TestModule`](/api/advanced/test-module).

Wenn `beforeEach` oder `afterEach` gestartet werden, ist `entity` immer [`TestCase`](/api/advanced/test-case).

::: warning
Die Methode `onHookStart` wird nicht aufgerufen, wenn der Hook während des Testlaufs nicht ausgeführt wurde.
:::

## onHookEnd

```ts
function onHookEnd(context: ReportedHookContext): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn einer dieser Hooks durchgelaufen ist:

- `beforeAll`
- `afterAll`
- `beforeEach`
- `afterEach`

Wenn `beforeAll` oder `afterAll` abgeschlossen sind, ist `entity` entweder [`TestSuite`](/api/advanced/test-suite) oder [`TestModule`](/api/advanced/test-module).

Wenn `beforeEach` oder `afterEach` abgeschlossen sind, ist `entity` immer [`TestCase`](/api/advanced/test-case).

::: warning
Die Methode `onHookEnd` wird nicht aufgerufen, wenn der Hook während des Testlaufs nicht ausgeführt wurde.
:::

## onTestSuiteReady

```ts
function onTestSuiteReady(testSuite: TestSuite): Awaitable<void>
```

Diese Methode wird aufgerufen, bevor die Suite beginnt, ihre Tests auszuführen. Diese Methode wird auch aufgerufen, wenn die Suite übersprungen wurde.

Wenn die Datei keine Suites enthält, wird diese Methode nicht aufgerufen. Ziehe `onTestModuleStart` in Betracht, um diesen Fall abzudecken.

## onTestSuiteResult

```ts
function onTestSuiteResult(testSuite: TestSuite): Awaitable<void>
```

Diese Methode wird aufgerufen, nachdem die Suite ihre Tests ausgeführt hat. Diese Methode wird auch aufgerufen, wenn die Suite übersprungen wurde.

Wenn die Datei keine Suites enthält, wird diese Methode nicht aufgerufen. Ziehe `onTestModuleEnd` in Betracht, um diesen Fall abzudecken.

## onTestCaseReady

```ts
function onTestCaseReady(testCase: TestCase): Awaitable<void>
```

Diese Methode wird aufgerufen, bevor der Test zu laufen beginnt, oder wenn er übersprungen wurde. Beachte, dass die Hooks `beforeEach` und `afterEach` als Teil des Tests gelten, da sie das Ergebnis beeinflussen können.

::: warning
Beachte, dass [`testCase.result()`](/api/advanced/test-case#result) bereits den Zustand `passed` oder `failed` haben kann, wenn `onTestCaseReady` aufgerufen wird. Das kann passieren, wenn der Test sehr schnell lief und sowohl `onTestCaseReady` als auch `onTestCaseResult` im selben Microtask zur Ausführung eingeplant wurden.
:::

## onTestCaseResult

```ts
function onTestCaseResult(testCase: TestCase): Awaitable<void>
```

Diese Methode wird aufgerufen, wenn der Test durchgelaufen ist oder gerade übersprungen wurde. Beachte, dass sie aufgerufen wird, nachdem der `afterEach`-Hook abgeschlossen ist, sofern es welche gibt.

Zu diesem Zeitpunkt hat [`testCase.result()`](/api/advanced/test-case#result) einen Zustand ungleich pending.

## onTestCaseAnnotate <Version>3.2.0</Version> {#ontestcaseannotate}

```ts
function onTestCaseAnnotate(
  testCase: TestCase,
  annotation: TestAnnotation,
): Awaitable<void>
```

Der Hook `onTestCaseAnnotate` ist mit der Methode [`context.annotate`](/guide/test-context#annotate) verknüpft. Wird `annotate` aufgerufen, serialisiert Vitest die Annotation und sendet denselben Anhang an den Haupt-Thread, wo der Reporter damit arbeiten kann.

Ist der Pfad angegeben, speichert Vitest ihn in einem separaten Verzeichnis (konfiguriert über [`attachmentsDir`](/config/attachmentsdir)) und passt die Eigenschaft `path` so an, dass sie darauf verweist.

## onTestCaseArtifactRecord <Version type="experimental">4.0.11</Version> {#ontestcaseartifactrecord}

```ts
function onTestCaseArtifactRecord(
  testCase: TestCase,
  artifact: TestArtifact,
): Awaitable<void>
```

Der Hook `onTestCaseArtifactRecord` ist mit dem Hilfsmittel [`recordArtifact`](/api/advanced/artifacts#recordartifact) verknüpft. Wird `recordArtifact` aufgerufen, serialisiert Vitest es und sendet denselben Anhang an den Haupt-Thread, wo der Reporter damit arbeiten kann.

Ist der Pfad angegeben, speichert Vitest ihn in einem separaten Verzeichnis (konfiguriert über [`attachmentsDir`](/config/attachmentsdir)) und passt die Eigenschaft `path` so an, dass sie darauf verweist.

Hinweis: Annotationen erreichen diesen Hook nicht und erscheinen aus Gründen der Abwärtskompatibilität bis zur nächsten Major-Version nicht im Array `task.artifacts`, [obwohl sie auf dieser Funktion aufbauen](/api/advanced/artifacts#relationship-with-annotations).
