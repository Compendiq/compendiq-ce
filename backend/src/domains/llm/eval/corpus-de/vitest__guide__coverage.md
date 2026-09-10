# Coverage

Vitest unterstützt native Code-Coverage über [`v8`](https://v8.dev/blog/javascript-code-coverage) sowie instrumentierte Code-Coverage über [`istanbul`](https://istanbul.js.org/).

## Coverage-Provider

Sowohl die `v8`- als auch die `istanbul`-Unterstützung sind optional. Standardmäßig wird `v8` verwendet.

Sie wählen das Coverage-Werkzeug aus, indem Sie `test.coverage.provider` auf `v8` oder `istanbul` setzen:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8' // or 'istanbul'
    },
  },
})
```

Beim Start des Vitest-Prozesses werden Sie aufgefordert, das entsprechende Paket automatisch installieren zu lassen.

Oder, falls Sie sie lieber manuell installieren:

::: code-group
```bash [v8]
npm i -D @vitest/coverage-v8
```
```bash [istanbul]
npm i -D @vitest/coverage-istanbul
```
:::

## V8-Provider

::: info
Die folgende Beschreibung der V8-Coverage ist Vitest-spezifisch und gilt nicht für andere Test-Runner.
Seit `v3.2.0` verwendet Vitest für die V8-Coverage ein [AST-basiertes Coverage-Remapping](/blog/vitest-3-2#coverage-v8-ast-aware-remapping), das identische Coverage-Berichte wie Istanbul erzeugt.

Damit erhalten Nutzer die Geschwindigkeit der V8-Coverage bei der Genauigkeit der Istanbul-Coverage.
:::

Standardmäßig verwendet Vitest den Coverage-Provider `'v8'`.
Dieser Provider setzt eine JavaScript-Laufzeitumgebung voraus, die auf der [V8-Engine](https://v8.dev/) aufsetzt, etwa Node.js, Deno oder Chromium-basierte Browser wie Google Chrome.

Die Erfassung der Coverage erfolgt zur Laufzeit, indem V8 über [`node:inspector`](https://nodejs.org/api/inspector.html) bzw. im Browser über das [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/) angewiesen wird. Die Quelldateien des Nutzers können unverändert ausgeführt werden, ohne vorherige Instrumentierungsschritte.

- ✅ Empfohlene Option
- ✅ Kein Vorab-Transpilierschritt. Testdateien können unverändert ausgeführt werden.
- ✅ Schnellere Ausführungszeiten als Istanbul.
- ✅ Geringerer Speicherverbrauch als Istanbul.
- ✅ Die Genauigkeit des Coverage-Berichts ist ebenso gut wie bei Istanbul ([seit Vitest `v3.2.0`](/blog/vitest-3-2#coverage-v8-ast-aware-remapping)).
- ⚠️ In manchen Fällen kann es langsamer sein als Istanbul, etwa beim Laden vieler verschiedener Module. V8 unterstützt es nicht, die Coverage-Erfassung auf bestimmte Module zu beschränken.
- ⚠️ Es gibt einige kleinere Einschränkungen durch die V8-Engine. Siehe [`ast-v8-to-istanbul` | Limitations](https://github.com/AriPerkkio/ast-v8-to-istanbul?tab=readme-ov-file#limitations).
- ❌ Funktioniert nicht in Umgebungen, die kein V8 verwenden, etwa Firefox oder Bun. Ebenso wenig in Umgebungen, die die V8-Coverage nicht über den Profiler bereitstellen, etwa Cloudflare Workers.

<script setup>
import ArrowDown from '../.vitepress/components/ArrowDown.vue'
import Box from '../.vitepress/components/Box.vue'
</script>

<div style="display: flex; flex-direction: column; align-items: center; padding: 2rem 0; max-width: 20rem;">
  <Box>Testdatei</Box>
  <ArrowDown />
  <Box>V8-Coverage-Erfassung zur Laufzeit aktivieren</Box>
  <ArrowDown />
  <Box>Datei ausführen</Box>
  <ArrowDown />
  <Box>Coverage-Ergebnisse von V8 einsammeln</Box>
  <ArrowDown />
  <Box>Coverage-Ergebnisse auf Quelldateien zurückabbilden</Box>
  <ArrowDown />
  <Box>Coverage-Bericht</Box>
</div>

## Istanbul-Provider

Das [Istanbul-Code-Coverage-Werkzeug](https://istanbul.js.org/) existiert seit 2012 und ist bestens erprobt. Dieser Provider funktioniert in jeder JavaScript-Laufzeitumgebung, da die Coverage-Erfassung dadurch erfolgt, dass Ihr Quellcode transformiert und um Instrumentierungslogik ergänzt wird. In der Praxis sieht der Code, den Vitest am Ende ausführt, etwa so aus:

```js
// Simplified example of branch and function coverage counters
const coverage = { // [!code ++]
  branches: { 1: [0, 0] }, // [!code ++]
  functions: { 1: 0 }, // [!code ++]
} // [!code ++]

