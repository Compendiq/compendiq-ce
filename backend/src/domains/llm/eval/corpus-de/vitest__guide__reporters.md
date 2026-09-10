# Reporter

Vitest bringt mehrere eingebaute Reporter mit, um Testausgaben in unterschiedlichen Formaten darzustellen, und erlaubt zusätzlich eigene Reporter. Sie können verschiedene Reporter entweder über die Kommandozeilenoption `--reporter` auswählen oder indem Sie eine Eigenschaft `reporters` in Ihrer [Konfigurationsdatei](/config/reporters) angeben. Ist kein Reporter angegeben, [wählt Vitest die Reporter automatisch](#default-configuration) anhand der Umgebung aus.

Reporter über die Kommandozeile verwenden:

```bash
npx vitest --reporter=verbose
```

Reporter über [`vitest.config.ts`](/config/) verwenden:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['verbose']
  },
})
```

Manche Reporter lassen sich anpassen, indem man ihnen zusätzliche Optionen übergibt. Reporter-spezifische Optionen sind in den Abschnitten unten beschrieben.

```ts
export default defineConfig({
  test: {
    reporters: [
      'default',
      ['junit', { suiteName: 'UI tests' }]
    ],
  },
})
```

## Standardkonfiguration

Ist `reporters` nicht konfiguriert, verwendet Vitest die folgenden Reporter:

- [`default`](#default-reporter) bei normalen Terminal-Läufen
- [`minimal`](#minimal-reporter), wenn Vitest einen KI-Coding-Agent erkennt
- [`github-actions`](#github-actions-reporter) wird ergänzt, wenn `process.env.GITHUB_ACTIONS === 'true'`

Wenn Sie eigene Reporter konfigurieren, ersetzt die konfigurierte Liste die Standardliste. Um einen Reporter zu ergänzen und die Standards von Vitest beizubehalten, erweitern Sie `configDefaults.reporters`:

```ts
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['json', ...configDefaults.reporters],
  },
})
```

## Reporter-Ausgabe

Standardmäßig geben die Reporter von Vitest ihre Ausgabe im Terminal aus. Die Reporter `json`, `junit` und `html` schreiben stattdessen an einen jeweils eigenen Ort unterhalb von `.vitest/`:

- `json` schreibt nach `.vitest/json/output.json`
- `junit` schreibt nach `.vitest/junit/output.xml`
- `html` schreibt nach `.vitest/index.html`

Die Orte für `json` und `junit` lassen sich über die [Konfigurationsoption](/config/outputfile) `outputFile` in Ihrer Vitest-Konfigurationsdatei oder über die CLI überschreiben. Der Reporter `html` verwendet stattdessen seine Option [`outputDir`](#html-reporter).

:::code-group
```bash [CLI]
npx vitest --reporter=json --outputFile=./test-output.json
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['json'],
    outputFile: './test-output.json'
  },
})
```
:::

Die Reporter `json` und `junit` akzeptieren `outputFile` außerdem als Reporter-Option, die Vorrang vor dem `outputFile` auf oberster Ebene hat:

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: [['json', { outputFile: './test-output.json' }]],
  },
})
```

