# TestCase

Die Klasse `TestCase` repräsentiert einen einzelnen Test. Diese Klasse ist nur im Haupt-Thread verfügbar. Sehen Sie in der [„Runner API“](/api/advanced/runner#tasks) nach, wenn Sie mit Laufzeit-Tasks arbeiten.

Die `TestCase`-Instanz besitzt stets eine Eigenschaft `type` mit dem Wert `test`. Damit können Sie zwischen verschiedenen Task-Typen unterscheiden:

```ts
if (task.type === 'test') {
  task // TestCase
}
```

## project

Verweist auf das [`TestProject`](/api/advanced/test-project), zu dem der Test gehört.

## module

Dies ist eine direkte Referenz auf das [`TestModule`](/api/advanced/test-module), in dem der Test definiert ist.

## name

Dies ist der Testname, der an die Funktion `test` übergeben wurde.

```ts
import { test } from 'vitest'

// [!code word:'the validation works correctly']
test('the validation works correctly', () => {
  // ...
})
```

## fullName

Der Name des Tests einschließlich aller übergeordneten Suites, getrennt durch das Symbol `>`. Dieser Test hat den vollständigen Namen „the validation logic > the validation works correctly“:

```ts
import { describe, test } from 'vitest'

// [!code word:'the validation works correctly']
// [!code word:'the validation logic']
describe('the validation logic', () => {
  test('the validation works correctly', () => {
    // ...
  })
})
```

## id

Dies ist der eindeutige Bezeichner des Tests. Diese ID ist deterministisch und bleibt für denselben Test über mehrere Läufe hinweg gleich. Die ID basiert auf dem Namen des [Projekts](/api/advanced/test-project), der Modul-ID und der Testreihenfolge.

Die ID sieht so aus:

```
1223128da3_0_0
^^^^^^^^^^ the file hash
           ^ suite index
             ^ test index
```

::: tip
Sie können den Datei-Hash mit der Funktion `generateFileHash` aus `vitest/node` erzeugen, die seit Vitest 3 verfügbar ist:

```ts
import { generateFileHash } from 'vitest/node'

const hash = generateFileHash(
  '/file/path.js', // relative path
  undefined, // the project name or `undefined` is not set
)
```
:::

::: danger
Versuchen Sie nicht, die ID zu parsen. Sie kann am Anfang ein Minus enthalten: `-1223128da3_0_0_0`.
:::

## location

Die Stelle im Modul, an der der Test definiert wurde. Positionen werden nur erfasst, wenn [`includeTaskLocation`](/config/includetasklocation) in der Konfiguration aktiviert ist. Beachten Sie, dass diese Option automatisch aktiviert wird, wenn die Flags `--reporter=html`, `--ui` oder `--browser` verwendet werden.

Die Position dieses Tests entspricht `{ line: 3, column: 1 }`:

```ts:line-numbers {3}
import { test } from 'vitest'

test('the validation works correctly', () => {
  // ...
})
```

## parent

Übergeordnete [Suite](/api/advanced/test-suite). Wurde der Test direkt innerhalb des [Moduls](/api/advanced/test-module) aufgerufen, ist das Modul selbst der Parent.

## options

```ts
interface TaskOptions {
  readonly each: boolean | undefined
  readonly fails: boolean | undefined
  readonly concurrent: boolean | undefined
  readonly shuffle: boolean | undefined
  readonly retry: number | undefined
  readonly repeats: number | undefined
  readonly tags: string[] | undefined
  readonly timeout: number | undefined
  readonly mode: 'run' | 'only' | 'skip' | 'todo'
}
```

Die Optionen, mit denen der Test erfasst wurde.

## tags <Version>4.1.0</Version> {#tags}

[Tags](/guide/test-tags), die dem Test implizit oder explizit zugewiesen wurden.

## ok

```ts
function ok(): boolean
```

Prüft, ob der Test die Suite nicht hat fehlschlagen lassen. Ist der Test noch nicht abgeschlossen oder wurde er übersprungen, gibt die Funktion `true` zurück.

## meta

```ts
function meta(): TaskMeta
```

Eigene [Metadaten](/api/advanced/metadata), die dem Test während seiner Ausführung angehängt wurden. Die Meta-Daten lassen sich anhängen, indem während eines Testlaufs eine Eigenschaft auf dem Objekt `ctx.task.meta` gesetzt wird:

```ts {3,6}
import { test } from 'vitest'

test('the validation works correctly', ({ task }) => {
  // ...

  task.meta.decorated = false
})
```

Ist der Test noch nicht fertig ausgeführt, sind die Meta-Daten ein leeres Objekt, sofern keine statischen Meta-Daten vorliegen:

```ts
test('the validation works correctly', { meta: { decorated: true } })
```

Seit Vitest 4.1 erbt Vitest die auf der [Suite](/api/advanced/test-suite) definierte Eigenschaft [`meta`](/api/advanced/test-suite#meta).

## result

```ts
function result(): TestResult
```

Testergebnisse. Ist der Test noch nicht abgeschlossen oder gerade erst erfasst worden, entspricht das Ergebnis `TestResultPending`:

```ts
export interface TestResultPending {
  /**
   * The test was collected, but didn't finish running yet.
   */
  readonly state: 'pending'
  /**
   * Pending tests have no errors.
   */
  readonly errors: undefined
}
```

Wurde der Test übersprungen, ist der Rückgabewert `TestResultSkipped`:

```ts
interface TestResultSkipped {
  /**
   * The test was skipped with `skip` or `todo` flag.
   * You can see which one was used in the `options.mode` option.
   */
  readonly state: 'skipped'
  /**
   * Skipped tests have no errors.
   */
  readonly errors: undefined
  /**
   * A custom note passed down to `ctx.skip(note)`.
   */
  readonly note: string | undefined
}
```

::: tip
Wurde der Test übersprungen, weil ein anderer Test das `only`-Flag trägt, ist `options.mode` gleich `skip`.
:::

Ist der Test fehlgeschlagen, ist der Rückgabewert `TestResultFailed`:

```ts
interface TestResultFailed {
  /**
   * The test failed to execute.
   */
  readonly state: 'failed'
  /**
   * Errors that were thrown during the test execution.
   */
  readonly errors: ReadonlyArray<TestError>
}
```

War der Test erfolgreich, ist der Rückgabewert `TestResultPassed`:

```ts
interface TestResultPassed {
  /**
   * The test passed successfully.
   */
  readonly state: 'passed'
  /**
   * Errors that were thrown during the test execution.
   */
  readonly errors: ReadonlyArray<TestError> | undefined
}
```

::: warning
Beachten Sie, dass einem Test mit dem Zustand `passed` dennoch Fehler angehängt sein können – das kann passieren, wenn `retry` mindestens einmal ausgelöst wurde.
:::

## diagnostic

```ts
function diagnostic(): TestDiagnostic | undefined
```

Nützliche Informationen über den Test wie Dauer, Speicherverbrauch usw.:

```ts
interface TestDiagnostic {
  /**
   * If the duration of the test is above `slowTestThreshold`.
   */
  readonly slow: boolean
  /**
   * The amount of memory used by the test in bytes.
   * This value is only available if the test was executed with `logHeapUsage` flag.
   */
  readonly heap: number | undefined
  /**
   * The time it takes to execute the test in ms.
   */
  readonly duration: number
  /**
   * The time in ms when the test started.
   */
  readonly startTime: number
  /**
   * The amount of times the test was retried.
   */
  readonly retryCount: number
  /**
   * The amount of times the test was repeated as configured by `repeats` option.
   * This value can be lower if the test failed during the repeat and no `retry` is configured.
   */
  readonly repeatCount: number
  /**
   * If test passed on a second retry.
   */
  readonly flaky: boolean
}
```

::: info
`diagnostic()` gibt `undefined` zurück, wenn der Test noch nicht zur Ausführung eingeplant wurde.
:::

## annotations

```ts
function annotations(): ReadonlyArray<TestAnnotation>
```

[Test-Annotationen](/guide/test-annotations), die während der Testausführung über die API [`task.annotate`](/guide/test-context#annotate) hinzugefügt wurden.

## artifacts <Version type="experimental">4.0.11</Version> <Experimental /> {#artifacts}

```ts
function artifacts(): ReadonlyArray<TestArtifact>
```

[Test-Artefakte](/api/advanced/artifacts), die während der Testausführung über die `recordArtifact`-API aufgezeichnet wurden.

## toTestSpecification <Version>4.1.0</Version> {#totestspecification}

```ts
function toTestSpecification(): TestSpecification
```

Gibt eine neue [Test-Specification](/api/advanced/test-specification) zurück, mit der sich dieser konkrete Testfall filtern oder ausführen lässt.

## logs <Version>5.0.0</Version> {#logs}

```ts
function logs(): ReadonlyArray<UserConsoleLog>
```

Konsolenausgaben, die während der Testausführung aufgezeichnet wurden.