export function getUsername(id) {
  // Function coverage increased when this is invoked  // [!code ++]
  coverage.functions['1']++ // [!code ++]

  if (id == null) {
    // Branch coverage increased when this is invoked  // [!code ++]
    coverage.branches['1'][0]++ // [!code ++]

    throw new Error('User ID is required')
  }
  // Implicit else coverage increased when if-statement condition not met  // [!code ++]
  coverage.branches['1'][1]++ // [!code ++]

  return database.getUser(id)
}

globalThis.__VITEST_COVERAGE__ ||= {} // [!code ++]
globalThis.__VITEST_COVERAGE__[filename] = coverage // [!code ++]
```

- ✅ Funktioniert in jeder JavaScript-Laufzeitumgebung
- ✅ Weit verbreitet und seit über 13 Jahren erprobt.
- ✅ In manchen Fällen schneller als V8. Die Coverage-Instrumentierung lässt sich auf bestimmte Dateien beschränken, anders als bei V8, wo alle Module instrumentiert werden.
- ❌ Der Quellcode wird vor dem Ausführen transformiert, um die Instrumentierung einzufügen
- ❌ Die Ausführungsgeschwindigkeit ist wegen des Instrumentierungs-Overheads geringer als bei V8
- ❌ Der Speicherverbrauch ist höher als bei V8

<div style="display: flex; flex-direction: column; align-items: center; padding: 2rem 0; max-width: 20rem;">
  <Box>Testdatei</Box>
  <ArrowDown />
  <Box>Vorab-Instrumentierung mit Babel</Box>
  <ArrowDown />
  <Box>Datei ausführen</Box>
  <ArrowDown />
  <Box>Coverage-Ergebnisse aus dem JavaScript-Scope einsammeln</Box>
  <ArrowDown />
  <Box>Coverage-Ergebnisse auf Quelldateien zurückabbilden</Box>
  <ArrowDown />
  <Box>Coverage-Bericht</Box>
</div>

## Coverage einrichten

::: tip
Alle Coverage-Optionen sind in der [Coverage-Konfigurationsreferenz](/config/coverage) aufgeführt.
:::

Um mit aktivierter Coverage zu testen, können Sie in der CLI das Flag `--coverage` übergeben oder `coverage.enabled` in `vitest.config.ts` setzen:

::: code-group
```json [package.json]
{
  "scripts": {
    "test": "vitest",
    "coverage": "vitest run --coverage"
  }
}
```
```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      enabled: true
    },
  },
})
```
:::

## Dateien in den Coverage-Bericht aufnehmen und ausschließen

Über [`coverage.include`](/config/coverage#coverage-include) und [`coverage.exclude`](/config/coverage#coverage-exclude) legen Sie fest, welche Dateien im Coverage-Bericht erscheinen.

Standardmäßig zeigt Vitest nur Dateien, die während des Testlaufs importiert wurden.
Um nicht abgedeckte Dateien in den Bericht aufzunehmen, müssen Sie [`coverage.include`](/config/coverage#coverage-include) mit einem Muster konfigurieren, das Ihre Quelldateien erfasst:

::: code-group
```ts [vitest.config.ts] {6}
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}']
    },
  },
})
```
```sh [Covered Files]
├── src
│   ├── components
│   │   └── counter.tsx   # [!code ++]
│   ├── mock-data
│   │   ├── products.json # [!code error]
│   │   └── users.json    # [!code error]
│   └── utils
│       ├── formatters.ts # [!code ++]
│       ├── time.ts       # [!code ++]
│       └── users.ts      # [!code ++]
├── test
│   └── utils.test.ts     # [!code error]
│
├── package.json          # [!code error]
├── tsup.config.ts        # [!code error]
└── vitest.config.ts      # [!code error]
```
:::

Um Dateien auszuschließen, die auf `coverage.include` passen, können Sie zusätzlich [`coverage.exclude`](/config/coverage#coverage-exclude) definieren:

::: code-group
```ts [vitest.config.ts] {7}
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/utils/users.ts']
    },
  },
})
```
```sh [Covered Files]
├── src
│   ├── components
│   │   └── counter.tsx   # [!code ++]
│   ├── mock-data
│   │   ├── products.json # [!code error]
│   │   └── users.json    # [!code error]
│   └── utils
│       ├── formatters.ts # [!code ++]
│       ├── time.ts       # [!code ++]
│       └── users.ts      # [!code error]
├── test
│   └── utils.test.ts     # [!code error]
│
├── package.json          # [!code error]
├── tsup.config.ts        # [!code error]
└── vitest.config.ts      # [!code error]
```
:::

## Eigener Coverage-Reporter

Sie können eigene Coverage-Reporter verwenden, indem Sie in `test.coverage.reporter` entweder den Namen des Pakets oder einen absoluten Pfad übergeben:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      reporter: [
        // Specify reporter using name of the NPM package
        ['@vitest/custom-coverage-reporter', { someOption: true }],

        // Specify reporter using local path
        '/absolute/path/to/custom-reporter.cjs',
      ],
    },
  },
})
```