Um den Report im Terminal auszugeben, statt ihn in eine Datei zu schreiben, setzen Sie die Option `stdout` am Reporter `json` oder `junit`. Sie wird ignoriert, wenn `outputFile` gesetzt ist:

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: [['json', { stdout: true }]],
  },
})
```

::: warning
Ist `stdout` aktiviert, kann sich der Report mit anderer Ausgabe vermischen, die direkt ins Terminal geschrieben wird – etwa `process.stdout.write` in einer Testdatei oder Logs aus dem Hauptprozess wie aus einer Global-Setup-Datei –, wodurch das JSON oder XML unparsebar werden kann. Bevorzugen Sie die standardmäßige Dateiausgabe, wenn Sie den Report programmatisch verarbeiten möchten.
:::

## Reporter kombinieren

Sie können mehrere Reporter gleichzeitig verwenden, um Ihre Testergebnisse in verschiedenen Formaten auszugeben. Zum Beispiel:

```bash
npx vitest --reporter=json --reporter=default
```

```ts
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['json', ...configDefaults.reporters],
    outputFile: './test-output.json'
  },
})
```

Das obige Beispiel gibt die Testergebnisse sowohl im Standardstil im Terminal aus als auch als JSON in die angegebene Ausgabedatei.

Bei Verwendung mehrerer Reporter lassen sich auch mehrere Ausgabedateien festlegen, und zwar so:

```ts
export default defineConfig({
  test: {
    reporters: ['junit', 'json', 'verbose'],
    outputFile: {
      junit: './junit-report.xml',
      json: './json-report.json',
    },
  },
})
```

Dieses Beispiel schreibt getrennte JSON- und XML-Reports und gibt zusätzlich einen ausführlichen Report im Terminal aus.

## Eingebaute Reporter

### Default-Reporter

Der Reporter `default` zeigt unten eine Zusammenfassung der laufenden Tests und ihres Status. Sobald eine Suite erfolgreich ist, wird ihr Status oberhalb der Zusammenfassung gemeldet.

Sie können die Zusammenfassung deaktivieren, indem Sie den Reporter konfigurieren:

:::code-group
```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: [
      ['default', { summary: false }]
    ]
  },
})
```
:::

Beispielausgabe für laufende Tests:

```bash
 ✓ test/example-1.test.ts (5 tests | 1 skipped) 306ms
 ✓ test/example-2.test.ts (5 tests | 1 skipped) 307ms

 ❯ test/example-3.test.ts 3/5
 ❯ test/example-4.test.ts 1/5

 Test Files 2 passed (4)
      Tests 10 passed | 3 skipped (65)
   Start at 11:01:36
   Duration 2.00s
```

Endgültige Ausgabe nach Abschluss der Tests:

```bash
 ✓ test/example-1.test.ts (5 tests | 1 skipped) 306ms
 ✓ test/example-2.test.ts (5 tests | 1 skipped) 307ms
 ✓ test/example-3.test.ts (5 tests | 1 skipped) 307ms
 ✓ test/example-4.test.ts (5 tests | 1 skipped) 307ms

 Test Files  4 passed (4)
      Tests  16 passed | 4 skipped (20)
   Start at  12:34:32
   Duration  1.26s (transform 35ms, setup 1ms, collect 90ms, tests 1.47s, environment 0ms, prepare 267ms)
```

Läuft nur eine einzige Testdatei, gibt Vitest den vollständigen Testbaum dieser Datei aus, ähnlich dem Reporter [`tree`](#tree-reporter). Der Default-Reporter gibt den Testbaum außerdem aus, wenn in der Datei mindestens ein Test fehlgeschlagen ist.

```bash
✓ __tests__/file1.test.ts (2) 725ms
   ✓ first test file (2) 725ms
     ✓ 2 + 2 should equal 4
     ✓ 4 - 2 should equal 2

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  12:34:32
   Duration  1.26s (transform 35ms, setup 1ms, collect 90ms, tests 1.47s, environment 0ms, prepare 267ms)
```

### Verbose-Reporter

Der Verbose-Reporter gibt jeden Testfall aus, sobald er abgeschlossen ist. Suites oder Dateien meldet er nicht gesondert. Ist `--includeTaskLocation` aktiviert, enthält die Ausgabe zusätzlich die Position jedes Tests. Ähnlich wie beim Reporter `default` können Sie die Zusammenfassung durch Konfiguration des Reporters deaktivieren.

Darüber hinaus gibt der Reporter `verbose` Testfehlermeldungen sofort aus. Der vollständige Testfehler wird nach Abschluss des Testlaufs gemeldet.

Dies ist der einzige Terminal-Reporter, der [Annotationen](/guide/test-annotations) auch dann meldet, wenn der Test nicht fehlschlägt.

:::code-group
```bash [CLI]
npx vitest --reporter=verbose
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: [
      ['verbose', { summary: false }]
    ]
  },
})
```
:::

Beispielausgabe:

```bash
✓ __tests__/file1.test.ts > first test file > 2 + 2 should equal 4 1ms
✓ __tests__/file1.test.ts > first test file > 4 - 2 should equal 2 1ms
✓ __tests__/file2.test.ts > second test file > 1 + 1 should equal 2 1ms
✓ __tests__/file2.test.ts > second test file > 2 - 1 should equal 1 1ms

 Test Files  2 passed (2)
      Tests  4 passed (4)
   Start at  12:34:32
   Duration  1.26s (transform 35ms, setup 1ms, collect 90ms, tests 1.47s, environment 0ms, prepare 267ms)
