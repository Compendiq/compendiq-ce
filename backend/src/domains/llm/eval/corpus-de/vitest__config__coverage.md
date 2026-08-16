# coverage <CRoot /> {#coverage}

Für die Erfassung der Coverage kannst du [`v8`](/guide/coverage.html#v8-provider), [`istanbul`](/guide/coverage.html#istanbul-provider) oder [eine eigene Coverage-Lösung](/guide/coverage#custom-coverage-provider) verwenden.

Du kannst Coverage-Optionen über die Punktnotation an die CLI übergeben:

```sh
npx vitest --coverage.enabled --coverage.provider=istanbul
```

::: warning
Wenn du Coverage-Optionen mit Punktnotation verwendest, vergiss nicht, `--coverage.enabled` anzugeben. Übergib in diesem Fall keine einzelne `--coverage`-Option.
:::

## coverage.provider

- **Typ:** `'v8' | 'istanbul' | 'custom'`
- **Standard:** `'v8'`
- **CLI:** `--coverage.provider=<provider>`

Verwende `provider`, um das Werkzeug für die Coverage-Erfassung auszuwählen.

## coverage.enabled

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.enabled`, `--coverage.enabled=false`

Aktiviert die Coverage-Erfassung. Kann über die CLI-Option `--coverage` überschrieben werden.

## coverage.include

- **Typ:** `string[]`
- **Standard:** Dateien, die während des Testlaufs importiert wurden
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.include=<pattern>`, `--coverage.include=<pattern1> --coverage.include=<pattern2>`

Liste der in die Coverage einbezogenen Dateien als Glob-Patterns. Standardmäßig werden nur Dateien einbezogen, die von Tests abgedeckt sind.

Es wird empfohlen, Dateiendungen im Pattern anzugeben.

Beispiele findest du unter [Including and excluding files from coverage report](/guide/coverage.html#including-and-excluding-files-from-coverage-report).

## coverage.exclude

- **Typ:** `string[]`
- **Standard:** : `[]`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.exclude=<path>`, `--coverage.exclude=<path1> --coverage.exclude=<path2>`

Liste der aus der Coverage ausgeschlossenen Dateien als Glob-Patterns.

Beispiele findest du unter [Including and excluding files from coverage report](/guide/coverage.html#including-and-excluding-files-from-coverage-report).

## coverage.clean

- **Typ:** `boolean`
- **Standard:** `true`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.clean`, `--coverage.clean=false`

Bereinigt die Coverage-Ergebnisse, bevor die Tests ausgeführt werden.

## coverage.cleanOnRerun

- **Typ:** `boolean`
- **Standard:** `true`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.cleanOnRerun`, `--coverage.cleanOnRerun=false`

Bereinigt den Coverage-Report bei einem erneuten Lauf im Watch-Modus. Setze dies auf `false`, um die Coverage-Ergebnisse des vorherigen Laufs im Watch-Modus zu erhalten.

## coverage.reportsDirectory

- **Typ:** `string`
- **Standard:** `'./coverage'`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.reportsDirectory=<path>`

::: warning
Vitest löscht dieses Verzeichnis vor dem Ausführen der Tests, wenn `coverage.clean` aktiviert ist (Standardwert).
:::

Verzeichnis, in das der Coverage-Report geschrieben wird.

## coverage.reporter

- **Typ:** `string | string[] | [string, {}][]`
- **Standard:** `['text', 'html', 'clover', 'json']`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.reporter=<reporter>`, `--coverage.reporter=<reporter1> --coverage.reporter=<reporter2>`

Zu verwendende Coverage-Reporter. Eine ausführliche Liste aller Reporter findest du in der [Istanbul-Dokumentation](https://istanbul.js.org/docs/advanced/alternative-reporters/). Details zu reporter-spezifischen Optionen findest du in [`@types/istanbul-reports`](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/276d95e4304b3670eaf6e8e5a7ea9e265a14e338/types/istanbul-reports/index.d.ts).

Der Reporter hat drei verschiedene Ausprägungen:

- Ein einzelner Reporter: `{ reporter: 'html' }`
- Mehrere Reporter ohne Optionen: `{ reporter: ['html', 'json'] }`
- Ein oder mehrere Reporter mit Reporter-Optionen:
  <!-- eslint-skip -->
  ```ts
  {
    reporter: [
      ['lcov', { 'projectRoot': './src' }],
      ['json', { 'file': 'coverage.json' }],
      ['text']
    ]
  }
  ```

Du kannst auch eigene Coverage-Reporter übergeben. Weitere Informationen findest du unter [Guide - Custom Coverage Reporter](/guide/coverage#custom-coverage-reporter).

<!-- eslint-skip -->
```ts
  {
    reporter: [
      // Specify reporter using name of the NPM package
      '@vitest/custom-coverage-reporter',
      ['@vitest/custom-coverage-reporter', { someOption: true }],

      // Specify reporter using local path
      '/absolute/path/to/custom-reporter.cjs',
      ['/absolute/path/to/custom-reporter.cjs', { someOption: true }],
    ]
  }
```

Du kannst deinen Coverage-Report in der Vitest-UI ansehen: Weitere Details unter [Vitest UI Coverage](/guide/coverage#vitest-ui).

::: tip KI-Coding-Agenten
Wenn Vitest erkennt, dass es innerhalb eines KI-Coding-Agenten läuft, fügt es automatisch den Reporter `text-summary` hinzu und setzt `skipFull: true` beim `text`-Reporter, um die Ausgabe zu reduzieren und den Token-Verbrauch zu minimieren.
:::

## coverage.reportOnFailure {#coverage-reportonfailure}

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.reportOnFailure`, `--coverage.reportOnFailure=false`

Erzeugt einen Coverage-Report auch dann, wenn Tests fehlschlagen.

## coverage.allowExternal

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.allowExternal`, `--coverage.allowExternal=false`

Erfasst Coverage für Dateien außerhalb des [Projekt-`root`](/config/root).

## coverage.excludeAfterRemap

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.excludeAfterRemap`, `--coverage.excludeAfterRemap=false`

Wendet die Ausschlüsse erneut an, nachdem die Coverage auf die ursprünglichen Quellen zurückgemappt wurde. Das ist nützlich, wenn deine Quelldateien transpiliert sind und Source Maps von Nicht-Quelldateien enthalten können.

Verwende diese Option, wenn du Dateien im Report siehst, obwohl sie zu deinen `coverage.exclude`-Patterns passen.

## coverage.skipFull

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.skipFull`, `--coverage.skipFull=false`

Zeigt keine Dateien mit 100 % Statement-, Branch- und Function-Coverage an.

## coverage.thresholds

Optionen für Coverage-Schwellenwerte.

Wird ein Schwellenwert auf eine positive Zahl gesetzt, wird er als minimal erforderlicher Coverage-Prozentsatz interpretiert. Den lines-Schwellenwert auf `90` zu setzen bedeutet zum Beispiel, dass 90 % der Zeilen abgedeckt sein müssen.

Wird ein Schwellenwert auf eine negative Zahl gesetzt, wird er als maximal erlaubte Anzahl nicht abgedeckter Elemente behandelt. Den lines-Schwellenwert auf `-10` zu setzen bedeutet zum Beispiel, dass nicht mehr als 10 Zeilen unabgedeckt sein dürfen.

<!-- eslint-skip -->
```ts
{
  coverage: {
    thresholds: {
      // Requires 90% function coverage
      functions: 90,

      // Require that no more than 10 lines are uncovered
      lines: -10,
    }
  }
}
```

### coverage.thresholds.lines

- **Typ:** `number`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.thresholds.lines=<number>`

Globaler Schwellenwert für Zeilen.

### coverage.thresholds.functions

- **Typ:** `number`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.thresholds.functions=<number>`

Globaler Schwellenwert für Funktionen.

### coverage.thresholds.branches

- **Typ:** `number`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.thresholds.branches=<number>`

Globaler Schwellenwert für Branches.

### coverage.thresholds.statements

- **Typ:** `number`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.thresholds.statements=<number>`

Globaler Schwellenwert für Statements.

### coverage.thresholds.perFile

- **Typ:** `boolean | { 100?: boolean, lines?: number, functions?: number, branches?: number, statements?: number }`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.thresholds.perFile`, `--coverage.thresholds.perFile=false`

Bei `true` wird jede Datei gegen die Schwellenwerte der obersten Ebene geprüft statt gegen den projektweiten Gesamtwert. Wird ein Objekt angegeben, wird beides geprüft: der Gesamtwert gegen die Schwellenwerte der obersten Ebene und jede Datei gegen diese Mindestwerte pro Datei.

<!-- eslint-skip -->
```ts
{
  coverage: {
    thresholds: {
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
      perFile: {
        lines: 50,
        functions: 50,
        branches: 50,
        statements: 50,
      },
    }
  }
}
```

`{ 100: true }` wird innerhalb des Objekts ebenfalls akzeptiert, als Abkürzung dafür, alle vier Metriken auf `100` zu setzen:

<!-- eslint-skip -->
```ts
{
  coverage: {
    thresholds: {
      lines: 80,
      perFile: {
        100: true,
      },
    }
  }
}
```

`perFile` kann auch an einem einzelnen [Glob-Pattern-Schwellenwert](/config/coverage#coverage-thresholds-glob-pattern) gesetzt werden. Glob-Patterns erben das `perFile` der obersten Ebene **nicht**; setze es bei jedem Glob explizit.

<!-- eslint-skip -->
```ts
{
  coverage: {
    thresholds: {
      perFile: true,
      lines: 80,

      'src/utils/**': {
        lines: 90,
        perFile: true,
      },
    }
  }
}
```

### coverage.thresholds.autoUpdate

- **Typ:** `boolean | function`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.thresholds.autoUpdate=<boolean>`

Aktualisiert alle Schwellenwerte `lines`, `functions`, `branches` und `statements` in der Konfigurationsdatei, wenn die aktuelle Coverage besser ist als die konfigurierten Schwellenwerte. Diese Option hilft dabei, Schwellenwerte zu pflegen, wenn sich die Coverage verbessert.

Du kannst auch eine Funktion übergeben, um die aktualisierten Schwellenwerte zu formatieren. Die Funktion erhält den neuen Schwellenwert als erstes und den vorherigen Schwellenwert als zweites Argument:

<!-- eslint-skip -->
```ts
{
  coverage: {
    thresholds: {
      // Log the change and update without decimals
      autoUpdate: (newThreshold, previousThreshold) => {
        console.log(`Updated threshold from ${previousThreshold} to ${newThreshold}`)
        return Math.floor(newThreshold)
      },

      // 95.85 -> 95
      functions: 95,
    }
  }
}
```

### coverage.thresholds.100

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.thresholds.100`, `--coverage.thresholds.100=false`

Setzt die globalen Schwellenwerte auf 100. Abkürzung für `--coverage.thresholds.lines 100 --coverage.thresholds.functions 100 --coverage.thresholds.branches 100 --coverage.thresholds.statements 100`.

### coverage.thresholds[glob-pattern]

- **Typ:** `{ statements?: number, functions?: number, branches?: number, lines?: number, perFile?: boolean | object }`
- **Standard:** `undefined`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`

Setzt Schwellenwerte für Dateien, die zum Glob-Pattern passen.

Jedes Glob-Pattern kann sein eigenes `perFile` (`boolean | object`) setzen, das genauso geprüft wird wie das `perFile` der obersten Ebene, aber auf die passenden Dateien beschränkt ist. Glob-Patterns erben das `perFile` der obersten Ebene nicht – setze es pro Glob.

::: tip HINWEIS
Vitest zählt alle Dateien, auch die von Glob-Patterns abgedeckten, in die globalen Coverage-Schwellenwerte ein. Das unterscheidet sich vom Verhalten von Jest.
:::

<!-- eslint-skip -->
```ts
{
  coverage: {
    thresholds: {
      // Thresholds for all files
      functions: 95,
      branches: 70,

      // Thresholds for matching glob pattern
      'src/utils/**.ts': {
        statements: 95,
        functions: 90,
        branches: 85,
        lines: 80,
        // each matching file must individually hit the thresholds above
        perFile: true,
      },

      // Files matching this pattern will only have lines thresholds set.
      // Global thresholds are not inherited.
      '**/math.ts': {
        lines: 100,
      }
    }
  }
}
```

### coverage.thresholds[glob-pattern].100

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`

Setzt die Schwellenwerte für Dateien, die zum Glob-Pattern passen, auf 100.

<!-- eslint-skip -->
```ts
{
  coverage: {
    thresholds: {
      // Thresholds for all files
      functions: 95,
      branches: 70,

      // Thresholds for matching glob pattern
      'src/utils/**.ts': { 100: true },
      '**/math.ts': { 100: true }
    }
  }
}
```

## coverage.ignoreClassMethods

- **Typ:** `string[]`
- **Standard:** `[]`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.ignoreClassMethods=<method>`

Setze dies auf ein Array von Klassenmethodennamen, die bei der Coverage ignoriert werden sollen. Weitere Informationen findest du in der [Istanbul-Dokumentation](https://github.com/istanbuljs/nyc#ignoring-methods).

## coverage.watermarks

- **Typ:**
<!-- eslint-skip -->
```ts
{
  statements?: [number, number],
  functions?: [number, number],
  branches?: [number, number],
  lines?: [number, number]
}
```

- **Standard:**
<!-- eslint-skip -->
```ts
{
  statements: [50, 80],
  functions: [50, 80],
  branches: [50, 80],
  lines: [50, 80]
}
```

- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.watermarks.statements=50,80`, `--coverage.watermarks.branches=50,80`

Wasserzeichen für Statements, Zeilen, Branches und Funktionen. Weitere Informationen findest du in der [Istanbul-Dokumentation](https://github.com/istanbuljs/nyc#high-and-low-watermarks).

## coverage.processingConcurrency

- **Typ:** `boolean`
- **Standard:** `Math.min(20, os.availableParallelism?.() ?? os.cpus().length)`
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.processingConcurrency=<number>`

Nebenläufigkeitsgrenze, die beim Verarbeiten der Coverage-Ergebnisse verwendet wird.

## coverage.instrumenter <Version type="experimental">4.1.5</Version> {#coverage-instrumenter}

- **Typ:** `(options: InstrumenterOptions) => CoverageInstrumenter`
- **Verfügbar für Provider:** `'istanbul'`

Factory für einen eigenen Instrumenter, der anstelle des standardmäßigen `istanbul-lib-instrument` verwendet wird. Vitest ruft die Factory einmal während der Initialisierung auf und verwendet den zurückgegebenen Instrumenter für jede Datei wieder. Der Rest der Istanbul-Pipeline (Erfassung, Zusammenführung, Reporting) bleibt unverändert.

Die Factory erhält ein `InstrumenterOptions`-Objekt mit Vitests Laufzeit-Coverage-Einstellungen und muss ein Objekt zurückgeben, das das Interface `CoverageInstrumenter` implementiert. Beide Typen werden aus `vitest/node` exportiert.

<!-- eslint-skip -->
```ts
interface InstrumenterOptions {
  coverageVariable: string
  coverageGlobalScope: string
  coverageGlobalScopeFunc: boolean
  ignoreClassMethods: string[]
}

interface CoverageInstrumenter {
  instrumentSync: (code: string, filename: string, inputSourceMap?: any) => string
  lastSourceMap: () => any
  lastFileCoverage: () => any
}
```

<!-- eslint-skip -->
```ts
import { defineConfig } from 'vitest/config'
import { createInstrumenter } from '@vitest/some-custom-instrumenter'

export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      instrumenter: options => createInstrumenter(options),
    }
  }
})
```

## coverage.customProviderModule

- **Typ:** `string`
- **Verfügbar für Provider:** `'custom'`
- **CLI:** `--coverage.customProviderModule=<path or module name>`

Gibt den Modulnamen oder Pfad für das Modul des eigenen Coverage-Providers an. Weitere Informationen findest du unter [Guide - Custom Coverage Provider](/guide/coverage#custom-coverage-provider).

## coverage.htmlDir

- **Typ:** `string`
- **Standard:** Wird automatisch aus den Coverage-Reportern `html`, `html-spa` oder `lcov` abgeleitet
- **CLI:** `--coverage.htmlDir=<path>`

Verzeichnis der HTML-Coverage-Ausgabe, die in der [Vitest-UI](/guide/ui) und im [HTML-Reporter](/guide/reporters.html#html-reporter) ausgeliefert wird.

Dies wird automatisch konfiguriert, wenn eingebaute Coverage-Reporter verwendet werden, die HTML-Ausgabe erzeugen (`html`, `html-spa` und `lcov`). Verwende diese Option, um bei eigenen Coverage-Reportern einen abweichenden Ort für das Coverage-Reporting zu setzen.

Beachte, dass diese Option nicht ändert, wo der HTML-Coverage-Report erzeugt wird. Konfiguriere stattdessen die Option `coverage.reporter`, um das Verzeichnis zu ändern.

## coverage.changed

- **Typ:** `boolean | string`
- **Standard:** `false` (erbt von `test.changed`)
- **Verfügbar für Provider:** `'v8' | 'istanbul'`
- **CLI:** `--coverage.changed`, `--coverage.changed=<commit/branch>`

Erfasst Coverage nur für Dateien, die seit einem bestimmten Commit oder Branch geändert wurden. Auf `true` gesetzt werden gestagte und nicht gestagte Änderungen verwendet.

## coverage.autoAttachSubprocess <Version>5.0.0</Version> {#coverage-autoattachsubprocess}

- **Typ:** `boolean`
- **Standard:** `false`
- **Verfügbar für Provider:** `'v8'`
- **CLI:** `--coverage.autoAttachSubprocess`

Verfolgt die Coverage der während des Testlaufs gestarteten `node:child_process` und `node:worker_threads`.

Beachte, dass diese Option mit einem gewissen Performance-Overhead einhergeht, da sie intern [`NODE_V8_COVERAGE`](https://nodejs.org/api/cli.html#node-v8-coveragedir) verwendet. Das veranlasst Node, viele unnötige Dateien im Dateisystem zu schreiben.