Eigene Reporter werden von Istanbul geladen und müssen dessen Reporter-Schnittstelle entsprechen. Zur Orientierung siehe die [Implementierung der eingebauten Reporter](https://github.com/istanbuljs/istanbuljs/tree/master/packages/istanbul-reports/lib).

```js [custom-reporter.cjs]
const { ReportBase } = require('istanbul-lib-report')

module.exports = class CustomReporter extends ReportBase {
  constructor(opts) {
    super()

    // Options passed from configuration are available here
    this.file = opts.file
  }

  onStart(root, context) {
    this.contentWriter = context.writer.writeFile(this.file)
    this.contentWriter.println('Start of custom coverage report')
  }

  onEnd() {
    this.contentWriter.println('End of custom coverage report')
    this.contentWriter.close()
  }
}
```

## Eigener Coverage-Provider

Sie können auch einen eigenen Coverage-Provider bereitstellen, indem Sie in `test.coverage.provider` den Wert `'custom'` übergeben:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'custom',
      customProviderModule: 'my-custom-coverage-provider'
    },
  },
})
```

Eigene Provider benötigen die Option `customProviderModule`, also einen Modulnamen oder Pfad, aus dem das `CoverageProviderModule` geladen wird. Es muss als Default-Export ein Objekt exportieren, das `CoverageProviderModule` implementiert:

```ts [my-custom-coverage-provider.ts]
import type {
  CoverageProvider,
  CoverageProviderModule,
  ResolvedCoverageOptions,
  Vitest
} from 'vitest'

const CustomCoverageProviderModule: CoverageProviderModule = {
  getProvider(): CoverageProvider {
    return new CustomCoverageProvider()
  },

  // Implements rest of the CoverageProviderModule ...
}

class CustomCoverageProvider implements CoverageProvider {
  name = 'custom-coverage-provider'
  options!: ResolvedCoverageOptions

  initialize(ctx: Vitest) {
    this.options = ctx.config.coverage
  }

  // Implements rest of the CoverageProvider ...
}