```

Ein Beispiel mit `--includeTaskLocation`:

```bash
✓ __tests__/file1.test.ts:2 > first test file > 2 + 2 should equal 4 1ms
✓ __tests__/file1.test.ts:3 > first test file > 4 - 2 should equal 2 1ms
✓ __tests__/file2.test.ts:2 > second test file > 1 + 1 should equal 2 1ms
✓ __tests__/file2.test.ts:3 > second test file > 2 - 1 should equal 1 1ms

 Test Files  2 passed (2)
      Tests  4 passed (4)
   Start at  12:34:32
   Duration  1.26s (transform 35ms, setup 1ms, collect 90ms, tests 1.47s, environment 0ms, prepare 267ms)
```

### Tree-Reporter

Der Tree-Reporter entspricht dem Reporter `default`, zeigt aber zusätzlich jeden einzelnen Test an, nachdem die Suite abgeschlossen ist. Ähnlich wie beim Reporter `default` können Sie die Zusammenfassung durch Konfiguration des Reporters deaktivieren.

:::code-group
```bash [CLI]
npx vitest --reporter=tree
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: [
      ['tree', { summary: false }]
    ]
  },
})
```
:::

Beispielausgabe für laufende Tests mit dem Standardwert `slowTestThreshold: 300`:

```bash
 ✓ __tests__/example-1.test.ts (2) 725ms
   ✓ first test file (2) 725ms
     ✓ 2 + 2 should equal 4
     ✓ 4 - 2 should equal 2

 ❯ test/example-2.test.ts 3/5
   ↳ should run longer than three seconds 1.57s
 ❯ test/example-3.test.ts 1/5

 Test Files 2 passed (4)
      Tests 10 passed | 3 skipped (65)
   Start at 11:01:36
   Duration 2.00s
```

Beispiel für die endgültige Terminalausgabe einer erfolgreichen Test-Suite:

```bash
✓ __tests__/file1.test.ts (2) 725ms
   ✓ first test file (2) 725ms
     ✓ 2 + 2 should equal 4
     ✓ 4 - 2 should equal 2
✓ __tests__/file2.test.ts (2) 746ms
  ✓ second test file (2) 746ms
    ✓ 1 + 1 should equal 2
    ✓ 2 - 1 should equal 1

 Test Files  2 passed (2)
      Tests  4 passed (4)
   Start at  12:34:32
   Duration  1.26s (transform 35ms, setup 1ms, collect 90ms, tests 1.47s, environment 0ms, prepare 267ms)
```

### Dot-Reporter

Gibt für jeden abgeschlossenen Test einen einzelnen Punkt aus, um eine minimale Ausgabe zu liefern und dennoch alle gelaufenen Tests zu zeigen. Details gibt es nur für fehlgeschlagene Tests, zusammen mit der Zusammenfassung der Suite.

:::code-group
```bash [CLI]
npx vitest --reporter=dot
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['dot']
  },
})
```
:::

Beispielhafte Terminalausgabe für eine erfolgreiche Test-Suite:

```bash
....

 Test Files  2 passed (2)
      Tests  4 passed (4)
   Start at  12:34:32
   Duration  1.26s (transform 35ms, setup 1ms, collect 90ms, tests 1.47s, environment 0ms, prepare 267ms)
