# experimental

## experimental.openTelemetry <Version type="experimental">4.0.11</Version> {#experimental-opentelemetry}

::: tip FEEDBACK
Bitte hinterlasse Feedback zu diesem Feature in einer [GitHub Discussion](https://github.com/vitest-dev/vitest/discussions/9222).
:::

- **Typ:**

```ts
interface OpenTelemetryOptions {
  enabled: boolean
  /**
   * A path to a file that exposes an OpenTelemetry SDK for Node.js.
   */
  sdkPath?: string
  /**
   * A path to a file that exposes an OpenTelemetry SDK for the browser.
   */
  browserSdkPath?: string
}
```

- **Standard:** `{ enabled: false }`

Diese Option steuert die Unterstützung für [OpenTelemetry](https://opentelemetry.io/). Vitest importiert die SDK-Datei im Haupt-Thread und vor jeder Testdatei, wenn `enabled` auf `true` gesetzt ist.

::: danger PERFORMANCE-BEDENKEN
OpenTelemetry kann die Performance von Vitest erheblich beeinträchtigen; aktiviere es nur zum lokalen Debuggen.
:::

Du kannst einen [eigenen Service](/guide/open-telemetry) zusammen mit Vitest verwenden, um genau zu bestimmen, welche Tests oder Dateien deine Test-Suite verlangsamen.

Für den Browser-Modus siehe den Abschnitt [Browser-Modus](/guide/open-telemetry#browser-mode) des OpenTelemetry-Leitfadens.

Ein `sdkPath` wird relativ zum [`root`](/config/root) des Projekts aufgelöst und sollte auf ein Modul zeigen, das eine gestartete SDK-Instanz als Default-Export bereitstellt. Zum Beispiel:

::: code-group
```js [otel.js]
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { NodeSDK } from '@opentelemetry/sdk-node'

const sdk = new NodeSDK({
  serviceName: 'vitest',
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()
export default sdk
```
```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    experimental: {
      openTelemetry: {
        enabled: true,
        sdkPath: './otel.js',
      },
    },
  },
})
```
:::

::: warning
Es ist wichtig, dass Node den Inhalt von `sdkPath` verarbeiten kann, denn er wird nicht von Vitest transformiert. Siehe [den Leitfaden](/guide/open-telemetry) dazu, wie man mit OpenTelemetry innerhalb von Vitest arbeitet.
:::

## experimental.importDurations <Version type="experimental">4.1.0</Version> {#experimental-importdurations}

::: tip FEEDBACK
Bitte hinterlasse Feedback zu diesem Feature in einer [GitHub Discussion](https://github.com/vitest-dev/vitest/discussions/9224).
:::

- **Typ:**

```ts
interface ImportDurationsOptions {
  /**
   * When to print import breakdown to CLI terminal.
   * - false: Never print (default)
   * - true: Always print
   * - 'on-warn': Print only when any import exceeds warn threshold
   */
  print?: boolean | 'on-warn'
  /**
   * Fail the test run if any import exceeds the danger threshold.
   * When enabled and threshold exceeded, breakdown is always printed.
   * @default false
   */
  failOnDanger?: boolean
  /**
   * Maximum number of imports to collect and display.
   */
  limit?: number
  /**
   * Duration thresholds in milliseconds for coloring and warnings.
   */
  thresholds?: {
    /** Threshold for yellow/warning color. @default 100 */
    warn?: number
    /** Threshold for red/danger color and failOnDanger. @default 500 */
    danger?: number
  }
}
```

- **Standard:** `{ print: false, failOnDanger: false, limit: 0, thresholds: { warn: 100, danger: 500 } }` (`limit` ist 10, wenn `print` oder die UI aktiviert ist)

Konfiguriert das Erfassen und Anzeigen von Import-Dauern.

Die Option `print` steuert die Ausgabe im CLI-Terminal. Die Option `limit` steuert, wie viele Imports erfasst und angezeigt werden. Die [Vitest-UI](/guide/ui#import-breakdown) kann die Anzeige der Aufschlüsselung unabhängig von der Einstellung `print` jederzeit umschalten.

- Self: die Zeit, die der Import des Moduls gedauert hat, ohne statische Imports;
- Total: die Zeit, die der Import des Moduls gedauert hat, inklusive statischer Imports. Beachte, dass die `transform`-Zeit des aktuellen Moduls hier nicht enthalten ist.

<img alt="An example of import breakdown in the terminal" src="/reporter-import-breakdown.png" img-dark />
<img alt="An example of import breakdown in the terminal" src="/reporter-import-breakdown-light.png" img-light />

Beachte: Ist der Dateipfad zu lang, kürzt Vitest ihn am Anfang, bis er in das Limit von 45 Zeichen passt.

### experimental.importDurations.print {#experimental-importdurationsprint}

- **Typ:** `boolean | 'on-warn'`
- **Standard:** `false`

Steuert, wann nach Abschluss der Tests die Import-Aufschlüsselung im CLI-Terminal ausgegeben wird. Das funktioniert nur mit den Reportern [`default`](/guide/reporters#default), [`verbose`](/guide/reporters#verbose) oder [`tree`](/guide/reporters#tree).

- `false`: Aufschlüsselung nie ausgeben
- `true`: Aufschlüsselung immer ausgeben
- `'on-warn'`: Nur ausgeben, wenn ein Import den Wert von `thresholds.warn` überschreitet

### experimental.importDurations.failOnDanger {#experimental-importdurationsfailondanger}

- **Typ:** `boolean`
- **Standard:** `false`

Lässt den Testlauf fehlschlagen, wenn ein Import den Wert von `thresholds.danger` überschreitet. Ist die Option aktiviert und der Schwellwert überschritten, wird die Aufschlüsselung unabhängig von der Einstellung `print` immer ausgegeben.

Das ist nützlich, um Import-Performance-Budgets in CI durchzusetzen:

```bash
vitest --experimental.importDurations.failOnDanger
```

### experimental.importDurations.limit {#experimental-importdurationslimit}

- **Typ:** `number`
- **Standard:** `0` (oder `10`, wenn `print`, `failOnDanger` oder die UI aktiviert ist)

Maximale Anzahl an Imports, die in der CLI-Ausgabe, in der [Vitest-UI](/guide/ui#import-breakdown) und in Reportern von Drittanbietern erfasst und angezeigt werden.

### experimental.importDurations.thresholds {#experimental-importdurationsthresholds}

- **Typ:** `{ warn?: number; danger?: number }`
- **Standard:** `{ warn: 100, danger: 500 }`

Schwellwerte für Dauern in Millisekunden für Einfärbung und Warnungen:

- `warn`: Schwellwert für die gelbe Warnfarbe (Standard: 100 ms)
- `danger`: Schwellwert für die rote Gefahrenfarbe und `failOnDanger` (Standard: 500 ms)

::: info
Die [Vitest-UI](/guide/ui#import-breakdown) zeigt automatisch eine Aufschlüsselung der Imports an, wenn mindestens eine Datei länger als der `danger`-Schwellwert zum Laden gebraucht hat.
:::

## experimental.viteModuleRunner <Version type="experimental">4.1.0</Version> {#experimental-vitemodulerunner}

::: tip FEEDBACK
Bitte hinterlasse Feedback zu diesem Feature in einer [GitHub Discussion](https://github.com/vitest-dev/vitest/discussions/9501).
:::

- **Typ:** `boolean`
- **Standard:** `true`

Steuert, ob Vitest den [Module Runner](https://vite.dev/guide/api-environment-runtimes#modulerunner) von Vite zum Ausführen des Codes verwendet oder auf das native `import` zurückfällt.

Ist diese Option in der Root-Konfiguration definiert, erben sie alle [Projekte](/guide/projects) automatisch.

Erwäge, den Module Runner zu deaktivieren, wenn du Tests in derselben Umgebung wie deinen Code ausführst (etwa Server-Backend oder einfache Skripte). Wir empfehlen jedoch weiterhin, `jsdom`/`happy-dom`-Tests mit dem Module Runner von Vite oder [im Browser](/guide/browser/) auszuführen, da das keine zusätzliche Konfiguration erfordert.

Das Deaktivieren dieses Flags deaktiviert _sämtliche_ Datei-Transformationen:

- Testdateien und dein Quellcode werden nicht von Vite verarbeitet
- deine globalen Setup-Dateien werden nicht verarbeitet
- deine eigenen Runner-/Pool-/Environment-Dateien werden nicht verarbeitet
- deine Konfigurationsdatei wird weiterhin von Vite verarbeitet (das geschieht, bevor Vitest das Flag `viteModuleRunner` kennt)

::: warning
Derzeit benötigt Vitest Vite weiterhin für bestimmte Funktionalität wie den Modulgraphen oder den Watch-Modus.

Beachte außerdem, dass diese Option nur mit den [Pools](/config/pool) `forks` oder `threads` funktioniert.
:::

### Module Runner

Standardmäßig führt Vitest Tests in einer sehr permissiven Module-Runner-Sandbox aus, die von Vites [Environment API](https://vite.dev/guide/api-environment.html#environment-api) angetrieben wird. Jede Datei wird entweder als "inline"-Modul oder als "external"-Modul kategorisiert.

Der Module Runner führt alle "inlined" Module aus. Er stellt `import.meta.env`, `require`, `__dirname`, `__filename` und statisches `import` bereit und hat einen eigenen Mechanismus zur Modulauflösung. Das macht es sehr einfach, Code auszuführen, wenn du die Umgebung nicht konfigurieren willst und nur testen musst, ob die blanke JavaScript-Logik, die du geschrieben hast, wie beabsichtigt funktioniert.

Alle "external"-Module laufen im nativen Modus, das heißt, sie werden außerhalb der Module-Runner-Sandbox ausgeführt. Wenn du Tests in Node.js ausführst, werden diese Dateien mit dem nativen Schlüsselwort `import` importiert und direkt von Node.js verarbeitet.

Während es gerechtfertigt sein mag, JSDOM-/happy-dom-Tests in einer permissiven Fake-Umgebung auszuführen, kann das Ausführen von Node.js-Tests in einer Nicht-Node.js-Umgebung potenzielle Fehler verbergen und verschweigen, die dir in der Produktion begegnen könnten — insbesondere, wenn dein Code keine zusätzlichen Transformationen durch Vite-Plugins benötigt.

### Bekannte Einschränkungen

Einige Features von Vitest setzen voraus, dass Dateien transformiert werden. Vitest verwendet die synchrone [Node.js Loaders API](https://nodejs.org/api/module.html#customization-hooks), um Testdateien und Setup-Dateien zu transformieren und diese Features zu unterstützen:

- [`import.meta.vitest`](/guide/in-source)
- [`vi.mock`](/api/vi#vi-mock)
- [`vi.hoisted`](/api/vi#vi-hoisted)

::: warning
Das bedeutet, dass Vitest mindestens Node 22.15 benötigt, damit diese Features funktionieren. Derzeit funktionieren sie außerdem nicht in Deno oder Bun.

Vitest erkennt `vi.mock` und `vi.hoisted` nur innerhalb von Testdateien; in importierten Modulen werden sie nicht nach oben gehoben.
:::

Das kann die Performance beeinflussen, weil Vitest die Datei lesen und verarbeiten muss. Wenn du diese Features nicht verwendest, kannst du die Transformationen deaktivieren, indem du `experimental.nodeLoader` auf `false` setzt. Vitest liest bei der Suche nach `vi.mock` oder `vi.hoisted` nur Testdateien und Setup-Dateien. Diese in anderen Dateien zu verwenden, hebt sie nicht an den Anfang der Datei und kann zu unerwartetem Verhalten führen.

Manche Features funktionieren aufgrund der Natur von `viteModuleRunner` nicht, darunter:

- kein `import.meta.env`: `import.meta.env` ist ein Vite-Feature, verwende stattdessen `process.env`
- keine `plugins`: Plugins werden nicht angewendet, da es keine Transformationsphase gibt; verwende stattdessen [Customization Hooks](https://nodejs.org/api/module.html#customization-hooks) über [`execArgv`](/config/execargv)
- kein `alias`: Aliasse werden nicht angewendet, da es keine Transformationsphase gibt
- der Coverage-Provider `istanbul` funktioniert nicht, da es keine Transformationsphase gibt; verwende stattdessen `v8`
- `vi.resetModules()`: Es gibt keine API, um ES-Module aus dem Modul-Cache zu invalidieren

::: warning Coverage-Unterstützung
Derzeit unterstützt Vitest Coverage über den `v8`-Provider, solange Dateien in JavaScript transformiert werden können. Um TypeScript zu transformieren, verwendet Vitest [`module.stripTypeScriptTypes`](https://nodejs.org/api/module.html#modulestriptypescripttypescode-options), das in Node.js seit v22.13 verfügbar ist. Wenn du einen eigenen [Module Loader](https://nodejs.org/api/module.html#customization-hooks) verwendest, kann Vitest ihn nicht wiederverwenden, um Dateien für die Analyse zu transformieren.
:::

Was das Mocking betrifft, ist außerdem wichtig darauf hinzuweisen, dass ES-Module das Überschreiben von Eigenschaften nicht unterstützen. Das bedeutet, dass Code wie dieser nicht mehr funktioniert:

```ts
import * as fs from 'node:fs'
import { vi } from 'vitest'

vi.spyOn(fs, 'readFileSync').mockImplementation(() => '42') // ❌
```

Vitest unterstützt jedoch automatisches Ausspähen von Modulen, ohne deren Implementierung zu überschreiben. Wird `vi.mock` mit dem Argument `spy: true` aufgerufen, wird das Modul so gemockt, dass die ursprünglichen Implementierungen erhalten bleiben, aber alle exportierten Funktionen in einen `vi.fn()`-Spy eingehüllt werden:

```ts
import * as fs from 'node:fs'
import { vi } from 'vitest'

vi.mock('node:fs', { spy: true })

fs.readFileSync.mockImplementation(() => '42') // ✅
```

Factory-Mocking ist mit einem Top-Level-await implementiert. Das bedeutet, dass gemockte Module in deinem Quellcode nicht mit `require()` geladen werden können:

```ts
vi.mock('node:fs', async (importOriginal) => {
  return {
    ...await importOriginal(),
    readFileSync: vi.fn(),
  }
})

const fs = require('node:fs') // throws an error
```

Diese Einschränkung existiert, weil Factories asynchron sein können. Das sollte kein Problem sein, da Vitest eingebaute Module innerhalb von `node_modules` nicht mockt, was dem Standardverhalten von Vitest entspricht.

### TypeScript

Wenn du Node.js 22.18/23.6 oder höher verwendest, wird TypeScript von Node.js [nativ transformiert](https://nodejs.org/en/learn/typescript/run-natively).

::: warning TypeScript mit Node.js 22.6-22.18
Wenn du eine Node.js-Version zwischen 22.6 und 22.18 verwendest, kannst du die native TypeScript-Unterstützung auch über das Flag `--experimental-strip-types` aktivieren:

```shell
NODE_OPTIONS="--experimental-strip-types" vitest
```

Wenn du TypeScript und eine Node.js-Version kleiner als 22.6 verwendest, musst du entweder:

- deine Testdateien und deinen Quellcode bauen und diese Dateien direkt ausführen
- einen [eigenen Loader](https://nodejs.org/api/module.html#customization-hooks) über das Flag `execArgv` importieren

```ts
import { defineConfig } from 'vitest/config'

const tsxApi = import.meta.resolve('tsx/esm/api')

export default defineConfig({
  test: {
    execArgv: [
      `--import=data:text/javascript,import * as tsx from "${tsxApi}";tsx.register()`,
    ],
    experimental: {
      viteModuleRunner: false,
    },
  },
})
```

Wenn du Tests in Deno ausführst, werden TypeScript-Dateien ohne zusätzliche Konfiguration von der Runtime verarbeitet.
:::

## experimental.vcsProvider <Version type="experimental">4.1.1</Version> {#experimental-vcsprovider}

- **Typ:** `VCSProvider | string`

```ts
interface VCSProvider {
  findChangedFiles(options: VCSProviderOptions): Promise<string[]>
}

interface VCSProviderOptions {
  root: string
  changedSince?: string | boolean
}
```

- **Standard:** `'git'`

Eigener Provider zum Erkennen geänderter Dateien. Wird zusammen mit dem Flag [`--changed`](/guide/cli#changed) verwendet, um zu bestimmen, welche Dateien geändert wurden.

Standardmäßig verwendet Vitest Git, um geänderte Dateien zu erkennen. Du kannst eine eigene Implementierung des Interface `VCSProvider` bereitstellen, um ein anderes Versionskontrollsystem zu verwenden:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    experimental: {
      vcsProvider: {
        async findChangedFiles({ root, changedSince }) {
          // return paths of changed files
          return []
        },
      },
    },
  },
})
```

Du kannst auch einen String-Pfad zu einem Modul übergeben, dessen Default-Export das Interface `VCSProvider` implementiert:

```js [vitest.config.js]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    experimental: {
      vcsProvider: './my-vcs-provider.js',
    },
  },
})
```

```js [my-vcs-provider.js]
export default {
  async findChangedFiles({ root, changedSince }) {
    // return paths of changed files
    return []
  },
}
```

## experimental.nodeLoader <Version type="experimental">4.1.0</Version> {#experimental-nodeloader}

- **Typ:** `boolean`
- **Standard:** `true`

Ist der Module Runner deaktiviert, verwendet Vitest einen nativen [Node.js-Module-Loader](https://nodejs.org/api/module.html#customization-hooks), um Dateien zu transformieren und so `import.meta.vitest`, `vi.mock` und `vi.hoisted` zu unterstützen.

Wenn du diese Features nicht verwendest, kannst du das deaktivieren, um die Performance zu verbessern.

## experimental.preParse <Version type="experimental">4.1.3</Version> {#experimental-preparse}

- **Typ:** `boolean`
- **Standard:** `false`

Parst Testspezifikationen, bevor sie ausgeführt werden. Damit werden der Modifier [`.only`](/api/test#test-only), das Testnamen-Muster [`-t`](/config/testnamepattern), [`--tags-filter`](/guide/test-tags#syntax), [Testzeilen](/api/advanced/test-specification#testlines) und [Test-IDs](/api/advanced/test-specification#testids) über alle Dateien hinweg angewendet, ohne sie auszuführen. Ist zum Beispiel nur ein einzelner Test mit `.only` markiert, überspringt Vitest alle anderen Tests in allen Dateien.

::: tip
Diese Option empfiehlt sich, wenn du [`.only`](/api/test#test-only), das Flag [`-t`](/config/testnamepattern) oder [`--tags-filter`](/guide/test-tags#syntax) verwendest.

Sie bedingungslos zu aktivieren, kann deine Testläufe wegen des zusätzlichen Parse-Schritts verlangsamen.
:::

::: warning
Das Vorab-Parsen verwendet statische Analyse (AST-Parsing), statt deine Testdateien auszuführen. Das bedeutet, dass Testnamen, Tags und Modifier (`.only`, `.skip`, `.todo`) statisch analysierbar sein müssen. Dynamische Testnamen (z. B. Namen, die in Variablen gespeichert oder von Funktionsaufrufen zurückgegeben werden) und nicht-literale Tags werden nicht korrekt aufgelöst.

```ts
// ✅ works — static string literal
test('adds numbers', () => {})

// ✅ works — static tags
test('my test', { tags: ['unit'] }, () => {})

// ❌ won't match correctly — dynamic name
const name = getName()
test(name, () => {})

// ❌ won't match correctly — dynamic tags
const tags = getTags()
test('my test', { tags }, () => {})
```
:::

## experimental.diagnostics <Version type="experimental">5.0.0</Version> {#experimental-diagnostics}

- **Typ:**

```ts
interface DiagnosticsOptions {
  /**
   * Hint when `isolate: true` spends a significant amount of time spawning
   * a fresh worker (and re-creating the environment) for every test file,
   * estimating how much `isolate: false` could save.
   * @default true
   */
  isolate?: boolean
  /**
   * Hint when re-creating a DOM environment for every test file dominates
   * the run and a `vm` pool would set it up once per worker.
   * @default true
   */
  environment?: boolean
  /**
   * Hint when test files repeatedly evaluate the same module graph
   * (typical for barrel-file imports) and `isolate: false` would
   * evaluate it once per worker.
   * @default true
   */
  import?: boolean
  /**
   * Hint when transforming modules dominates the run and
   * `fsModuleCache` would persist the results across runs.
   * @default true
   */
  transform?: boolean
}
```

- **Standard:** `true`

Gibt nach dem Lauf Performance-Hinweise aus, wenn die erfassten Zeiten zeigen, dass eine Konfigurationsänderung den Lauf deutlich beschleunigen würde:

```
Environment  jsdom was created 40 times · 23.80s total, 79% of tracked time
             create it once per worker with pool: 'vmThreads' (keeps per-file isolation) or isolate: false (shares it across files)
             learn more: https://vitest.dev/guide/improving-performance#test-environments
```

Hinweise schlagen nie vor, eine Option zu ändern, die explizit gesetzt wurde: Definiert die Konfiguration `pool`, werden keine anderen Pools vorgeschlagen, und für ein explizit konfiguriertes `isolate` wird nie vorgeschlagen, es zu deaktivieren. Hinweise werden auch in CI ausgegeben. Setze die Option auf `false`, um alle Hinweise zu deaktivieren, oder deaktiviere sie einzeln.

Um die Auswirkung einer Konfigurationsänderung zu messen, statt sie zu schätzen, führe [`vitest doctor`](/guide/cli#vitest-doctor) aus.

### experimental.diagnostics.isolate {#experimental-diagnostics-isolate}

- **Typ:** `boolean`
- **Standard:** `true`

Weist darauf hin, wenn `isolate: true` erhebliche Zeit damit verbringt, für jede Testdatei einen frischen Worker zu starten (und die Umgebung neu zu erzeugen), und schätzt, wie viel `isolate: false` einsparen könnte. Wiederverwendete Worker halten außerdem ausgewertete Module am Leben, sodass Dateien den gemeinsam genutzten Modulgraphen nicht erneut auswerten. Auswertungszeiten pro Modul werden nur erfasst, wenn [`experimental.importDurations`](#experimental-importdurations) aktiviert ist; ohne das zählt die Schätzung allein die Worker-Starts und wird als untere Schranke ("at least") ausgewiesen.

### experimental.diagnostics.environment {#experimental-diagnostics-environment}

- **Typ:** `boolean`
- **Standard:** `true`

Weist darauf hin, wenn das Neuerzeugen einer DOM-Umgebung für jede Testdatei den Lauf dominiert und ein `vm`-Pool sie einmal pro Worker aufsetzen würde.

### experimental.diagnostics.import {#experimental-diagnostics-import}

- **Typ:** `boolean`
- **Standard:** `true`

Weist darauf hin, wenn Testdateien wiederholt denselben Modulgraphen auswerten und `isolate: false` ihn einmal pro Worker auswerten würde. Das ist typisch für Barrel-Datei-Imports: Jede Testdatei importiert einige wenige Symbole über eine Index-Datei und wertet den gesamten dahinterliegenden Graphen aus. Die Duplizierung wird daran gemessen, wie oft jedes Modul an die Worker ausgeliefert wurde, sodass Suites, deren Testdateien überwiegend disjunkte Module importieren, still bleiben: Das Wiederverwenden von Workern würde ihre Import-Arbeit nicht reduzieren.

```
Import  837 modules were evaluated 16740 times · 15.69s total, 64% of tracked time
        ~850ms faster with isolate: false — shared modules are evaluated once per worker instead of once per file
        learn more: https://vitest.dev/guide/improving-performance#test-isolation
```

### experimental.diagnostics.transform {#experimental-diagnostics-transform}

- **Typ:** `boolean`
- **Standard:** `true`

Weist darauf hin, wenn das Transformieren von Modulen den Lauf dominiert. Ohne persistenten Cache transformiert jedes `vitest run` den gesamten Modulgraphen von Grund auf neu; [`fsModuleCache`](/config/fsmodulecache) legt die Ergebnisse auf der Festplatte ab, sodass wiederholte Läufe sie überspringen. Der Hinweis schätzt die Zeit, die der nächste Lauf einsparen würde. In CI enthält der Hinweis zusätzlich den Vermerk, dass das Cache-Verzeichnis zwischen den Läufen erhalten bleiben muss, damit der Cache wirkt.