export default CustomCoverageProviderModule
```

Weitere Details entnehmen Sie bitte der Typdefinition.

## Code ignorieren

Beide Coverage-Provider haben eigene Wege, Code von Coverage-Berichten auszunehmen:

- [`v8`](https://github.com/AriPerkkio/ast-v8-to-istanbul?tab=readme-ov-file#ignoring-code)
- [`istanbul`](https://github.com/istanbuljs/nyc#parsing-hints-ignoring-lines)

Bei TypeScript wird der Quellcode mit `esbuild` transpiliert, das sämtliche Kommentare aus dem Quellcode entfernt ([esbuild#516](https://github.com/evanw/esbuild/issues/516)).
Kommentare, die als [Legal Comments](https://esbuild.github.io/api/#legal-comments) gelten, bleiben erhalten.

Sie können das Schlüsselwort `@preserve` in den Ignore-Hinweis aufnehmen.
Beachten Sie, dass diese Ignore-Hinweise dann auch im finalen Produktions-Build enthalten sein können.

::: tip
Verfolgen Sie https://github.com/vitest-dev/vitest/issues/2021 für Neuigkeiten zur Verwendung von `@preserve`.
:::

```diff
-/* istanbul ignore if */
+/* istanbul ignore if -- @preserve */
if (condition) {

-/* v8 ignore if */
+/* v8 ignore if -- @preserve */
if (condition) {
```

### Beispiele

::: code-group

```ts [lines: start/stop]
/* istanbul ignore start -- @preserve */
if (parameter) { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
else { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
/* istanbul ignore stop -- @preserve */

console.log('Included')

/* v8 ignore start -- @preserve */
if (parameter) { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
else { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
/* v8 ignore stop -- @preserve */

console.log('Included')
```

```ts [if else]
/* v8 ignore if -- @preserve */
if (parameter) { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
else {
  console.log('Included')
}

/* v8 ignore else -- @preserve */
if (parameter) {
  console.log('Included')
}
else { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
```

```ts [next node]
/* v8 ignore next -- @preserve */
console.log('Ignored') // [!code error]
console.log('Included')

/* v8 ignore next -- @preserve */
function ignored() { // [!code error]
  console.log('all') // [!code error]
  // [!code error]
  console.log('lines') // [!code error]
  // [!code error]
  console.log('are') // [!code error]
  // [!code error]
  console.log('ignored') // [!code error]
} // [!code error]

/* v8 ignore next -- @preserve */
class Ignored { // [!code error]
  ignored() {} // [!code error]
  alsoIgnored() {} // [!code error]
} // [!code error]

/* v8 ignore next -- @preserve */
condition // [!code error]
  ? console.log('ignored') // [!code error]
  : console.log('also ignored') // [!code error]
```

```ts [try catch]
/* v8 ignore next -- @preserve */
try { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
catch (error) { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]

try {
  console.log('Included')
}
catch (error) {
  /* v8 ignore next -- @preserve */
  console.log('Ignored') // [!code error]
  /* v8 ignore next -- @preserve */
  console.log('Ignored') // [!code error]
}

// Requires rolldown-vite due to esbuild's lack of support.
// See https://vite.dev/guide/rolldown.html#how-to-try-rolldown
try {
  console.log('Included')
}
catch (error) /* v8 ignore next */ { // [!code error]
  console.log('Ignored') // [!code error]
} // [!code error]
```

```ts [switch case]
switch (type) {
  case 1:
    return 'Included'

  /* v8 ignore next -- @preserve */
  case 2: // [!code error]
    return 'Ignored' // [!code error]

  case 3:
    return 'Included'

  /* v8 ignore next -- @preserve */
  default: // [!code error]
    return 'Ignored' // [!code error]
}
```

```ts [whole file]
/* v8 ignore file -- @preserve */
export function ignored() { // [!code error]
  return 'Whole file is ignored'// [!code error]
}// [!code error]
```
:::

## Coverage-Performance

Wenn das Erzeugen der Code-Coverage in Ihrem Projekt langsam ist, siehe [Profiling Test Performance | Code coverage](/guide/profiling-test-performance.html#code-coverage).

## Vitest UI

Sie können Ihren Coverage-Bericht in der [Vitest UI](/guide/ui) und im [HTML-Reporter](/guide/reporters.html#html-reporter) ansehen.

Das ist mit den eingebauten Coverage-Reportern mit HTML-Ausgabe integriert (den Reportern `html`, `html-spa` und `lcov`). Der `html`-Reporter ist standardmäßig aktiviert und funktioniert ohne weiteres Zutun. Für die Integration mit eigenen Reportern können Sie [`coverage.htmlDir`](/config/coverage#coverage-htmldir) konfigurieren.

<img alt="html coverage activation in Vitest UI" img-light src="/vitest-ui-show-coverage-light.png">
<img alt="html coverage activation in Vitest UI" img-dark src="/vitest-ui-show-coverage-dark.png">

<img alt="html coverage in Vitest UI" img-light src="/ui-coverage-1-light.png">
<img alt="html coverage in Vitest UI" img-dark src="/ui-coverage-1-dark.png">

## Coverage in Agenten-Umgebungen

Wenn Vitest erkennt, dass es innerhalb eines KI-Coding-Agenten läuft, passt es den standardmäßigen `text`-Reporter automatisch an, um die Ausgabe zu reduzieren und den Tokenverbrauch zu minimieren:

- Für den `text`-Reporter wird `skipFull: true` gesetzt, sodass Dateien mit 100 % Coverage in der Terminalausgabe weggelassen werden.
- Der Reporter [`text-summary`](/config/coverage#coverage-reporter) wird automatisch ergänzt, sodass der Agent stets eine kompakte Summentabelle sieht, selbst wenn `skipFull` alle einzelnen Dateien ausblendet.

Diese Anpassungen greifen nur, wenn der `text`-Reporter bereits Teil der aktiven Reporter-Liste ist (im Standard ist er enthalten). Explizit konfigurierte Reporter werden nie entfernt.