```

### JUnit-Reporter

Gibt einen Report der Testergebnisse im JUnit-XML-Format aus. Standardmäßig wird er nach `.vitest/junit/output.xml` geschrieben. Um ihn woanders abzulegen, verwenden Sie die Konfigurationsoption [`outputFile`](/config/outputfile) oder die eigene Option `outputFile` des Reporters. Um ihn stattdessen im Terminal auszugeben, setzen Sie die Option [`stdout`](#reporter-output) des Reporters.

:::code-group
```bash [CLI]
npx vitest --reporter=junit
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['junit']
  },
})
```
:::

Beispiel eines JUnit-XML-Reports:
```xml
<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="1" errors="0" time="0.503">
    <testsuite name="__tests__/test-file-1.test.ts" timestamp="2023-10-19T17:41:58.580Z" hostname="My-Computer.local" tests="2" failures="1" errors="0" skipped="0" time="0.013">
        <testcase classname="__tests__/test-file-1.test.ts" name="first test file &gt; 2 + 2 should equal 4" time="0.01">
            <failure message="expected 5 to be 4 // Object.is equality" type="AssertionError">
AssertionError: expected 5 to be 4 // Object.is equality
 ❯ __tests__/test-file-1.test.ts:20:28
            </failure>
        </testcase>
        <testcase classname="__tests__/test-file-1.test.ts" name="first test file &gt; 4 - 2 should equal 2" time="0">
        </testcase>
    </testsuite>
