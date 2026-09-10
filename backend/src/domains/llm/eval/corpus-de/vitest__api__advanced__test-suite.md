# TestSuite

Die Klasse `TestSuite` repräsentiert eine einzelne Suite. Diese Klasse ist nur im Hauptthread verfügbar. Wenn Sie mit Laufzeit-Tasks arbeiten, sehen Sie in der ["Runner API"](/api/advanced/runner#tasks) nach.

Die `TestSuite`-Instanz besitzt immer eine `type`-Eigenschaft mit dem Wert `suite`. Damit können Sie verschiedene Task-Typen unterscheiden:

```ts
if (task.type === 'suite') {
  task // TestSuite
}
```

## project

Dies verweist auf das [`TestProject`](/api/advanced/test-project), zu dem der Test gehört.

## module

Dies ist eine direkte Referenz auf das [`TestModule`](/api/advanced/test-module), in dem der Test definiert ist.

## name

Dies ist ein Suite-Name, der an die Funktion `describe` übergeben wurde.

```ts
import { describe } from 'vitest'

// [!code word:'the validation logic']
describe('the validation logic', () => {
  // ...
})
```

## fullName

Der Name der Suite einschließlich aller übergeordneten Suites, getrennt durch das Symbol `>`. Diese Suite hat den vollständigen Namen "the validation logic > validating cities":

```ts
import { describe, test } from 'vitest'

// [!code word:'the validation logic']
// [!code word:'validating cities']
describe('the validation logic', () => {
  describe('validating cities', () => {
    // ...
  })
})
```

## id

Dies ist der eindeutige Bezeichner der Suite. Diese ID ist deterministisch und bleibt für dieselbe Suite über mehrere Läufe hinweg gleich. Die ID basiert auf dem Namen des [Projekts](/api/advanced/test-project), der Modul-ID und der Reihenfolge der Suite.

Die ID sieht so aus:

```
1223128da3_0_0_0
^^^^^^^^^^ the file hash
           ^ suite index
             ^ nested suite index
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
Versuchen Sie nicht, die ID zu parsen. Sie kann am Anfang ein Minus haben: `-1223128da3_0_0_0`.
:::

## location

Die Stelle im Modul, an der die Suite definiert wurde. Positionen werden nur erfasst, wenn [`includeTaskLocation`](/config/includetasklocation) in der Konfiguration aktiviert ist. Beachten Sie, dass diese Option automatisch aktiviert wird, wenn die Flags `--reporter=html`, `--ui` oder `--browser` verwendet werden.

Die Position dieser Suite ist gleich `{ line: 3, column: 1 }`:

```ts:line-numbers {3}
import { describe } from 'vitest'

describe('the validation works correctly', () => {
  // ...
})
```

## parent

Übergeordnete Suite. Wurde die Suite direkt innerhalb des [Moduls](/api/advanced/test-module) aufgerufen, ist das Modul selbst das übergeordnete Element.

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
  readonly mode: 'run' | 'only' | 'skip' | 'todo'
}
```

Die Optionen, mit denen die Suite erfasst wurde.

## children

Dies ist eine [Collection](/api/advanced/test-collection) aller Suites und Tests innerhalb der aktuellen Suite.

```ts
for (const task of suite.children) {
  if (task.type === 'test') {
    console.log('test', task.fullName)
  }
  else {
    // task is TaskSuite
    console.log('suite', task.name)
  }
}
```

::: warning
Beachten Sie, dass `suite.children` nur die erste Verschachtelungsebene durchläuft und nicht tiefer geht. Wenn Sie über alle Tests oder Suites iterieren müssen, verwenden Sie [`children.allTests()`](/api/advanced/test-collection#alltests) oder [`children.allSuites()`](/api/advanced/test-collection#allsuites). Wenn Sie über alles iterieren müssen, verwenden Sie eine rekursive Funktion:

```ts
function visit(collection: TestCollection) {
  for (const task of collection) {
    if (task.type === 'suite') {
      // report a suite
      visit(task.children)
    }
    else {
      // report a test
    }
  }
}
```
:::

## ok

```ts
function ok(): boolean
```

Prüft, ob die Suite fehlgeschlagene Tests enthält. Dies gibt auch `false` zurück, wenn die Suite während der Erfassung fehlgeschlagen ist. Prüfen Sie in diesem Fall [`errors()`](#errors) auf geworfene Fehler.

## state

```ts
function state(): TestSuiteState
```

Prüft den Ausführungszustand der Suite. Mögliche Rückgabewerte:

- **pending**: Die Tests in dieser Suite sind noch nicht fertig ausgeführt.
- **failed**: Diese Suite enthält fehlgeschlagene Tests oder sie konnten nicht erfasst werden. Ist [`errors()`](#errors) nicht leer, bedeutet das, dass die Suite die Tests nicht erfassen konnte.
- **passed**: Jeder Test innerhalb dieser Suite war erfolgreich.
- **skipped**: Diese Suite wurde während der Erfassung übersprungen.

::: warning
Beachten Sie, dass das [Testmodul](/api/advanced/test-module) ebenfalls eine `state`-Methode besitzt, die dieselben Werte zurückgibt, zusätzlich aber den Zustand `queued` liefern kann, wenn das Modul noch nicht ausgeführt wurde.
:::

## errors

```ts
function errors(): TestError[]
```

Fehler, die außerhalb des Testlaufs während der Erfassung aufgetreten sind, etwa Syntaxfehler.

```ts {4}
import { describe } from 'vitest'

describe('collection failed', () => {
  throw new Error('a custom error')
})
```

::: warning
Beachten Sie, dass Fehler in einfache Objekte serialisiert werden: `instanceof Error` gibt immer `false` zurück.
:::

## meta <Version>3.1.0</Version> {#meta}

```ts
function meta(): TaskMeta
```

Eigene [Metadaten](/api/advanced/metadata), die der Suite während ihrer Ausführung oder Erfassung angehängt wurden. Seit Vitest 4.1 können die Metadaten durch Angabe eines `meta`-Objekts während der Testerfassung angehängt werden:

```ts {7,10}
import { describe, test, TestRunner } from 'vitest'

describe('the validation works correctly', { meta: { decorated: true } }, () => {
  test('some test', ({ task }) => {
    // assign "decorated" during test run, it will be available
    // only in onTestCaseReady hook
    task.suite.meta.decorated = false

    // tests inherit suite's metadata
    task.meta.decorated === true
  })
})
```

Beachten Sie, dass Suite-Metadaten seit Vitest 4.1 von Tests geerbt werden.

:::tip
Wurden Metadaten während der Erfassung (außerhalb der `test`-Funktion) angehängt, stehen sie im Hook [`onTestModuleCollected`](./reporters#ontestmodulecollected) des eigenen Reporters zur Verfügung.
:::

## logs <Version>5.0.0</Version> {#logs}

```ts
function logs(): ReadonlyArray<UserConsoleLog>
```

Konsolenausgaben, die während der Testerfassung dieser Suite aufgezeichnet wurden. Zum Beispiel:

```ts
describe('suite', () => {
  console.log('included') // [!code highlight]

  beforeAll(() => {
    console.log('included') // [!code highlight]
  })

  test('test', () => {
    console.log('not included') // [!code error]
  })
})
```

## toTestSpecification <Version>4.1.0</Version> {#totestspecification}

```ts
function toTestSpecification(): TestSpecification
```

Gibt eine neue [Test-Specification](/api/advanced/test-specification) zurück, mit der sich diese konkrete Test-Suite filtern oder ausführen lässt.