</testsuites>
```

Das ausgegebene XML enthält verschachtelte Tags `testsuites` → `testsuite` → `testcase`. Sie können das Verhalten des Reporters mit den folgenden Optionen anpassen:

| Option | Beschreibung | Standard |
|---|---|---|
| `suiteName` | Attribut `name` von `<testsuites>` | `"vitest tests"` |
| `suiteNameTemplate` | Template für das Attribut `name` von `<testsuite>`. Akzeptiert eine Zeichenkette mit Platzhaltern oder eine Funktion. | Relativer Dateipfad |
| `classnameTemplate` | Template für das Attribut `classname` von `<testcase>`. Akzeptiert eine Zeichenkette mit Platzhaltern oder eine Funktion. | Relativer Dateipfad |
| `titleTemplate` | Template für das Attribut `name` von `<testcase>`. Akzeptiert eine Zeichenkette mit Platzhaltern oder eine Funktion. | Vollständiger Testtitel mit Eltern-Hierarchie |
| `ancestorSeparator` | Trennzeichen beim Zusammenfügen der Namen übergeordneter describe-Blöcke im Platzhalter `{classname}` und im standardmäßigen Testtitel. | `" > "` |
| `addFileAttribute` | Fügt jedem `<testcase>` ein Attribut `file` hinzu. | `false` |
| `includeConsoleOutput` | Bindet die Konsolenausgabe `<system-out>` / `<system-err>` ein. | `true` |
| `stackTrace` | Bindet Stacktraces in `<failure>`-Elemente ein. | `true` |

Für `suiteNameTemplate` stehen die folgenden Platzhalter zur Verfügung:
- `{title}` – Name des ersten `describe`-Blocks auf oberster Ebene; fällt auf den Dateinamen zurück, wenn es keinen `describe` auf oberster Ebene gibt
- `{filename}` – relativer Dateipfad ab dem Root (z. B. `src/foo.test.ts`)
- `{filepath}` – absoluter Dateipfad
- `{basename}` – Dateiname ohne Verzeichnis (z. B. `foo.test.ts`)
- `{displayName}` – Name des Vitest-Projekts

Für `classnameTemplate` und `titleTemplate` stehen die folgenden Platzhalter zur Verfügung:
- `{classname}` – Namen der übergeordneten `describe`-Blöcke, verbunden durch `ancestorSeparator` (z. B. `outer > inner`)
- `{title}` – Titel des Blatt-Tests (die an `it`/`test` übergebene Zeichenkette)
- `{suitename}` – Name des `describe`-Blocks auf oberster Ebene, leere Zeichenkette, wenn der Test in keinem `describe` liegt
- `{filename}` – relativer Dateipfad ab dem Root
- `{filepath}` – absoluter Dateipfad
- `{basename}` – Dateiname ohne Verzeichnis
- `{displayName}` – Name des Vitest-Projekts

::: tip
`{filename}` folgt der Konvention von Vitest und löst zum **relativen Pfad** ab dem Projekt-Root auf (z. B. `src/foo.test.ts`). Das unterscheidet sich von jest-junit, wo `{filename}` der bloße Dateiname ist. Verwenden Sie `{basename}`, um nur den Dateinamen zu erhalten.
:::

```ts
export default defineConfig({
  test: {
    reporters: [
      ['junit', {
        suiteName: 'My Test Suite',
        // Use the first top-level describe block name as the testsuite name
        suiteNameTemplate: '{title}',
        // classname = ancestor describe chain
        classnameTemplate: '{classname}',
        // name = leaf test title only (jest-junit-compatible)
        titleTemplate: '{title}',
        ancestorSeparator: ' > ',
      }]
    ]
  },
})
```

Funktionsbasierte Templates erhalten alle verfügbaren Variablen und können eine beliebige Zeichenkette zurückgeben:

```ts
export default defineConfig({
  test: {
    reporters: [
      ['junit', {
        classnameTemplate: ({ classname, filename }) =>
          classname ? `${filename}::${classname}` : filename,
        titleTemplate: ({ suitename, title }) =>
          suitename ? `[${suitename}] ${title}` : title,
      }]
    ]
  },
})
```

### JSON-Reporter

Erzeugt einen Report der Testergebnisse in einem JSON-Format, das mit Jests Option `--json` kompatibel ist. Standardmäßig wird er nach `.vitest/json/output.json` geschrieben. Um ihn woanders abzulegen, verwenden Sie die Konfigurationsoption [`outputFile`](/config/outputfile) oder die eigene Option `outputFile` des Reporters. Um ihn stattdessen im Terminal auszugeben, setzen Sie die Option [`stdout`](#reporter-output) des Reporters.

:::code-group
```bash [CLI]
npx vitest --reporter=json
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['json']
  },
})
```
:::

Beispiel eines JSON-Reports:

```json
{
  "numTotalTestSuites": 4,
  "numPassedTestSuites": 2,
  "numFailedTestSuites": 1,
  "numPendingTestSuites": 1,
  "numTotalTests": 4,
  "numPassedTests": 1,
  "numFailedTests": 1,
  "numPendingTests": 1,
  "numTodoTests": 1,
  "startTime": 1697737019307,
  "success": false,
  "testResults": [
    {
      "assertionResults": [
        {
          "ancestorTitles": [
            "",
            "first test file"
          ],
          "fullName": " first test file 2 + 2 should equal 4",
          "status": "failed",
          "title": "2 + 2 should equal 4",
          "duration": 9,
          "failureMessages": [
            "expected 5 to be 4 // Object.is equality"
          ],
          "location": {
            "line": 20,
            "column": 28
          },
          "meta": {}
        }
      ],
      "startTime": 1697737019787,
      "endTime": 1697737019797,
      "status": "failed",
      "message": "",
      "name": "/root-directory/__tests__/test-file-1.test.ts"
    }
  ],
  "coverageMap": {}
}
```

::: info
Seit Vitest 3 enthält der JSON-Reporter Coverage-Informationen in `coverageMap`, sofern Coverage aktiviert ist.
:::

Das Feld `meta` in jedem Assertion-Ergebnis lässt sich über die Reporter-Option `filterMeta` filtern. Sie erhält Schlüssel und Wert jedes Felds und sollte einen falsy Wert zurückgeben, um das Feld aus dem Report auszuschließen:

```ts
export default defineConfig({
  test: {
    reporters: [
      ['json', {
        filterMeta: (key, value) => key !== 'internalField',
      }]
    ]
  },
})
```

### HTML-Reporter

Erzeugt eine HTML-Datei, um Testergebnisse über eine interaktive [GUI](/guide/ui) anzusehen. Nachdem die Datei erzeugt wurde, hält Vitest einen lokalen Entwicklungsserver am Laufen und stellt einen Link bereit, um den Report im Browser anzusehen.

Das Wurzelverzeichnis des Report-Artefakts lässt sich über die Reporter-Option `outputDir` angeben. Der Einstiegspunkt des Reports wird nach `<outputDir>/index.html` geschrieben, und die UI-Asset-Dateien liegen unter `<outputDir>/ui/`. Standardmäßig ist `outputDir` gleich `.vitest`, dem gemeinsamen Artefaktverzeichnis von Vitest, sodass Attachments (`.vitest/attachments`) und Coverage (`.vitest/coverage`) wiederverwendet und nicht kopiert werden.

:::code-group
```bash [CLI]
npx vitest --reporter=html
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['html']
  },
})
```
:::

Setzen Sie `singleFile`, um einen in sich geschlossenen HTML-Report zu erzeugen:

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: [
      ['html', { singleFile: true }],
    ],
  },
})
```

Ist `singleFile` aktiviert, bettet Vitest die UI-Assets, Metadaten und Test-Attachments inline in eine einzige, in sich geschlossene `index.html` ein. Dadurch lässt sich der Report leicht teilen, hochladen oder als ein einzelnes Artefakt herunterladen, statt das gesamte `html`-Ausgabeverzeichnis zu erhalten.

::: warning
`singleFile` hat zwei Einschränkungen:

- Die Datei kann sehr groß werden, weil alles inline eingebettet ist – langsam zu öffnen, speicherhungrig und möglicherweise über den Größenbeschränkungen von Artefakt-Viewern oder statischen Hosts.
- HTML-Coverage-Reports werden noch nicht inline eingebettet und bleiben separate Dateien.

Bevorzugen Sie den standardmäßigen Report aus mehreren Dateien, wenn die Suite viele oder große Attachments hat oder wenn Sie Coverage im Bundle benötigen.
:::

::: tip
Dieser Reporter erfordert das installierte Paket [`@vitest/ui`](/guide/ui).
:::

### TAP-Reporter

Gibt einen Report gemäß dem [Test Anything Protocol](https://testanything.org/) (TAP) aus.

:::code-group
```bash [CLI]
npx vitest --reporter=tap
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['tap']
  },
})
```
:::

Beispiel eines TAP-Reports:
```bash
TAP version 13
1..1
not ok 1 - __tests__/test-file-1.test.ts # time=14.00ms {
    1..1
    not ok 1 - first test file # time=13.00ms {
        1..2
        not ok 1 - 2 + 2 should equal 4 # time=11.00ms
            ---
            error:
                name: "AssertionError"
                message: "expected 5 to be 4 // Object.is equality"
            at: "/root-directory/__tests__/test-file-1.test.ts:20:28"
            actual: "5"
            expected: "4"
            ...
        ok 2 - 4 - 2 should equal 2 # time=1.00ms
    }
}
```

### TAP-Flat-Reporter

Gibt einen flachen TAP-Report aus. Wie beim Reporter `tap` werden die Testergebnisse nach TAP-Standards formatiert, die Test-Suites werden jedoch als flache Liste statt als verschachtelte Hierarchie dargestellt.

:::code-group
```bash [CLI]
npx vitest --reporter=tap-flat
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['tap-flat']
  },
})
```
:::

Beispiel eines flachen TAP-Reports:
```bash
TAP version 13
1..2
not ok 1 - __tests__/test-file-1.test.ts > first test file > 2 + 2 should equal 4 # time=11.00ms
    ---
    error:
        name: "AssertionError"
        message: "expected 5 to be 4 // Object.is equality"
    at: "/root-directory/__tests__/test-file-1.test.ts:20:28"
    actual: "5"
    expected: "4"
    ...
ok 2 - __tests__/test-file-1.test.ts > first test file > 4 - 2 should equal 2 # time=0.00ms
```

### Hanging-Process-Reporter

Zeigt eine Liste hängender Prozesse an, sofern welche Vitest daran hindern, sicher zu beenden. Der Reporter `hanging-process` zeigt selbst keine Testergebnisse an, kann aber zusammen mit einem anderen Reporter verwendet werden, um Prozesse während des Testlaufs zu beobachten. Dieser Reporter kann ressourcenintensiv sein und sollte daher im Allgemeinen Debugging-Zwecken vorbehalten bleiben, wenn Vitest den Prozess dauerhaft nicht beenden kann.

:::code-group
```bash [CLI]
npx vitest --reporter=hanging-process
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['hanging-process']
  },
})
```
:::

### GitHub-Actions-Reporter {#github-actions-reporter}

Gibt [Workflow-Befehle](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#setting-an-error-message) aus,
um Annotationen für fehlgeschlagene Tests bereitzustellen. Dieser Reporter wird [automatisch aktiviert](#default-configuration), wenn `process.env.GITHUB_ACTIONS === 'true'` (in der GitHub-Actions-Umgebung).

<img alt="GitHub Actions" img-dark src="https://github.com/vitest-dev/vitest/assets/4232207/336cddc2-df6b-4b8a-8e72-4d00010e37f5">
<img alt="GitHub Actions" img-light src="https://github.com/vitest-dev/vitest/assets/4232207/ce8447c1-0eab-4fe1-abef-d0d322290dca">

Sie können die Dateipfade, die im [Annotationsbefehlsformat von GitHub](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions) ausgegeben werden, über die Option `onWritePath` anpassen. Das ist nützlich, wenn Sie Vitest in einer Container-Umgebung wie Docker ausführen, in der die Dateipfade nicht den Pfaden in der GitHub-Actions-Umgebung entsprechen.

```ts
export default defineConfig({
  test: {
    reporters: process.env.GITHUB_ACTIONS === 'true'
      ? [
          'default',
          ['github-actions', { onWritePath(path) {
            return path.replace(/^\/app\//, `${process.env.GITHUB_WORKSPACE}/`)
          } }],
        ]
      : ['default'],
  },
})
```

Wenn Sie die [Annotations-API](/guide/test-annotations) verwenden, bindet der Reporter sie automatisch in der GitHub-UI ein. Sie können das deaktivieren, indem Sie die Option `displayAnnotations` auf `false` setzen:

```ts
export default defineConfig({
  test: {
    reporters: [
      ['github-actions', { displayAnnotations: false }],
    ],
  },
})
```

Der GitHub-Actions-Reporter erzeugt automatisch eine [Job Summary](https://github.blog/news-insights/product-news/supercharging-github-actions-with-job-summaries/) mit einem Überblick über Ihre Testergebnisse. Die Zusammenfassung enthält Statistiken zu Testdateien und Testfällen und hebt flakige Tests hervor, die Wiederholungen benötigt haben.

<img alt="GitHub Actions Job Summary" img-dark src="/github-actions-job-summary-dark.png">
<img alt="GitHub Actions Job Summary" img-light src="/github-actions-job-summary-light.png">

Die Job Summary ist standardmäßig aktiviert und wird an den Pfad geschrieben, der durch `$GITHUB_STEP_SUMMARY` angegeben ist. Sie können das über die Option `jobSummary.outputPath` überschreiben:

```ts
export default defineConfig({
  test: {
    reporters: [
      ['github-actions', {
        jobSummary: {
          outputPath: '/home/runner/jobs/summary/step',
        },
      }],
    ],
  },
})
```

Um die Job Summary zu deaktivieren:

```ts
export default defineConfig({
  test: {
    reporters: [
      ['github-actions', { jobSummary: { enabled: false } }],
    ],
  },
})
```

Der Abschnitt zu flakigen Tests in der Zusammenfassung enthält Permalink-URLs, die Testnamen direkt mit den entsprechenden Quellzeilen auf GitHub verknüpfen. Diese Links werden automatisch anhand von Umgebungsvariablen erzeugt, die GitHub Actions bereitstellt (`$GITHUB_REPOSITORY`, `$GITHUB_SHA` und `$GITHUB_WORKSPACE`), sodass in den meisten Fällen keine Konfiguration nötig ist.

Wenn Sie diese Werte überschreiben müssen – etwa beim Betrieb in einem Container oder einer eigenen Umgebung –, können Sie sie über die Option `fileLinks` anpassen:

- `repository`: das GitHub-Repository im Format `owner/repo`. Standard ist `process.env.GITHUB_REPOSITORY`.
- `commitHash`: der Commit-SHA, der in Permalink-URLs verwendet wird. Standard ist `process.env.GITHUB_SHA`.
- `workspacePath`: der absolute Pfad zum Wurzelverzeichnis des Repositorys auf der Festplatte. Wird verwendet, um relative Dateipfade für die Permalink-URLs zu berechnen. Standard ist `process.env.GITHUB_WORKSPACE`.

Alle drei Werte müssen verfügbar sein, damit die Links erzeugt werden.

```ts
export default defineConfig({
  test: {
    reporters: [
      ['github-actions', {
        jobSummary: {
          fileLinks: {
            repository: 'owner/repo',
            commitHash: 'abcdefg',
            workspacePath: '/home/runner/work/repo/',
          },
        },
      }],
    ],
  },
})
```

### Minimal-Reporter

- **Alias:** `agent`

Gibt einen minimalen Report aus, der nur fehlgeschlagene Tests und deren Fehlermeldungen enthält. Konsolenausgaben erfolgreicher Tests und der Zusammenfassungsabschnitt werden ebenfalls unterdrückt.

::: tip Agent-Reporter
Dieser Reporter ist gut für KI-Coding-Assistenten und LLM-basierte Workflows optimiert, um den Tokenverbrauch zu senken. Er wird [automatisch aktiviert](#default-configuration), wenn Vitest erkennt, dass es innerhalb eines KI-Coding-Agents läuft.

:::code-group
```bash [CLI]
npx vitest --reporter=minimal
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['minimal']
  },
})
```
:::

### Blob-Reporter

Speichert Testergebnisse auf der Maschine, sodass sie später über den Befehl [`--merge-reports`](/guide/cli#merge-reports) zusammengeführt werden können.
Standardmäßig werden alle Ergebnisse im Ordner `.vitest/blob/` abgelegt, was sich aber über die Flags `--outputFile` oder `--outputFile.blob` überschreiben lässt.

```bash
npx vitest --reporter=blob --outputFile=reports/blob-1.json
```

Wir empfehlen diesen Reporter, wenn Sie Vitest auf verschiedenen Maschinen mit dem Flag [`--shard`](/guide/cli#shard) oder über mehrere Umgebungen hinweg ausführen (z. B. linux/macos/windows). Alle Blob-Reports lassen sich am Ende Ihrer CI-Pipeline über den Befehl `--merge-reports` zu einem beliebigen Report zusammenführen:

```bash
npx vitest --merge-reports=reports --reporter=json --reporter=default
```

Wenn Sie dieselben Tests in mehreren Umgebungen ausführen, verwenden Sie die Umgebungsvariable `VITEST_BLOB_LABEL`, um den Blob jeder Umgebung zu unterscheiden. Vitest liest die Labels beim Zusammenführen und zeigt die Ergebnisse getrennt an:

```bash
VITEST_BLOB_LABEL=linux vitest run --reporter=blob
```

Sie können das Label auch über die Option des Blob-Reporters angeben. Sie hat höhere Priorität als `VITEST_BLOB_LABEL`.

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: [
      ['blob', { label: 'linux' }],
    ],
  },
})
```

Die Ausgabe des Blob-Reporters enthält keine dateibasierten [Attachments](/api/advanced/artifacts.html#testattachment).
Achten Sie darauf, [`attachmentsDir`](/config/attachmentsdir) in der CI separat neben den Blob-Reports zusammenzuführen, wenn Sie dieses Feature nutzen.

::: tip
Sowohl `--reporter=blob` als auch `--merge-reports` funktionieren im Watch-Modus nicht.
:::

## Eigene Reporter

Sie können eigene Reporter von Drittanbietern verwenden, die aus NPM installiert wurden, indem Sie ihren Paketnamen in der Option `reporters` angeben:

:::code-group
```bash [CLI]
npx vitest --reporter=some-published-vitest-reporter
```

```ts [vitest.config.ts]
export default defineConfig({
  test: {
    reporters: ['some-published-vitest-reporter']
  },
})
```
:::

Darüber hinaus können Sie eigene [Custom Reporter](/guide/advanced/reporters) definieren und sie über die Angabe ihres Dateipfads verwenden:

```bash
npx vitest --reporter=./path/to/reporter.ts
```

Eigene Reporter sollten das [Reporter-Interface](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/types/reporter.ts) implementieren.
